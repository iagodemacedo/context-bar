import type { On, SessionContextBreakdown, SessionRateLimit } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const BREAKDOWN: SessionContextBreakdown = {
  categories: [
    { name: 'System prompt', tokens: 4_200, color: 'promptBorder', isDeferred: false, kind: 'used' },
    { name: 'System tools', tokens: 17_000, color: 'inactive', isDeferred: false, kind: 'used' },
    { name: 'MCP tools', tokens: 52_000, color: 'permission', isDeferred: false, kind: 'used' },
    { name: 'MCP tools (deferred)', tokens: 40_000, color: 'inactive', isDeferred: true, kind: 'deferred' },
    { name: 'Custom agents', tokens: 3_400, color: 'permission', isDeferred: false, kind: 'used' },
    { name: 'Memory files', tokens: 8_600, color: 'claude', isDeferred: false, kind: 'used' },
    { name: 'Skills', tokens: 5_100, color: 'warning', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: 0, color: 'claude', isDeferred: false, kind: 'used' },
    { name: 'Free space', tokens: 897_000, color: 'promptBorder', isDeferred: false, kind: 'free' },
    { name: 'Autocompact buffer', tokens: 12_700, color: 'inactive', isDeferred: false, kind: 'buffer' },
  ],
  totalTokens: 90_300,
  maxTokens: 1_000_000,
  rawMaxTokens: 1_000_000,
  autocompactSource: 'auto',
  percentage: 9,
  gridRows: [],
  model: 'claude-opus-5-5',
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  autoCompactThreshold: 950_000,
  isAutoCompactEnabled: true,
  apiUsage: null,
}

const BAND = {
  plugin: 'context-bar',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

const NOW = Date.parse('2026-10-06T12:00:00Z')
const inMinutes = (min: number) => new Date(NOW + min * 60_000).toISOString()
const LIMITS: SessionRateLimit[] = [
  { kind: 'seven_day', percentUsed: 17.5, resetsAt: inMinutes(3 * 1440 + 4 * 60) },
  { kind: 'five_hour', percentUsed: 42, resetsAt: inMinutes(134) },
  { kind: 'seven_day_opus', percentUsed: 60 },
]

// Stands for the engine beneath the plugin: usage figures, the measure echo, the clock.
function mockEngine(on: On, rateLimits: SessionRateLimit[], cost?: { usd: number }, withClock = true) {
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 90_300, window: 1_000_000, percent: 9, breakdown: BREAKDOWN },
      rateLimits,
      ...(cost ? { cost } : {}),
    },
  }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  if (withClock) on('clock.now', () => ({ value: NOW }))
}

