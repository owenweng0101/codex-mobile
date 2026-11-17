import type {
  EngineInterface,
  Register,
  SessionAppendInput,
  SessionAppendResult,
  Timer,
} from 'claude-code'
import type {
  ClaudeMobileNativeActive as Active,
  ClaudeMobileNativeConfig as Config,
  ClaudeMobileNativeCompletion as Completion,
  ClaudeMobileNativeIdentity as Identity,
  ClaudeMobileNativePoll as Poll,
  ClaudeMobileNativeReceipt as Receipt,
  ClaudeMobileNativeRuntime as Runtime,
  ClaudeMobileNativeState as State,
  ClaudeMobileNativeTerminalReceipt as TerminalReceipt,
} from '../types'

const REF = { plugin: 'mobile-native-bridge', key: 'bridge' } as const
const RUNTIME_REF = { plugin: 'mobile-native-bridge', key: 'runtime' } as const
const ORIGIN = 'http://claude-mobile-native'
const DROP_REASON = 'native-prompt-dropped' as const
const uuid = (v: unknown): v is string => typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
const text = (v: unknown): v is string => typeof v === 'string'
const id = (v: unknown): v is string => text(v) && v.length > 0
const absolute = (v: unknown): v is string => id(v) && v.startsWith('/') &&
  !v.startsWith('//') && !v.includes('\0')
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const keys = (v: unknown, names: readonly string[]): v is Record<string, unknown> =>
  object(v) && Object.keys(v).length === names.length &&
  names.every(name => Object.prototype.hasOwnProperty.call(v, name))

function configOf(value: unknown): Config | undefined {
  if (keys(value, ['version', 'socketPath', 'token']) && value.version === 1 &&
    absolute(value.socketPath) && text(value.token) && /^[A-Za-z0-9_-]{32,}$/.test(value.token)) {
    return value as Config
  }
}

function pollOf(value: unknown): Poll | undefined {
  if (!keys(value, ['protocol', 'bridgeId', 'leaseId', 'job']) || value.protocol !== 1 ||
    !id(value.bridgeId) || !id(value.leaseId)) return
  const job = value.job
  if (job !== null && (!keys(job, ['requestId', 'sessionId', 'text']) ||
    !id(job.requestId) || !id(job.sessionId) || !text(job.text))) return
  return value as Poll
}

function receiptOf(value: unknown): value is Receipt {
  if (!object(value) || !id(value.sessionId) || !id(value.requestId) ||
    !id(value.dispatchToken)) return false
  const base = ['sessionId', 'requestId', 'dispatchToken', 'status']
  if (value.status === 'unknown') return keys(value, base)
  if (value.status === 'accepted') return keys(value, [...base, 'nativeMessageId']) && uuid(value.nativeMessageId)
  return value.status === 'rejected' && keys(value, [...base, 'reason']) && value.reason === DROP_REASON
}

function completionOf(value: unknown): value is Completion {
  if (keys(value, ['sessionId', 'requestId', 'status']) && value.status === 'not-dispatched') {
    return id(value.sessionId) && id(value.requestId)
  }
  return receiptOf(value) && value.status !== 'unknown'
}

function activeOf(value: unknown): value is Active {
  if (!object(value) || !id(value.requestId) || !id(value.sessionId) || !text(value.text) ||
    !id(value.bridgeId) || !id(value.leaseId)) return false
  const base = ['requestId', 'sessionId', 'text', 'bridgeId', 'leaseId', 'phase']
  if (value.phase === 'claiming') return keys(value, [...base, 'instanceId']) && id(value.instanceId)
  // Older dispatched checkpoints had no instanceId. They remain ambiguous;
  // only a claiming checkpoint needs a previous instance for safe recovery.
  if (value.instanceId !== undefined) {
    if (!id(value.instanceId)) return false
    base.push('instanceId')
  }
  if (!id(value.dispatchToken)) return false
  if (value.phase === 'accepted') return keys(value, [...base, 'dispatchToken', 'nativeMessageId']) && uuid(value.nativeMessageId)
  if (value.phase === 'rejected') return keys(value, [...base, 'dispatchToken', 'reason']) && value.reason === DROP_REASON
  return ['dispatching', 'submitted', 'unknown'].includes(String(value.phase)) && keys(value, [...base, 'dispatchToken'])
}

