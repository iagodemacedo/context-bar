import { atom, read, update } from 'claude-code'
import type {
  ContextCategory,
  EngineInterface,
  Register,
  SessionContextBreakdown,
  SessionRateLimit,
} from 'claude-code'

import type { ContextSegment, ContextSnapshot, HandoffState, UsageLimit } from '../types'

const snapshot = atom({ plugin: 'context-bar', key: 'snapshot' } as const, null)

// Display names and colors per /context row. Unknown rows still show, lowercased,
// with a fallback color, so a new category in a later build is never dropped.
const LOOKS: Record<string, { label: string; hex: string }> = {
  'System prompt': { label: 'system prompt', hex: '#6B9BD1' },
  'System tools': { label: 'tools', hex: '#5EC4C9' },
  'MCP tools': { label: 'mcp tools', hex: '#A78BFA' },
  'Custom agents': { label: 'agents', hex: '#86C06C' },
  'Memory files': { label: 'memory files', hex: '#E8C56A' },
  Skills: { label: 'skills', hex: '#F4A6C0' },
  Messages: { label: 'messages', hex: '#E0704F' },
}
const FALLBACK_HEX = ['#7FB3D5', '#C39BD3', '#F0B27A', '#76D7C4', '#F7DC6F']
const TRACK_HEX = '#8B93A6'

// Refresh cadence: events mark the snapshot stale, a 1s tick recomputes it.
// The breakdown is a local estimate ('summary'), so a forced pass every 15s is cheap.
const TICK_MS = 1000
const FORCE_EVERY_TICKS = 15