test('context is the bar alone, each segment labelled on hover', async ($, on) => {
  mockEngine(on, LIMITS, { usd: 4.1234 })
  await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [], changed: ['context'] })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: /^90k$/ })).toBeDefined()
    expect(await ui.find({ text: /\/ 1M · 9% · compacts at 95%/ })).toBeDefined()
    // No legend row: the labels live only in the hover labels.
    expect(await ui.find({ text: /^mcp tools$/ })).toBeUndefined()

    // No accent glyph before the headings.
    expect(await ui.find({ text: /◆/ })).toBeUndefined()
    expect(await ui.find({ text: /^context$/ })).toBeDefined()
    expect(await ui.find({ text: /^usage$/ })).toBeDefined()

    // Each segment carries a hidden label its hover reveals, on both surfaces,
    // in plain text: no colored background behind it.
    expect(await ui.find({ text: /^mcp tools 52k · 5%$/ })).toBeDefined()
    expect(await ui.find({ text: /^system prompt 4.2k · 1%$/ })).toBeDefined()
    expect(await ui.find({ text: /^free 897k$/ })).toBeDefined()
    expect(await ui.find({ text: /^compaction buffer 13k$/ })).toBeDefined()
    const label = await ui.find({ text: /^mcp tools 52k · 5%$/ })
    expect(label?.props.backgroundColor).toBeUndefined()
    expect(label?.props.color).toBeUndefined()
    // Deferred schemas are outside the window and stay off the bar.
    expect(await ui.find({ text: /deferred/ })).toBeUndefined()
    // The label is drawn hidden and its hover shows it (the hover rides on the
    // element), on the blank row under the bar so it covers no other text.
    const segment = await ui.find({ key: 'segment-2' })
    type Drawn = { props?: { position?: string; display?: string; top?: number }; hover?: { display?: string } }
    const chip = (segment?.children ?? []).find(
      c => typeof c === 'object' && c !== null && (c as Drawn).props?.position === 'absolute',
    ) as Drawn | undefined
    expect(chip?.props?.display).toBe('none')
    expect(chip?.props?.top).toBe(1)
    expect(chip?.hover?.display).toBe('flex')
    if (surface === 'desktop') {
      // One plain image per segment, so the pointer over it is the Box's hover.
      const fills = (await ui.findAll({ type: 'Svg' })).filter(f => String(f.props.alt).startsWith('mcp tools'))
      expect(fills.length).toBeGreaterThan(0)
      expect(fills[0]?.props.isInteractive).toBeUndefined()
    }

    // Usage limits: account-wide windows first, any other window kept.
    expect(await ui.find({ text: /^5h$/ })).toBeDefined()
    expect(await ui.find({ text: /^42%$/ })).toBeDefined()
    expect(await ui.find({ text: /resets in 2h 14m/ })).toBeDefined()
    expect(await ui.find({ text: /^weekly$/ })).toBeDefined()
    expect(await ui.find({ text: /^17.5%$/ })).toBeDefined()
    expect(await ui.find({ text: /resets in 3d 4h/ })).toBeDefined()
    expect(await ui.find({ text: /^weekly opus$/ })).toBeDefined()
    expect(await ui.find({ text: /^60%$/ })).toBeDefined()

    // Session spend, as /cost totals it.
    expect(await ui.find({ text: /^session$/ })).toBeDefined()
    expect(await ui.find({ text: /^\$4\.12$/ })).toBeDefined()
    expect(await ui.find({ text: /estimated at API prices/ })).toBeDefined()
    await ui.unmount()
  }
})

test('band yields to a survey', async ($, on) => {
  mockEngine(on, LIMITS)
  // Stands for the engine's own band (the survey) beneath the plugin.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>survey</Text>
  })
  await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ text: 'survey' })).toBeDefined()
  expect(await ui.find({ text: /context/ })).toBeUndefined()
  await ui.unmount()
})

test('usage says so when no window has a reading and no cost is kept', async ($, on) => {
  mockEngine(on, [])
  await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [], changed: ['context'] })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: /no reading yet/ })).toBeDefined()
    expect(await ui.find({ text: /cost unavailable/ })).toBeDefined()
    expect(await ui.find({ text: /^90k$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a large spend reads with thousands separators', async ($, on) => {
  mockEngine(on, LIMITS, { usd: 1234.5 })
  await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [], changed: ['cost'] })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /^\$1,234\.50$/ })).toBeDefined()
  await ui.unmount()
})

