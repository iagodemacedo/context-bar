export type ContextSegment = {
  label: string
  tokens: number
  kind: 'used' | 'free' | 'buffer'
  hex: string
  theme: string
}

export type UsageLimit = {
  kind: string
  label: string
  percent: number
  // Minutes until the window resets, rounded, as of the last refresh; null when unknown.
  resetsInMin: number | null
}

export type ContextSnapshot = {
  used: number
  max: number
  compactAt: number | null
  segments: ContextSegment[]
  limits: UsageLimit[]
  // The session's spend as /cost totals it (API list prices unless the organization set its own); null when the host keeps no ledger.
  costUsd: number | null
}

// The handoff button's run: requested (waits for a running turn to end), the
// skill writing the document, then the conversation clearing.
export type HandoffPhase = 'idle' | 'requested' | 'writing' | 'clearing'

export type HandoffState = {
  phase: HandoffPhase
  // Where the skill was asked to save the document.
  path: string | null
  startedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-bar': { snapshot: ContextSnapshot | null; handoff: HandoffState }
  }
}