function same(active: Active | null | undefined, operation: Identity): boolean {
  return !!active && active.phase !== 'claiming' && active.sessionId === operation.sessionId &&
    active.requestId === operation.requestId && active.dispatchToken === operation.dispatchToken
}

function sameClaim(active: Active | null | undefined, previous: Extract<Active, { phase: 'claiming' }>): boolean {
  return active?.phase === 'claiming' && active.sessionId === previous.sessionId &&
    active.requestId === previous.requestId && active.bridgeId === previous.bridgeId &&
    active.leaseId === previous.leaseId && active.instanceId === previous.instanceId
}

function receiptFor(active: Exclude<Active, { phase: 'claiming' }>): Receipt | undefined {
  const identity = { sessionId: active.sessionId, requestId: active.requestId, dispatchToken: active.dispatchToken }
  if (active.phase === 'accepted') return { ...identity, status: 'accepted', nativeMessageId: active.nativeMessageId }
  if (active.phase === 'rejected') return { ...identity, status: 'rejected', reason: DROP_REASON }
  if (active.phase === 'unknown') return { ...identity, status: 'unknown' }
}

function stateOf(value: unknown, sessionId: string): value is State {
  if (!keys(value, ['version', 'revision', 'sessionId', 'active', 'pendingReceipt', 'completed']) ||
    value.version !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
    value.sessionId !== sessionId || !Array.isArray(value.completed)) return false
  const seenRequests = new Set<string>()
  const seenMessages = new Set<string>()
  for (const receipt of value.completed) {
    if (!completionOf(receipt) || receipt.sessionId !== sessionId || seenRequests.has(receipt.requestId)) return false
    seenRequests.add(receipt.requestId)
    if (receipt.status === 'accepted') {
      if (seenMessages.has(receipt.nativeMessageId)) return false
      seenMessages.add(receipt.nativeMessageId)
    }
  }
  const active = value.active
  if (active !== null && (!activeOf(active) || active.sessionId !== sessionId ||
    seenRequests.has(active.requestId) || (active.phase === 'accepted' && seenMessages.has(active.nativeMessageId)))) return false
  if (value.pendingReceipt !== null) {
    if (!receiptOf(value.pendingReceipt) || !active || active.phase === 'claiming' ||
      !same(active, value.pendingReceipt) || JSON.stringify(receiptFor(active)) !== JSON.stringify(value.pendingReceipt)) return false
  }
  return true
}

const milliseconds = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

function runtimeOf(value: unknown): value is Runtime {
  if (!object(value)) return false
  const names = ['status', 'turnId', 'startedAt', 'endedAt', 'durationMs', 'updatedAt']
  if (!keys(value, value.reason === undefined ? names : [...names, 'reason']) ||
    !id(value.turnId) || !milliseconds(value.startedAt) || !milliseconds(value.updatedAt)) return false
  if (value.status === 'running') return value.endedAt === null && value.durationMs === null && value.reason === undefined
  return value.status === 'idle' && milliseconds(value.endedAt) && milliseconds(value.durationMs) &&
    (value.reason === undefined || text(value.reason))
}

function userRow(message: SessionAppendInput['message'], expected: string): boolean {
  return message.type === 'user' && message.role === 'user' && !message.isMeta &&
    message.content.every(block => block.type === 'text' && text(block.text)) &&
    message.content.map(block => block.text).join('') === expected
}

function observed(e: SessionAppendInput, result: SessionAppendResult, active: Active): result is Exclude<SessionAppendResult, { deny: string }> {
  return e.door === 'prompt' && e.agentId === undefined && e.origin.kind === 'plugin' &&
    'name' in e.origin && 'asUser' in e.origin &&
    e.origin.name === 'mobile-native-bridge' && e.origin.asUser === true &&
    result.deny === undefined && uuid(result.uuid) && result.uuid === e.uuid &&
    userRow(e.message, active.text) && userRow(result.message, active.text)
}