// The world the handoff run talks to: the command list and runs, the file the
// skill saves, the prompt it submits, the toasts, turns and the session start.
function mockHandoffWorld(on: On, file: { exists: boolean; doc?: string }) {
  const runs: { command: string; args: string }[] = []
  const submits: { text: string; context?: readonly string[] }[] = []
  const toasts: string[] = []
  on('command.list', () => ({
    value: [{ name: 'context-bar:handoff', description: 'Handoff', source: 'plugin' as const }],
  }))
  on('command.run', (_$, e) => {
    runs.push({ command: e.command, args: e.args })
    return { text: '' }
  })
  on('fs.stat', () =>
    file.exists ? { value: { kind: 'file' as const, size: 10, mtimeMs: NOW + 5_000, isLink: false } } : { deny: 'ENOENT' },
  )
  on('fs.read', () => ({ value: file.doc ?? '# Handoff' }))
  on('prompt.submit', (_$, e) => {
    submits.push({ text: e.text, context: e.context })
    return { text: e.text, context: e.context }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  return { runs, submits, toasts }
}

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const MEASURE = { context: { window: 1_000_000 }, rateLimits: [], changed: ['context' as const] }
const answered = (answer: string) =>
  ({ answer, durationMs: 5_000, isAborted: false, turnId: 't1', reason: 'answer' }) as const

test('handoff writes the document, clears, and starts the fresh conversation from it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mockEngine(on, LIMITS, { usd: 1 }, false)
  const world = mockHandoffWorld(on, { exists: true, doc: '# Handoff\nnext steps' })
  const session = mock.session(on)
  await $.session.start(START)
  await $.session.measure(MEASURE)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect(await ui.find({ type: 'Button', key: 'handoff' })).toBeDefined()
  await ui.press({ key: 'handoff' })
  await clock.advance(1_000)
  expect(world.runs[0]?.command).toBe('context-bar:handoff')
  expect(world.runs[0]?.args).toContain('/tmp/claude-handoff-')
  expect(await ui.find({ text: /writing handoff/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'handoff' })).toBeUndefined()

  await $.turn.start({ text: '/context-bar:handoff', turnId: 't1' })
  await clock.advance(5_000)
  await $.turn.complete(answered('Saved.'))
  await clock.advance(1_000)

  expect(world.runs.map(r => r.command)).toEqual(['context-bar:handoff', 'clear'])
  expect(world.submits).toHaveLength(1)
  // The document went in as a row the model reads; the prompt stays one line.
  expect(world.submits[0]?.text).toMatch(/^Continue the work from the handoff document \(saved at \/tmp\/claude-handoff-\d+\.md\), above\.$/)
  const rows = session.appended().map(r => JSON.stringify(r.message))
  expect(rows.some(r => r.includes('# Handoff\\nnext steps'))).toBe(true)
  expect(world.toasts.join(' ')).toMatch(/Handoff sent to a fresh conversation/)
  await ui.unmount()
})

test('handoff clears nothing when the turn is interrupted or no file was saved', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mockEngine(on, LIMITS, undefined, false)
  const world = mockHandoffWorld(on, { exists: false })
  await $.session.start(START)
  await $.session.measure(MEASURE)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  // No file saved.
  await ui.press({ key: 'handoff' })
  await clock.advance(1_000)
  await $.turn.start({ text: 'handoff', turnId: 't1' })
  await $.turn.complete(answered('Done, but nothing was saved.'))
  await clock.advance(1_000)
  expect(world.toasts.join(' ')).toMatch(/no handoff file was saved, nothing was cleared/)

  // Interrupted.
  await ui.press({ key: 'handoff' })
  await clock.advance(1_000)
  await $.turn.start({ text: 'handoff', turnId: 't2' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't2', reason: 'aborted' })
  await clock.advance(1_000)
  expect(world.toasts.join(' ')).toMatch(/the handoff turn did not finish, nothing was cleared/)

  expect(world.runs.map(r => r.command)).toEqual(['context-bar:handoff', 'context-bar:handoff'])
  expect(world.submits).toHaveLength(0)
  expect(await ui.find({ type: 'Button', key: 'handoff' })).toBeDefined()
  await ui.unmount()
})

test('handoff pressed mid-turn waits for that turn to end', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mockEngine(on, LIMITS, undefined, false)
  const world = mockHandoffWorld(on, { exists: true })
  await $.session.start(START)
  await $.session.measure(MEASURE)
  await $.turn.start({ text: 'some other work', turnId: 't0' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: true } })

  await ui.press({ key: 'handoff' })
  await clock.advance(3_000)
  expect(world.runs).toHaveLength(0)
  expect(await ui.find({ text: /handoff queued, starts after this turn/ })).toBeDefined()

  await $.turn.complete({ ...answered('Other work done.'), turnId: 't0' })
  await clock.advance(1_000)
  expect(world.runs[0]?.command).toBe('context-bar:handoff')
  await ui.unmount()
})