// Handoff: the button writes a handoff document with the mod's own skill
// (skills/handoff), clears the conversation, then starts the fresh one from that
// document. The run lives in module variables as well as $.state, since a
// /clear starts a new session.
const HANDOFF_COMMAND = 'context-bar:handoff'
const HANDOFF_TIMEOUT_MS = 15 * 60_000
const IDLE_HANDOFF: HandoffState = { phase: 'idle', path: null, startedAt: 0 }
const handoff = atom({ plugin: 'context-bar', key: 'handoff' } as const, IDLE_HANDOFF)
// Files a temp-dir handoff could be saved as, when the reply names another path.
const TMP_MARKDOWN = /(?:\/private)?\/(?:tmp|var\/folders)\/[^\s`'"<>()[\]]+\.md/g

let isTurnRunning = false
let turnStartedAt = 0
let lastTurn: { startedAt: number; answer: string; isOk: boolean } | null = null
let isDriving = false

let isDirty = true
let burstTicks = 0
let isFlushing = false
let lastKey = ''

type BarKind = ContextSegment['kind']
const isInWindow = (c: ContextCategory): c is ContextCategory & { kind: BarKind } =>
  c.kind !== 'deferred'

// Account-wide windows first (they count every model), then any other window the
// engine reports, so a per-model or spend window is shown rather than dropped.
const LIMIT_ORDER = ['five_hour', 'seven_day']
const limitLabel = (kind: string) =>
  kind.replace('five_hour', '5h').replace('seven_day', 'weekly').replace('spend_limit', 'spend').replace(/_/g, ' ')

function toLimits(limits: readonly SessionRateLimit[], now: number): UsageLimit[] {
  const rank = (kind: string) => {
    const i = LIMIT_ORDER.indexOf(kind)
    return i === -1 ? LIMIT_ORDER.length : i
  }
  return [...limits]
    .sort((a, b) => rank(a.kind) - rank(b.kind))
    .map(l => {
      const at = l.resetsAt ? Date.parse(l.resetsAt) : NaN
      // Rounded to the minute so the snapshot, and the redraw, changes at most once a minute.
      const resetsInMin = Number.isNaN(at) ? null : Math.max(0, Math.round((at - now) / 60_000))
      return { kind: l.kind, label: limitLabel(l.kind), percent: l.percentUsed, resetsInMin }
    })
}

function toSnapshot(b: SessionContextBreakdown, limits: UsageLimit[], costUsd: number | null): ContextSnapshot {
  let unknown = 0
  const segments = b.categories.filter(isInWindow).map((c): ContextSegment => {
    const look = LOOKS[c.name]
    if (c.kind === 'free') return { label: 'free', tokens: c.tokens, kind: c.kind, hex: TRACK_HEX, theme: c.color }
    if (c.kind === 'buffer') return { label: 'buffer', tokens: c.tokens, kind: c.kind, hex: TRACK_HEX, theme: c.color }
    const hex = look?.hex ?? FALLBACK_HEX[unknown++ % FALLBACK_HEX.length] ?? TRACK_HEX
    return { label: look?.label ?? c.name.toLowerCase(), tokens: c.tokens, kind: c.kind, hex, theme: c.color }
  })
  const compactAt = b.isAutoCompactEnabled && b.autoCompactThreshold ? b.autoCompactThreshold : null

  return { used: b.totalTokens, max: b.rawMaxTokens, compactAt, segments, limits, costUsd }
}

async function flush($: EngineInterface): Promise<void> {
  if (isFlushing) {
    isDirty = true
    return
  }
  isFlushing = true
  try {
    const [{ context, rateLimits, cost }, now] = await Promise.all([
      $.session.usage({ breakdown: 'summary' }),
      $.clock.now(),
    ])
    if (!context.breakdown) {
      // No session bound yet: try again on the next tick.
      isDirty = true
      return
    }
    const snap = toSnapshot(context.breakdown, toLimits(rateLimits, now), cost?.usd ?? null)
    const key = JSON.stringify(snap)
    if (key === lastKey) return
    lastKey = key
    await update($, snapshot, () => snap)
  } catch {
    // Left for the next forced pass rather than retried every tick.
  } finally {
    isFlushing = false
  }
}

const handoffArgs = (path: string) =>
  `Next session: continue this work where it left off. Save the handoff document at exactly ${path}, then reply with that path.`

async function findHandoff($: EngineInterface, expected: string, answer: string, since: number) {
  for (const path of [expected, ...(answer.match(TMP_MARKDOWN) ?? [])]) {
    const stat = await $.fs.stat(path).catch(() => undefined)
    // Written during this run (a minute of slack for clock skew), not an old one.
    if (stat?.kind === 'file' && stat.mtimeMs >= since - 60_000) return path
  }
  return null
}

// The press only records the request; the next tick (within a second) runs it,
// outside the press's own dispatch.
async function requestHandoff($: EngineInterface): Promise<void> {
  await update($, handoff, h => (h.phase === 'idle' ? { ...IDLE_HANDOFF, phase: 'requested' as const } : h))
}

// One step of the handoff run per call; the ticks call it until it is idle.
// Nothing is cleared unless the document was saved and read back non-empty.
async function driveHandoff($: EngineInterface): Promise<void> {
  if (isDriving) return
  isDriving = true
  const stop = async (why: string) => {
    await update($, handoff, () => IDLE_HANDOFF)
    $.ui.toast(`Handoff stopped: ${why}`)
  }
  try {
    const h = await read($, handoff)
    if (h.phase === 'idle') return
    const now = await $.clock.now()

    if (h.phase === 'requested') {
      // Pressed mid-turn: start once that turn has ended.
      if (isTurnRunning) return
      const commands = await $.command.list()
      if (!commands.some(c => c.name === HANDOFF_COMMAND)) return await stop(`/${HANDOFF_COMMAND} is not available`)
      const path = `/tmp/claude-handoff-${now}.md`
      lastTurn = null
      await update($, handoff, () => ({ phase: 'writing' as const, path, startedAt: now }))
      $.command
        .run({ command: HANDOFF_COMMAND, args: handoffArgs(path) })
        .catch(() => stop('the handoff command did not run, nothing was cleared'))
      return
    }

    if (h.phase === 'writing' && h.path !== null) {
      if (now - h.startedAt > HANDOFF_TIMEOUT_MS) return await stop('no handoff after 15 minutes, nothing was cleared')
      // Wait for the turn the skill started, not one that ran before it.
      if (lastTurn === null || lastTurn.startedAt < h.startedAt) return
      if (!lastTurn.isOk) return await stop('the handoff turn did not finish, nothing was cleared')
      const path = await findHandoff($, h.path, lastTurn.answer, h.startedAt)
      if (path === null) return await stop('no handoff file was saved, nothing was cleared')
      const doc = await $.fs.read(path)
      if (doc.trim() === '') return await stop('the handoff file is empty, nothing was cleared')

      await update($, handoff, () => ({ ...h, phase: 'clearing' as const }))
      await $.command.run({ command: 'clear' })
      // The fresh conversation's state starts over: redraw the bar from scratch.
      lastKey = ''
      isDirty = true
      // The document joins the fresh conversation as a row the model reads and
      // the transcript does not show as typed; the prompt itself stays one line.
      // Refused, the document rides in the prompt instead.
      const stored = await $.session
        .append({ message: { type: 'user', content: [{ type: 'text', text: `Handoff document:\n\n${doc}` }] } })
        .then(
          r => r.deny === undefined,
          () => false,
        )
      const lead = `Continue the work from the handoff document (saved at ${path})`
      await $.prompt.submit({ text: stored ? `${lead}, above.` : `${lead}:\n\n${doc}` })
      await update($, handoff, () => IDLE_HANDOFF)
      $.ui.toast('Handoff sent to a fresh conversation')
    }
  } catch {
    await stop('an error came up').catch(() => undefined)
  } finally {
    isDriving = false
  }
}

function fmt(n: number): string {
  const trim = (s: string) => s.replace(/\.0$/, '')
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${trim((n / 1000).toFixed(1))}k`
  if (n < 999_500) return `${Math.round(n / 1000)}k`
  return `${trim((n / 1_000_000).toFixed(1))}M`
}

function fmtUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return 'under $0.01'
  const [whole = '0', cents = '00'] = usd.toFixed(2).split('.')
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`
}

// What a segment's hover label says.
function segmentLabel(s: ContextSegment, max: number): string {
  if (s.kind === 'free') return `free ${fmt(s.tokens)}`
  if (s.kind === 'buffer') return `compaction buffer ${fmt(s.tokens)}`
  return `${s.label} ${fmt(s.tokens)} · ${pct(s.tokens, max)}%`
}

function fmtReset(min: number): string {
  if (min < 1) return 'under 1m'
  if (min < 60) return `${min}m`
  if (min < 1440) return `${Math.floor(min / 60)}h ${min % 60}m`
  return `${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h`
}

const levelHex = (percent: number) => (percent >= 80 ? '#E0704F' : percent >= 50 ? '#E8C56A' : '#86C06C')

const METER_CELLS = 10
const meterCells = (percent: number) =>
  percent > 0 ? Math.min(METER_CELLS, Math.max(1, Math.round((percent / 100) * METER_CELLS))) : 0

function meterSvg(percent: number): string {
  const w = Math.min(100, Math.max(0, percent))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="12" viewBox="0 0 100 6" preserveAspectRatio="none">` +
    `<defs><clipPath id="m"><rect width="100" height="6" rx="3" ry="3"/></clipPath></defs>` +
    `<g clip-path="url(#m)"><rect width="100" height="6" fill="${TRACK_HEX}" fill-opacity="0.22"/>` +
    `<rect width="${w.toFixed(1)}" height="6" fill="${levelHex(percent)}"/></g></svg>`
  )
}

// Any row holding tokens shows at least 1%, so a small row never reads as empty.
const pct = (tokens: number, max: number) =>
  tokens > 0 && max > 0 ? Math.max(1, Math.round((tokens / max) * 100)) : 0

