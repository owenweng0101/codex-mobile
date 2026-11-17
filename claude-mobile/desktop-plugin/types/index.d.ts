export type ClaudeMobileNativeConfig = {
  version: 1
  socketPath: string
  token: string
}

export type ClaudeMobileNativeJob = {
  requestId: string
  sessionId: string
  text: string
}

export type ClaudeMobileNativePoll = {
  protocol: 1
  bridgeId: string
  leaseId: string
  job: ClaudeMobileNativeJob | null
}

export type ClaudeMobileNativeIdentity = {
  sessionId: string
  requestId: string
  dispatchToken: string
}

export type ClaudeMobileNativeReceipt = ClaudeMobileNativeIdentity & (
  | { status: 'accepted'; nativeMessageId: string }
  | { status: 'rejected'; reason: 'native-prompt-dropped' }
  | { status: 'unknown' }
)

export type ClaudeMobileNativeTerminalReceipt = Exclude<
  ClaudeMobileNativeReceipt,
  { status: 'unknown' }
>

export type ClaudeMobileNativeActive = ClaudeMobileNativeJob & {
  bridgeId: string
  leaseId: string
} & (
  | { phase: 'claiming'; instanceId: string }
  | { phase: 'dispatching' | 'submitted' | 'unknown'; dispatchToken: string; instanceId?: string }
  | { phase: 'accepted'; dispatchToken: string; nativeMessageId: string; instanceId?: string }
  | { phase: 'rejected'; dispatchToken: string; reason: 'native-prompt-dropped'; instanceId?: string }
)

export type ClaudeMobileNativeCompletion = ClaudeMobileNativeTerminalReceipt | {
  sessionId: string
  requestId: string
  status: 'not-dispatched'
}

// One session, one active operation. The bearer credential is never stored.
// An active operation records its ORIGINAL instance only for recovery. A fresh
// load never reuses that identity as its current instanceId. The server, not
// this local checkpoint, arbitrates claims between concurrent instances.
// $.state survives hot reload; the plugin's own $.store mirrors this checkpoint
// before every engine action so a process restart cannot replay a prompt.
export type ClaudeMobileNativeState = {
  version: 1
  revision: number
  sessionId: string
  active: ClaudeMobileNativeActive | null
  pendingReceipt: ClaudeMobileNativeReceipt | null
  completed: ClaudeMobileNativeCompletion[]
}

// Observed native main-turn facts only. Session state preserves hot reload;
// this value must never enter the cross-process $.store checkpoint above.
export type ClaudeMobileNativeRuntime = {
  status: 'running' | 'idle'
  turnId: string
  startedAt: number
  endedAt: number | null
  durationMs: number | null
  updatedAt: number
  reason?: string
}

declare module 'claude-code' {
  interface PluginState {
    'mobile-native-bridge': {
      bridge: ClaudeMobileNativeState
      runtime: ClaudeMobileNativeRuntime
    }
  }
}