function createBridge($: EngineInterface, instanceId: string) {
  let config: Config | undefined
  let sessionId: string | undefined
  let hostSessionId: string | undefined
  let entrypoint: string | undefined
  let held: State | undefined
  let connection: { bridgeId: string; leaseId: string } | undefined
  let checkpointedRevision = -1
  let localReady: Promise<void> | undefined
  let initialized = false
  let blocked = false
  let stopped = false
  let timer: Timer | undefined
  let pollBusy = false
  let claimBusy = false
  let receiptBusy = false
  let submitBusy = false
  let writes: Promise<void> = Promise.resolve()
  let runtime: Runtime | undefined
  let runtimeObserved = false
  let runtimeWrites: Promise<void> = Promise.resolve()
  const storeKey = () => `native-bridge-v1:${sessionId}`

  async function restoreRuntime() {
    try {
      const value = (await $.state.get(RUNTIME_REF)).value
      // No disk recovery and no invented clock reading. A live event that
      // races initialization wins over a hot-reload snapshot.
      if (!stopped && !runtimeObserved && runtimeOf(value)) runtime = value
    } catch {
      // Until an actual native event supplies it, runtime is omitted.
    }
  }

  function recordRuntime(value: Runtime): Promise<void> {
    if (stopped) return Promise.resolve()
    runtimeObserved = true
    runtime = value
    runtimeWrites = runtimeWrites.then(async () => {
      if (stopped) return
      try { await $.state.set(RUNTIME_REF, value) } catch { /* Observation must not affect a native turn. */ }
    })
    return runtimeWrites
  }

  // Only a successful poll grants this instance permission to write the shared
  // store. A second instance may have read the same old checkpoint; it must not
  // overwrite the owner merely by loading. Store precedes the session mirror.
  async function persistHeld(): Promise<boolean> {
    const value = held
    const grant = connection
    if (stopped || !value || !grant) return false
    if (checkpointedRevision === value.revision) return true
    if (blocked) return false
    try {
      await $.store.set(storeKey(), value)
      if (stopped || connection !== grant) return false
      if (!(await $.state.set(REF, value)).isSet) throw new Error('checkpoint-unavailable')
      if (stopped || connection !== grant) return false
      checkpointedRevision = value.revision
      return true
    } catch {
      blocked = true
      return false
    }
  }

  function serialize(work: () => Promise<boolean>): Promise<boolean> {
    const result = writes.then(work)
    writes = result.then(() => undefined, () => { blocked = true })
    return result.catch(() => false)
  }

  function checkpoint(): Promise<boolean> {
    return serialize(persistHeld)
  }

  function change(update: (state: State) => State | null): Promise<boolean> {
    return serialize(async () => {
      if (stopped || blocked || !held) return false
      const value = update(held)
      if (!value) return false
      // Early native rows can arrive before admission. Keep their UUID here,
      // without waiting for network inside session.append; persist upon grant.
      held = { ...value, revision: held.revision + 1 }
      return persistHeld()
    })
  }

  async function initialize() {
    try {
      // These environment names must remain literal for plugin validation.
      const override = await $.env.get('CLM_NATIVE_CONFIG')
      const home = override === undefined ? await $.env.get('HOME') : undefined
      const path = override === undefined && absolute(home)
        ? `${home}/Library/Application Support/ClaudeMobile/native-bridge.json` : override
      if (!absolute(path)) return
      config = configOf(JSON.parse(await $.fs.read(path)))
      if (!config || stopped) return
      // Report actual host facts, never a guessed desktop identity or fallback.
      hostSessionId = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
      entrypoint = await $.env.get('CLAUDE_CODE_ENTRYPOINT')
      if (!id(hostSessionId) || !id(entrypoint) || stopped) return
      sessionId = await $.session.id()
      if (!id(sessionId) || stopped) return
      const saved = (await $.state.get(REF)).value
      const durable = await $.store.get(storeKey())
      if ((saved !== undefined && !stateOf(saved, sessionId)) ||
        (durable !== undefined && !stateOf(durable, sessionId))) {
        blocked = true
        return
      }
      const disk = durable as State | undefined
      if (saved && disk && saved.revision === disk.revision && JSON.stringify(saved) !== JSON.stringify(disk)) {
        blocked = true
        return
      }
      held = disk && (!saved || disk.revision >= saved.revision) ? disk : saved
      held ??= { version: 1, revision: 0, sessionId, active: null, pendingReceipt: null, completed: [] }
      // Local recovery is read-only. No shared write until poll grants a lease.
      const active = held.active
      if (active?.phase === 'dispatching' || active?.phase === 'submitted') {
        await change(state => {
          const unknown = { ...active, phase: 'unknown' as const }
          return { ...state, active: unknown, pendingReceipt: receiptFor(unknown)! }
        })
      }
      await retire()
    } catch {
      // No error body, user text, path or credential is emitted by this plugin.
      blocked = true
    } finally {
      if (!config || !sessionId || !hostSessionId || !entrypoint) timer?.cancel()
    }
  }

  async function post(path: '/v1/poll' | '/v1/claim' | '/v1/receipt', body: unknown): Promise<unknown> {
    if (!config || stopped) return null
    try {
      const response = await $.http.fetch(`${ORIGIN}${path}`, {
        method: 'POST',
        socketPath: config.socketPath,
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return response.status === 200 && response.ok ? JSON.parse(response.text) : null
    } catch {
      return null
    }
  }

  async function retire() {
    if (submitBusy) return
    await change(state => {
      const active = state.active
      if (submitBusy || state.pendingReceipt || !active ||
        (active.phase !== 'accepted' && active.phase !== 'rejected')) return null
      return { ...state, active: null, completed: [...state.completed, receiptFor(active) as TerminalReceipt] }
    })
  }

  async function flushReceipt(receipt: Receipt) {
    if (!await checkpoint() || !connection ||
      JSON.stringify(held?.pendingReceipt) !== JSON.stringify(receipt)) return
    const response = await post('/v1/receipt', receipt)
    if (keys(response, ['recorded']) && response.recorded === true) {
      await change(state => JSON.stringify(state.pendingReceipt) === JSON.stringify(receipt)
        ? { ...state, pendingReceipt: null } : null)
      await retire()
    }
  }

  async function submit(active: Exclude<Active, { phase: 'claiming' }>) {
    try {
      // This is the sole engine action. No UUID, origin, queue policy, framing,
      // attachment, slash-command API, peer API or model call is synthesized.
      const result = await $.prompt.submit({ text: active.text, asUser: true })
      await change(state => {
        const current = state.active
        if (!same(current, active) || current?.phase !== 'dispatching') return null
        if (typeof result.drop === 'string') {
          const rejected = { ...active, phase: 'rejected' as const, reason: DROP_REASON }
          return { ...state, active: rejected, pendingReceipt: receiptFor(rejected)! }
        }
        return { ...state, active: { ...active, phase: 'submitted' } }
      })
    } catch {
      await change(state => {
        const current = state.active
        if (!same(current, active) || current?.phase === 'accepted' || current?.phase === 'rejected') return null
        const unknown = { ...active, phase: 'unknown' as const }
        return { ...state, active: unknown, pendingReceipt: receiptFor(unknown)! }
      })
    } finally {
      submitBusy = false
      await retire()
    }
  }

  async function claim(active: Extract<Active, { phase: 'claiming' }>) {
    const grant = connection
    if (!grant || !await checkpoint() || connection !== grant || !sameClaim(held?.active, active)) return
    const recover = active.instanceId !== instanceId || active.bridgeId !== grant.bridgeId || active.leaseId !== grant.leaseId
    const response = await post('/v1/claim', {
      sessionId: active.sessionId, requestId: active.requestId, instanceId, leaseId: grant.leaseId,
      ...(recover ? { recover: true, previousInstanceId: active.instanceId } : {}),
    })
    if (stopped || connection !== grant) return
    if (recover) {
      // Recovery never grants execution, even if a malformed server response
      // says claimed:true. Only claiming (no engine action) enters this branch.
      let completed: Completion | undefined
      if (keys(response, ['claimed', 'terminal', 'nativeMessageId', 'dispatchToken']) &&
        response.claimed === false && response.terminal === 'accepted' &&
        uuid(response.nativeMessageId) && id(response.dispatchToken)) {
        completed = { sessionId: active.sessionId, requestId: active.requestId,
          status: 'accepted', nativeMessageId: response.nativeMessageId, dispatchToken: response.dispatchToken }
      } else if (keys(response, ['claimed', 'terminal', 'notDispatched']) &&
        response.claimed === false && response.terminal === 'rejected' && response.notDispatched === true) {
        completed = { sessionId: active.sessionId, requestId: active.requestId, status: 'not-dispatched' }
      }
      if (completed) {
        const terminal = completed
        await change(state => sameClaim(state.active, active) &&
          !(terminal.status === 'accepted' && state.completed.some(item => item.status === 'accepted' && item.nativeMessageId === terminal.nativeMessageId))
          ? { ...state, active: null, pendingReceipt: null, completed: [...state.completed, terminal] } : null)
      }
      // The server already knows the terminal fact. No token is fabricated and
      // no new native acceptance receipt is inferred from a recovery response.
      return
    }
    if (!keys(response, ['claimed', 'dispatchToken']) || response.claimed !== true || !id(response.dispatchToken)) return
    const dispatching = { ...active, phase: 'dispatching' as const, dispatchToken: response.dispatchToken }
    const checkpointed = await change(state => sameClaim(state.active, active)
      ? { ...state, active: dispatching } : null)
    if (!checkpointed || stopped || blocked || submitBusy || connection !== grant) {
      await change(state => same(state.active, dispatching) && state.active?.phase === 'dispatching'
        ? { ...state, active: { ...dispatching, phase: 'unknown' },
          pendingReceipt: { sessionId: active.sessionId, requestId: active.requestId, dispatchToken: dispatching.dispatchToken, status: 'unknown' } } : null)
      return
    }
    submitBusy = true
    // Deliberately not awaited by a clock callback, poll, claim or receipt flush.
    void submit(dispatching)
  }

  function startClaim() {
    const active = held?.active
    if (!connection || claimBusy || blocked || stopped || active?.phase !== 'claiming') return
    claimBusy = true
    void claim(active).finally(() => { claimBusy = false })
  }

  function startReceipt() {
    if (!connection || receiptBusy || stopped || !held?.pendingReceipt) return
    receiptBusy = true
    void flushReceipt(held.pendingReceipt).finally(() => { receiptBusy = false })
  }

  async function poll() {
    const ready = !blocked && !!held && !held.active && !held.pendingReceipt && !submitBusy
    const response = pollOf(await post('/v1/poll', {
      sessionId, instanceId, hostSessionId, entrypoint, ready, ...(runtime ? { runtime } : {}),
    }))
    if (stopped) return
    // A 200 with the exact v1 body is the server's grant to this instance.
    // A competing instance, wrong host or expired owner gets no grant.
    if (!response) { connection = undefined; return }
    if (!connection || connection.bridgeId !== response.bridgeId || connection.leaseId !== response.leaseId) {
      connection = { bridgeId: response.bridgeId, leaseId: response.leaseId }
    }
    const grant = connection
    if (!await checkpoint() || stopped || blocked || connection !== grant) return
    startReceipt()
    // Even ready:false heartbeats can renew a changed bridge/lease. A claiming
    // operation then takes the terminal-only recovery path, never an old lease.
    startClaim()
    if (!ready || !response.job || response.job.sessionId !== sessionId) return
    const job = response.job
    const stored = await change(state => state.active || state.pendingReceipt ||
      state.completed.some(receipt => receipt.requestId === job.requestId) ? null : {
        ...state,
        active: { ...job, bridgeId: grant.bridgeId, leaseId: grant.leaseId, instanceId, phase: 'claiming' },
      })
    if (stored) startClaim()
  }

  function tick() {
    if (stopped || !initialized || !config || !sessionId) return
    // Independent, single-flight lanes. A queued native submit (or stalled
    // receipt request) must not prevent the ready:false heartbeat.
    if (!pollBusy) {
      pollBusy = true
      void poll().finally(() => { pollBusy = false })
    }
    startReceipt()
  }

  return {
    start() {
      timer = $.clock.every(1000, tick)
      // This barrier includes only local config/state/store reads, never poll,
      // claim, receipt or native history. An early append can await it safely.
      localReady = Promise.all([restoreRuntime(), initialize()]).then(() => { initialized = true })
      return localReady
    },
    ready() { return localReady ?? Promise.resolve() },
    async turnStarted(turnId: string, startedAt: number) {
      if (!id(turnId) || !milliseconds(startedAt)) return
      await recordRuntime({ status: 'running', turnId, startedAt, endedAt: null, durationMs: null, updatedAt: startedAt })
    },
    async turnCompleted(turnId: string, endedAt: number, durationMs: number, reason: string) {
      if (runtime?.status !== 'running' || runtime.turnId !== turnId ||
        !milliseconds(endedAt) || !milliseconds(durationMs)) return
      await recordRuntime({ ...runtime, status: 'idle', endedAt, durationMs, updatedAt: endedAt, reason })
    },
    stop() {
      stopped = true
      timer?.cancel()
    },
    candidate(): Active | undefined {
      const active = held?.active
      return active && (active.phase === 'dispatching' || active.phase === 'submitted' || active.phase === 'unknown') ? active : undefined
    },
    async accept(active: Active, nativeMessageId: string) {
      if (active.phase === 'claiming') return
      await change(state => {
        if (!same(state.active, active) || state.active?.phase === 'accepted' || state.active?.phase === 'rejected' ||
          state.completed.some(receipt => receipt.status === 'accepted' && receipt.nativeMessageId === nativeMessageId)) return null
        const accepted = { ...active, phase: 'accepted' as const, nativeMessageId }
        return { ...state, active: accepted, pendingReceipt: receiptFor(accepted)! }
      })
    },
  }
}

export const register: Register = on => {
  // A new, random 128-bit identity for this loaded module, never recovered from
  // state/store. The server binds a lease to it, so two copies of this plugin
  // cannot both turn an idempotent claim response into an engine action.
  const instanceId = Array.from(crypto.getRandomValues(new Uint8Array(16)),
    byte => byte.toString(16).padStart(2, '0')).join('')
  let bridge: ReturnType<typeof createBridge> | undefined
  on('session.start', async ($, e, next) => {
    // SDK/desktop sessions have isInteractive:false. Never gate on it.
    try {
      bridge?.stop()
      bridge = createBridge($, instanceId)
      await bridge.start()
    } catch {
      bridge?.stop()
    }
    return next(e)
  })
  on('session.end', ($, e, next) => {
    bridge?.stop()
    return next(e)
  })
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const owner = bridge
    const time = $.clock.now().catch(() => undefined)
    const result = await next(e)
    const startedAt = await time
    if (owner && owner === bridge && startedAt !== undefined) await owner.turnStarted(e.turnId, startedAt)
    return result
  }).catch(($, e, next) => next(e))
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const owner = bridge
    const time = $.clock.now().catch(() => undefined)
    const result = await next(e)
    const endedAt = await time
    if (owner && owner === bridge && endedAt !== undefined) {
      await owner.turnCompleted(e.turnId, endedAt, e.durationMs, e.reason)
    }
    return result
  }).catch(($, e, next) => next(e))
  on('session.append', async ($, e, next) => {
    const owner = bridge
    await owner?.ready()
    // Capture the operation AFTER local recovery, BEFORE awaiting next. Never assign an old row to a
    // newer request, even when their text is identical. One active token plus
    // engine provenance identifies the operation; text is only an extra guard.
    const active = owner?.candidate()
    const result = await next(e)
    if (owner && owner === bridge && active && observed(e, result, active)) {
      await owner.accept(active, result.uuid)
    }
    return result
  }).catch(($, e, next) => next(e))
}