// Splits `width` cells across the rows by share, every non-empty row getting at
// least one cell, the rounding leftovers going to the largest remainders.
function allocate(segs: ContextSegment[], width: number): number[] {
  const total = segs.reduce((sum, s) => sum + s.tokens, 0)
  if (total <= 0 || width <= 0) return segs.map(() => 0)
  const raw = segs.map(s => (s.tokens / total) * width)
  const cells = raw.map((r, i) => ((segs[i]?.tokens ?? 0) > 0 ? Math.max(1, Math.floor(r)) : 0))
  let left = width - cells.reduce((a, b) => a + b, 0)
  const order = raw
    .map((r, i) => ({ i, rem: r - Math.floor(r) }))
    .filter(({ i }) => (segs[i]?.tokens ?? 0) > 0)
    .sort((a, b) => b.rem - a.rem)
  for (let k = 0; left > 0 && order.length > 0; k++) {
    const slot = order[k % order.length]
    if (slot) cells[slot.i] = (cells[slot.i] ?? 0) + 1
    left -= 1
  }
  while (left < 0) {
    const widest = cells.indexOf(Math.max(...cells))
    cells[widest] = (cells[widest] ?? 1) - 1
    left += 1
  }
  return cells
}

// Desktop fill for one bar segment: a solid strip stretched to the segment's
// box. A plain image, so the pointer over it is the enclosing Box's hover.
function segmentSvg(fill: string, opacity: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="20" viewBox="0 0 100 10" preserveAspectRatio="none">` +
    `<rect width="100" height="10" fill="${fill}" fill-opacity="${opacity}"/></svg>`
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    isDirty = true
    // A reload loses the run's module variables: start it over rather than hang.
    await update($, handoff, () => IDLE_HANDOFF)
    let ticks = 0
    $.clock.every(TICK_MS, () => {
      void driveHandoff($)
      ticks += 1
      if (burstTicks > 0) burstTicks -= 1
      if (isDirty || burstTicks > 0 || ticks % FORCE_EVERY_TICKS === 0) {
        isDirty = false
        void flush($)
      }
    })

    return ran
  })

  // Mid-turn growth. A model request starts once the prompt or the last tool
  // results are in, and ends with the response: mark stale on both edges. These
  // hooks only flip a flag, so they never gate the prompt, a tool or a compaction.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) isDirty = true
    const ran = yield* next(e)
    if (!e.agentId) isDirty = true
    return ran
  })

  // Turns, for the handoff run: whether one is running, and the main loop's last answer.
  on('turn.start', async ($, e, next) => {
    isTurnRunning = true
    turnStartedAt = await $.clock.now()
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', ($, e, next) => {
    if (!e.agentId) {
      isTurnRunning = false
      lastTurn = { startedAt: turnStartedAt, answer: e.answer, isOk: e.reason === 'answer' && !e.isAborted }
      isDirty = true
    }
    return next(e)
  })

  // A compaction runs for a while: refresh on every tick for the next 60s.
  on('session.compact', ($, e, next) => {
    burstTicks = 60
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', ($, e, next) => {
    if (e.reason === 'clear') {
      burstTicks = 10
      lastKey = ''
    }
    return next(e)
  })

  // After every main-thread turn the engine measures; refresh right away.
  on('session.measure', async ($, e, next) => {
    await flush($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const snap = await read($, snapshot)
    if (snap === null || snap.max <= 0) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const run = await read($, handoff)
    // Card border (2) and padding (2) come off the band's width.
    const inner = Math.max(20, e.props.bodyColumns - 4)
    const compact = snap.compactAt === null ? 'auto-compact off' : `compacts at ${pct(snap.compactAt, snap.max)}%`

    const header = (
      <Box justifyContent="space-between">
        <Text bold>context</Text>
        <Text>
          <Text bold>{fmt(snap.used)}</Text>
          <Text dimColor>
            {' '}/ {fmt(snap.max)} · {pct(snap.used, snap.max)}% · {compact}
          </Text>
        </Text>
      </Box>
    )

    // The bar: one keyed Box per segment, sized in cells, each its own hover
    // scope. Its label is plain text with no background, so it sits on the blank
    // row under the bar (the usage section's top margin), where it covers no
    // other text; hidden until the pointer is over the segment, shifted left
    // where it would run past the bar's end.
    const cells = allocate(snap.segments, inner)
    const barOf = (fill: (s: ContextSegment, n: number, label: string) => JSX.Element) => {
      let start = 0
      return (
        <Box>
          {snap.segments.map((s, i) => {
            const n = cells[i] ?? 0
            const at = start
            start += n
            if (n <= 0) return null
            const label = segmentLabel(s, snap.max)
            const left = Math.max(-at, Math.min(0, inner - (at + label.length)))
            return (
              <Box key={`segment-${i}`} width={n}>
                {fill(s, n, label)}
                <Box position="absolute" top={1} left={left} display="none" hover={{ display: 'flex' }}>
                  <Text>{label}</Text>
                </Box>
              </Box>
            )
          })}
        </Box>
      )
    }

    let bar
    let meters
    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      bar = barOf((s, _n, label) =>
        s.kind === 'used' ? (
          <Svg source={segmentSvg(s.hex, 1)} alt={label} height={10} />
        ) : (
          <Svg source={segmentSvg(TRACK_HEX, s.kind === 'buffer' ? 0.45 : 0.22)} alt={label} height={10} />
        ),
      )
      meters = snap.limits.map(l => (
        <Svg source={meterSvg(l.percent)} alt={`${l.label} limit ${l.percent}% used`} width={140} height={8} />
      ))
    } else {
      bar = barOf((s, n) =>
        s.kind === 'used' ? (
          <Text color={s.hex}>{'█'.repeat(n)}</Text>
        ) : (
          <Text color={s.theme}>{(s.kind === 'buffer' ? '▒' : '░').repeat(n)}</Text>
        ),
      )
      meters = snap.limits.map(l => {
        const n = meterCells(l.percent)
        return (
          <Text>
            <Text color={levelHex(l.percent)}>{'█'.repeat(n)}</Text>
            <Text dimColor>{'░'.repeat(METER_CELLS - n)}</Text>
          </Text>
        )
      })
    }

    // Usage as a small table: one row per window, then the session's spend.
    const HEAD_W = 7
    const limitW = Math.max(...snap.limits.map(l => l.label.length), 'session'.length) + 2
    const heading = <Text bold>usage</Text>
    const limitRows = snap.limits.map((l, i) => (
      <Box alignItems="center">
        <Box width={HEAD_W}>{i === 0 && heading}</Box>
        <Box width={limitW}>
          <Text dimColor>{l.label}</Text>
        </Box>
        {meters[i]}
        <Box width={8} justifyContent="flex-end">
          <Text bold>{l.percent}%</Text>
        </Box>
        {l.resetsInMin !== null && (
          <Box marginLeft={3}>
            <Text dimColor>resets in {fmtReset(l.resetsInMin)}</Text>
          </Box>
        )}
      </Box>
    ))
    const noLimits = (
      <Box>
        <Box width={HEAD_W}>{heading}</Box>
        <Box width={limitW}>
          <Text dimColor>limits</Text>
        </Box>
        <Text dimColor>no reading yet</Text>
      </Box>
    )
    const costRow = (
      <Box>
        <Box width={HEAD_W}>{null}</Box>
        <Box width={limitW}>
          <Text dimColor>session</Text>
        </Box>
        {snap.costUsd === null ? (
          <Text dimColor>cost unavailable</Text>
        ) : (
          <Text>
            <Text bold>{fmtUsd(snap.costUsd)}</Text>
            <Text dimColor> estimated at API prices</Text>
          </Text>
        )}
      </Box>
    )
    const usageTable = (
      <Box flexDirection="column">
        {snap.limits.length === 0 ? noLimits : limitRows}
        {costRow}
      </Box>
    )
    const status: Record<Exclude<HandoffState['phase'], 'idle'>, string> = {
      requested: e.props.isWorking ? 'handoff queued, starts after this turn' : 'starting handoff…',
      writing: 'writing handoff…',
      clearing: 'clearing context…',
    }
    const handoffControl =
      run.phase === 'idle' ? (
        <Button key="handoff" label="handoff" hotkey="h" onPress={() => requestHandoff($)} />
      ) : (
        <Text dimColor>{status[run.phase]}</Text>
      )
    const usage = (
      <Box marginTop={1} justifyContent="space-between" alignItems="flex-end" flexWrap="wrap" columnGap={2}>
        {usageTable}
        {handoffControl}
      </Box>
    )

    return (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} width={e.props.bodyColumns}>
        {header}
        {bar}
        {usage}
      </Box>
    )
  })
}
