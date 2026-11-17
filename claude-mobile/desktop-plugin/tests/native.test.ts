import type { On, PromptSubmitInput, PromptSubmitResult, SessionAppendInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type {
  ClaudeMobileNativeActive as Active,
  ClaudeMobileNativeJob as Job,
  ClaudeMobileNativeReceipt as Receipt,
  ClaudeMobileNativeRuntime as Runtime,
  ClaudeMobileNativeState as State,
} from '../types'

const PLUGIN = 'mobile-native-bridge'
const SESSION = 'native-session-test'
const TOKEN = 'mock_only_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const SOCKET = '/tmp/claude-mobile-test/private.sock'
const HOST_ENV = {
  CLAUDE_CODE_ENTRYPOINT: 'claude-desktop-3p',
  CLAUDE_CODE_HOST_SESSION_ID: 'local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}
const PREVIOUS_INSTANCE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const CONFIG = JSON.stringify({ version: 1, socketPath: SOCKET, token: TOKEN })
const TEXT = '原样文字\n  do not add a frame or trim me  '
const UUID1 = '11111111-1111-4111-8111-111111111111'
const UUID2 = '22222222-2222-4222-8222-222222222222'
const UUID3 = '33333333-3333-4333-8333-333333333333'
const ownOrigin = { kind: 'plugin', name: PLUGIN, asUser: true } as const
const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T
const job = (requestId: string, text = TEXT): Job => ({ requestId, sessionId: SESSION, text })
const pending = (phase: 'claiming' | 'dispatching' | 'submitted' | 'unknown' = 'dispatching'): Active => ({
  ...job('r1'), bridgeId: 'bridge-1', leaseId: 'lease-1', phase,
  ...(phase === 'claiming' ? { instanceId: PREVIOUS_INSTANCE } : { dispatchToken: 'dispatch-r1' }),
}) as Active
const unknownReceipt: Receipt = { sessionId: SESSION, requestId: 'r1', dispatchToken: 'dispatch-r1', status: 'unknown' }
const acceptedReceipt: Receipt = { ...unknownReceipt, status: 'accepted', nativeMessageId: UUID1 }
const seed = (active: Active | null, pendingReceipt: Receipt | null = null): State => ({
  version: 1, revision: 4, sessionId: SESSION, active, pendingReceipt, completed: [],
})
const acceptedActive = { ...pending(), phase: 'accepted' as const, dispatchToken: 'dispatch-r1', nativeMessageId: UUID1 }

type Wire = { body?: unknown; status?: number; raw?: string }
type Request = { path: string; body: Record<string, unknown>; at: number }
type Options = {
  config?: string | null
  env?: Record<string, string>
  saved?: unknown
  runtime?: unknown
  durable?: unknown
  failStatePhase?: string
  failStorePhase?: string
}

function fixture($: Engine, on: On, options: Options = {}) {
  const clock = mock.clock(on)
  mock.env(on, options.env ?? { HOME: '/mock/home', ...HOST_ENV })
  const requests: Request[] = []
  const submits: PromptSubmitInput[] = []
  const checkpoints: State[] = []
  const files: string[] = []
  const outputs: unknown[] = []
  const jobs: Job[] = []
  let saved = clone(options.saved)
  let runtime = clone(options.runtime)
  let runtimeVersion = runtime === undefined ? 0 : 1
  let durable = clone(options.durable)
  let stateVersion = saved === undefined ? 0 : 1
  let appends = 0
  let route: ((request: Request) => Wire | Promise<Wire | undefined> | undefined) | undefined
  let prompt: ((input: PromptSubmitInput) => PromptSubmitResult | Promise<PromptSubmitResult>) | undefined

  on('session.id', () => ({ value: SESSION }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('fs.read', (_, e) => {
    files.push(e.path)
    return options.config === null ? { deny: 'config unavailable' } : { value: options.config ?? CONFIG }
  })
  on('state.get', (_, e) => ({ value: e.key === 'runtime'
    ? { value: clone(runtime), version: runtimeVersion }
    : { value: clone(saved), version: stateVersion } }))
  on('state.set', (_, e) => {
    if (e.key === 'runtime') {
      runtime = clone(e.value)
      runtimeVersion += 1
      return { value: { isSet: true, version: runtimeVersion } }
    }
    const value = e.value as State
    if (options.failStatePhase && value.active?.phase === options.failStatePhase) return { deny: 'checkpoint unavailable' }
    saved = clone(value)
    stateVersion += 1
    checkpoints.push(clone(value))
    return { value: { isSet: true, version: stateVersion } }
  })
  on('store.get', (_, e) => {
    expect(e.key).toBe(`native-bridge-v1:${SESSION}`)
    return { value: clone(durable) }
  })
  on('store.set', (_, e) => {
    expect(e.key).toBe(`native-bridge-v1:${SESSION}`)
    if (options.failStorePhase && (e.value as State).active?.phase === options.failStorePhase) return { deny: 'durable checkpoint unavailable' }
    durable = clone(e.value)
    return { value: undefined }
  })
  on('ui.log', (_, e) => { outputs.push(e); return { value: undefined } })
  on('ui.status', (_, e) => { outputs.push(e); return { value: undefined } })
  on('http.fetch', async (_, e) => {
    expect(e.url).toMatch(/^http:\/\/claude-mobile-native\/v1\/(poll|claim|receipt)$/)
    expect(e.init?.socketPath).toBe(SOCKET)
    expect(e.init?.method).toBe('POST')
    expect(e.init?.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' })
    expect(Object.keys(e.init ?? {}).sort()).toEqual(['body', 'headers', 'method', 'socketPath'])
    const path = e.url.slice('http://claude-mobile-native'.length)
    const body = JSON.parse(e.init?.body as string) as Record<string, unknown>
    const request = { path, body, at: clock.now() }
    requests.push(clone(request))
    let wire = await route?.(request)
    if (!wire) {
      if (path === '/v1/poll') {
        expect(Object.keys(body).sort()).toEqual(body.runtime === undefined
          ? ['entrypoint', 'hostSessionId', 'instanceId', 'ready', 'sessionId']
          : ['entrypoint', 'hostSessionId', 'instanceId', 'ready', 'runtime', 'sessionId'])
        expect(body.instanceId).toMatch(/^[0-9a-f]{32}$/)
        expect(body.hostSessionId).toBe(HOST_ENV.CLAUDE_CODE_HOST_SESSION_ID)
        expect(body.entrypoint).toBe(HOST_ENV.CLAUDE_CODE_ENTRYPOINT)
        expect(body.sessionId).toBe(SESSION)
        wire = { body: { protocol: 1, bridgeId: 'bridge-1', leaseId: 'lease-1', job: body.ready ? jobs[0] ?? null : null } }
      } else if (path === '/v1/claim') {
        expect(Object.keys(body).sort()).toEqual(body.recover === true
          ? ['instanceId', 'leaseId', 'previousInstanceId', 'recover', 'requestId', 'sessionId']
          : ['instanceId', 'leaseId', 'requestId', 'sessionId'])
        expect(body.instanceId).toBe(requests.find(request => request.path === '/v1/poll')?.body.instanceId)
        if (jobs[0]?.requestId === body.requestId) jobs.shift()
        wire = { body: body.recover === true
          ? { claimed: false, terminal: 'rejected', notDispatched: true }
          : { claimed: true, dispatchToken: `dispatch-${body.requestId}` } }
      } else {
        wire = { body: { recorded: true } }
      }
    }
    const status = wire.status ?? 200
    return { value: { status, ok: status >= 200 && status < 300, headers: {}, text: wire.raw ?? JSON.stringify(wire.body) } }
  })
  on('prompt.submit', async (_, e) => {
    submits.push(clone(e))
    if (e.origin.kind === 'plugin' && e.origin.name === PLUGIN) {
      const current = saved as State
      expect(current.active?.phase).toBe('dispatching')
      expect((durable as State).active).toEqual(current.active)
    }
    return prompt ? await prompt(e) : { text: e.text, origin: e.origin }
  })
  const session = mock.session(on)
  return {
    clock, requests, submits, checkpoints, files, outputs, jobs, session,
    state: () => clone(saved) as State | undefined,
    runtime: () => clone(runtime) as Runtime | undefined,
    disk: () => clone(durable) as State | undefined,
    route(handler: NonNullable<typeof route>) { route = handler },
    prompt(handler: NonNullable<typeof prompt>) { prompt = handler },
    async start() {
      const result = await $.session.start({ cwd: '/mock/project', surface: null, isInteractive: false })
      expect(result).toEqual({ cwd: '/mock/project' })
      await clock.settle()
    },
    async tick(ms = 1000) { await clock.advance(ms) },
    append(overrides: Partial<SessionAppendInput> = {}) {
      appends += 1
      return $.session.append({
        uuid: `00000000-0000-4000-8000-${String(appends).padStart(12, '0')}`,
        door: 'prompt', origin: ownOrigin,
        message: { type: 'user', role: 'user', content: [{ type: 'text', text: TEXT }] },
        ...overrides,
      })
    },
    receipts: () => requests.filter(request => request.path === '/v1/receipt').map(request => request.body),
    polls: () => requests.filter(request => request.path === '/v1/poll'),
    claims: () => requests.filter(request => request.path === '/v1/claim'),
  }
}

test('SDK start, literal user words, durable checkpoint, observed UUID and receipt', async ($, on) => {
  const f = fixture($, on)
  f.jobs.push(job('r1'))
  await f.start()
  expect(f.files).toEqual(['/mock/home/Library/Application Support/ClaudeMobile/native-bridge.json'])
  expect(f.requests).toHaveLength(0)
  await f.tick(999)
  expect(f.requests).toHaveLength(0)
  await f.tick(1)
  expect(f.submits).toHaveLength(1)
  expect(f.submits[0]).toMatchObject({ text: TEXT, origin: ownOrigin, wait: false })
  expect(f.submits[0]?.attachments).toBeUndefined()
  expect(f.state()?.active?.phase).toBe('submitted')
  expect(f.receipts()).toEqual([])
  const result = await f.append({ uuid: UUID1 })
  expect(result).toEqual({ uuid: UUID1, message: { type: 'user', role: 'user', content: [{ type: 'text', text: TEXT }] } })
  expect(f.state()?.pendingReceipt).toEqual(acceptedReceipt)
  expect(f.disk()?.pendingReceipt).toEqual(acceptedReceipt)
  await f.tick()
  expect(f.receipts()).toEqual([acceptedReceipt])
  expect(f.state()?.active).toBeNull()
  expect(f.state()?.completed).toEqual([acceptedReceipt])
  expect(f.outputs).toEqual([])
  expect(JSON.stringify(f.state())).not.toContain(TOKEN)
  expect(JSON.stringify(f.state())).not.toContain(String(f.polls()[0]?.body.instanceId))
  expect(JSON.stringify(f.disk())).not.toContain(String(f.polls()[0]?.body.instanceId))
})

test('post-next observer ignores queue, meta, subagent and non-own user rows', async ($, on) => {
  const f = fixture($, on)
  f.jobs.push(job('r1'))
  await f.start()
  await f.tick()
  const trueUser = { type: 'user', role: 'user', content: [{ type: 'text', text: TEXT }] } as const
  const rows: Partial<SessionAppendInput>[] = [
    { door: 'queue' },
    { agentId: 'child-agent' },
    { origin: { kind: 'composer' } },
    { origin: { kind: 'plugin', name: 'other-plugin', asUser: true } },
    { origin: { kind: 'plugin', name: PLUGIN } },
    { origin: { kind: 'plugin', event: 'prompt.context' } },
    { message: { ...trueUser, content: [...trueUser.content], isMeta: true } },
    { message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: TEXT }] } },
    { message: { type: 'user', content: [{ type: 'text', text: TEXT }] } },
    { message: { ...trueUser, content: [{ type: 'text', text: 'not the pending words' }] } },
    { message: { ...trueUser, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] } },
  ]
  for (const row of rows) {
    const result = await f.append(row)
    expect(result.message).toEqual(row.message ?? trueUser)
    expect(f.state()?.pendingReceipt).toBeNull()
  }
  expect(f.session.appended()).toHaveLength(rows.length)
  await f.append({ uuid: UUID1 })
  expect(f.state()?.pendingReceipt).toEqual(acceptedReceipt)
})

test('no UUID or receipt is saved before the append has actually completed', async ($, on) => {
  const f = fixture($, on)
  on('session.append', { door: 'prompt' }, async (_, e, next) => {
    await f.clock.sleep(2000)
    return next(e)
  })
  f.jobs.push(job('r1'))
  await f.start()
  await f.tick()
  const appending = f.append({ uuid: UUID1 })
  await f.clock.settle()
  expect(f.state()?.pendingReceipt).toBeNull()
  await f.tick(2000)
  const result = await appending
  expect(result.uuid).toBe(UUID1)
  expect(f.state()?.pendingReceipt?.status === 'accepted' || f.state()?.completed[0]?.status === 'accepted').toBe(true)
})

test('heartbeats and receipt flushing continue while the sole native submit awaits idle', async ($, on) => {
  const f = fixture($, on)
  f.prompt(async e => { await f.clock.sleep(5000); return { text: e.text, origin: e.origin } })
  f.jobs.push(job('r1'), job('r2'))
  await f.start()
  await f.tick()
  expect(f.submits).toHaveLength(1)
  expect(f.state()?.active?.phase).toBe('dispatching')
  await f.append({ uuid: UUID1 })
  await f.tick(3000)
  expect(f.receipts()).toEqual([acceptedReceipt])
  expect(f.polls()).toHaveLength(4)
  expect(f.polls().slice(1).every(p => p.body.ready === false)).toBe(true)
  expect(f.submits).toHaveLength(1)
  expect(f.state()?.active?.phase).toBe('accepted')
  await f.tick(3000)
  expect(f.submits).toHaveLength(2)
  expect(f.state()?.active?.requestId).toBe('r2')
})

test('identical sequential text maps to separate request IDs; duplicate polls do not send again', async ($, on) => {
  const f = fixture($, on)
  f.jobs.push(job('r1'), job('r2'))
  await f.start()
  await f.tick()
  await f.append({ uuid: UUID1 })
  await f.tick(2000)
  expect(f.submits).toHaveLength(2)
  await f.append({ uuid: UUID1 }) // old native row cannot be reused for r2
  expect(f.state()?.pendingReceipt).toBeNull()
  await f.append({ uuid: UUID2 })
  await f.tick()
  expect(f.state()?.completed).toEqual([
    acceptedReceipt,
    { ...acceptedReceipt, requestId: 'r2', dispatchToken: 'dispatch-r2', nativeMessageId: UUID2 },
  ])
  f.jobs.push(job('r1'))
  await f.tick(4000)
  expect(f.submits).toHaveLength(2)
  expect(f.claims()).toHaveLength(2)
})

test('an old post-next continuation cannot capture a newer identical operation', async ($, on) => {
  const f = fixture($, on)
  on('session.append', { door: 'prompt' }, async (_, e, next) => {
    if (e.uuid === UUID3) await f.clock.sleep(4000)
    return next(e)
  })
  f.jobs.push(job('r1'), job('r2'))
  await f.start()
  await f.tick()
  const delayed = f.append({ uuid: UUID3 })
  await f.clock.settle()
  await f.append({ uuid: UUID1 })
  await f.tick(2000)
  expect(f.state()?.active?.requestId).toBe('r2')
  await f.tick(2000)
  await delayed
  expect(f.state()?.pendingReceipt).toBeNull()
  await f.append({ uuid: UUID2 })
  expect(f.state()?.pendingReceipt).toEqual({ ...acceptedReceipt, requestId: 'r2', dispatchToken: 'dispatch-r2', nativeMessageId: UUID2 })
})

test('a lost claim response retries the same lease, not an engine action', async ($, on) => {
  const f = fixture($, on)
  let claims = 0
  f.route(r => r.path === '/v1/claim' && ++claims === 1 ? { status: 503, body: {} } : undefined)
  f.jobs.push(job('r1'))
  await f.start()
  await f.tick()
  expect(f.state()?.active?.phase).toBe('claiming')
  expect(f.submits).toHaveLength(0)
  await f.tick(3000)
  expect(f.claims()).toHaveLength(2)
  expect(f.claims()[0]?.body).toEqual(f.claims()[1]?.body)
  expect(f.submits).toHaveLength(1)
})

test('a claiming checkpoint from a previous instance recovers terminal-only without submitting', async ($, on) => {
  const f = fixture($, on, { saved: seed(pending('claiming')) })
  await f.start()
  await f.tick()
  expect(f.claims()[0]?.body).toEqual({ sessionId: SESSION, requestId: 'r1', leaseId: 'lease-1',
    instanceId: f.polls()[0]?.body.instanceId, recover: true, previousInstanceId: PREVIOUS_INSTANCE })
  expect(f.state()?.completed).toEqual([{ sessionId: SESSION, requestId: 'r1', status: 'not-dispatched' }])
  expect(f.receipts()).toHaveLength(0)
  await f.tick(3000)
  expect(f.submits).toHaveLength(0)
})

for (const phase of ['dispatching', 'submitted'] as const) {
  test(`reload of ${phase} reports unknown without resubmitting; later native UUID can resolve it`, async ($, on) => {
    const f = fixture($, on, { saved: seed(pending(phase)) })
    f.route(r => r.path === '/v1/poll' ? { body: { protocol: 1, bridgeId: 'bridge-1', leaseId: 'lease-1', job: job('r1') } } : undefined)
    await f.start()
    await f.tick(3000)
    expect(f.submits).toHaveLength(0)
    expect(f.claims()).toHaveLength(0)
    expect(f.receipts()).toEqual([unknownReceipt])
    expect(f.polls().every(r => r.body.ready === false)).toBe(true)
    expect(f.state()?.active?.phase).toBe('unknown')
    await f.append({ uuid: UUID1 })
    await f.tick()
    expect(f.receipts()).toEqual([unknownReceipt, acceptedReceipt])
    expect(f.submits).toHaveLength(0)
  })
}

test('process restart restores the durable receipt and only retries the receipt', async ($, on) => {
  const f = fixture($, on, { durable: seed(acceptedActive, acceptedReceipt) })
  let attempts = 0
  f.route(r => r.path === '/v1/receipt' && ++attempts < 3 ? { status: 503, body: {} } : undefined)
  await f.start()
  await f.tick(3000)
  expect(f.receipts()).toEqual([acceptedReceipt, acceptedReceipt, acceptedReceipt])
  expect(f.submits).toHaveLength(0)
  expect(f.state()?.completed).toEqual([acceptedReceipt])
})

test('a receipt response must be exactly recorded:true before pending state clears', async ($, on) => {
  const f = fixture($, on, { saved: seed(acceptedActive, acceptedReceipt) })
  const invalid = [{ recorded: false }, { recorded: 'true' }, { recorded: true, guessed: true }]
  f.route(r => r.path === '/v1/receipt' && invalid.length ? { body: invalid.shift() } : undefined)
  await f.start()
  await f.tick(3000)
  expect(f.state()?.pendingReceipt).toEqual(acceptedReceipt)
  await f.tick()
  expect(f.state()?.pendingReceipt).toBeNull()
  expect(f.submits).toHaveLength(0)
})

test('unknown receipt in flight cannot clear an accepted replacement; heartbeat is independent', async ($, on) => {
  const f = fixture($, on, { saved: seed(pending('unknown'), unknownReceipt) })
  f.route(async r => {
    if (r.path === '/v1/receipt' && r.body.status === 'unknown') {
      await f.clock.sleep(3000)
      return { body: { recorded: true } }
    }
  })
  await f.start()
  await f.tick()
  await f.append({ uuid: UUID1 })
  await f.tick(2000)
  expect(f.polls()).toHaveLength(3)
  expect(f.state()?.pendingReceipt).toEqual(acceptedReceipt)
  await f.tick(2000)
  expect(f.receipts()).toEqual([unknownReceipt, acceptedReceipt])
  expect(f.state()?.completed).toEqual([acceptedReceipt])
})

test('explicit native drop is rejected with a fixed reason, without leaking its body', async ($, on) => {
  const f = fixture($, on)
  f.prompt(() => ({ drop: `private reason ${TEXT} ${TOKEN}` }))
  f.jobs.push(job('r1'))
  await f.start()
  await f.tick(2000)
  expect(f.receipts()).toEqual([{ ...unknownReceipt, status: 'rejected', reason: 'native-prompt-dropped' }])
  expect(f.state()?.active).toBeNull()
  expect(f.outputs).toEqual([])
  expect(JSON.stringify(f.receipts())).not.toContain(TEXT)
  expect(JSON.stringify(f.receipts())).not.toContain(TOKEN)
})

test('a thrown native error is unknown, never an explicit rejection or replay', async ($, on) => {
  const f = fixture($, on)
  f.prompt(() => { throw new Error(`private error ${TEXT} ${TOKEN}`) })
  f.jobs.push(job('r1'), job('r2'))
  await f.start()
  await f.tick(5000)
  expect(f.receipts()).toEqual([unknownReceipt])
  expect(f.state()?.active?.phase).toBe('unknown')
  expect(f.submits).toHaveLength(1)
  expect(f.outputs).toEqual([])
})

for (const sink of ['Store', 'State'] as const) {
  test(`failure of the ${sink} dispatch checkpoint prevents the engine action`, async ($, on) => {
    const f = fixture($, on, { [`fail${sink}Phase`]: 'dispatching' })
    f.jobs.push(job('r1'))
    await f.start()
    await f.tick(3000)
    expect(f.submits).toHaveLength(0)
    expect(f.receipts()).toHaveLength(0)
    expect(f.polls().slice(1).every(r => r.body.ready === false)).toBe(true)
  })
}

test('restart after a durable dispatch checkpoint but before its state mirror never submits', async ($, on) => {
  const older = { ...seed(pending('claiming')), revision: 3 }
  const f = fixture($, on, { saved: older, durable: seed(pending()) })
  await f.start()
  await f.tick()
  expect(f.receipts()).toEqual([unknownReceipt])
  expect(f.submits).toHaveLength(0)
})

for (const [index, config] of [null, '{broken', '{}', JSON.stringify({ version: 2, socketPath: SOCKET, token: TOKEN }),
  JSON.stringify({ version: 1, socketPath: 'relative.sock', token: TOKEN }),
  JSON.stringify({ version: 1, socketPath: SOCKET, token: 'short' })].entries()) {
  test(`missing or invalid config disables only the bridge (case ${index + 1})`, async ($, on) => {
    const f = fixture($, on, { config })
    await f.start()
    await f.tick(3000)
    expect(f.requests).toHaveLength(0)
    expect(f.submits).toHaveLength(0)
    expect(f.checkpoints).toHaveLength(0)
    const row = await f.append({ origin: { kind: 'composer' }, uuid: UUID1 })
    expect(row.uuid).toBe(UUID1)
    expect(row.message?.content).toEqual([{ type: 'text', text: TEXT }])
    const ordinary = await $.prompt.submit({ text: TEXT, wait: false, origin: { kind: 'composer' } })
    expect(ordinary).toEqual({ text: TEXT, origin: { kind: 'composer' } })
    expect(f.outputs).toEqual([])
  })
}

test('literal config override is used without reading HOME or falling back', async ($, on) => {
  const f = fixture($, on, { env: { ...HOST_ENV, CLM_NATIVE_CONFIG: '/mock/custom.json' } })
  await f.start()
  expect(f.files).toEqual(['/mock/custom.json'])
  await f.tick()
  expect(f.polls()).toHaveLength(1)
})

test('an explicitly empty override disables instead of using the default config', async ($, on) => {
  const f = fixture($, on, { env: { CLM_NATIVE_CONFIG: '', HOME: '/mock/home' } })
  await f.start()
  await f.tick()
  expect(f.files).toHaveLength(0)
  expect(f.requests).toHaveLength(0)
})

test('unrecognized persisted state fails closed without erasing it', async ($, on) => {
  const invalid = { version: 99, secret: 'not printed' }
  const f = fixture($, on, { saved: invalid })
  await f.start()
  await f.tick()
  expect(f.state()).toEqual(invalid)
  expect(f.polls()[0]?.body.ready).toBe(false)
  expect(f.submits).toHaveLength(0)
  expect(f.outputs).toEqual([])
})

test('poll and claim accept only v1 exact schemas and the current session', async ($, on) => {
  const f = fixture($, on)
  const invalid = [
    { protocol: 2, bridgeId: 'bridge-1', leaseId: 'lease-1', job: job('r1') },
    { protocol: 1, bridgeId: 'bridge-1', leaseId: 'lease-1', job: { ...job('r1'), sessionId: 'other-session' } },
    { protocol: 1, bridgeId: 'bridge-1', leaseId: 'lease-1', job: { ...job('r1'), attachments: [] } },
    { protocol: 1, bridgeId: 'bridge-1', leaseId: 'lease-1', job: job('r1'), guessed: true },
  ]
  let invalidClaim = true
  f.route(r => {
    if (r.path === '/v1/poll' && invalid.length) return { body: invalid.shift() }
    if (r.path === '/v1/claim' && invalidClaim) return { body: { claimed: true, dispatchToken: 'dispatch-r1', guessed: true } }
  })
  f.jobs.push(job('r1'))
  await f.start()
  await f.tick(6000)
  expect(f.submits).toHaveLength(0)
  invalidClaim = false
  await f.tick()
  expect(f.submits).toHaveLength(1)
})

test('a failed observer checkpoint still returns the original append and never forges acceptance', async ($, on) => {
  const f = fixture($, on, { failStorePhase: 'accepted' })
  f.jobs.push(job('r1'))
  await f.start()
  await f.tick()
  const result = await f.append({ uuid: UUID1 })
  expect(result).toEqual({ uuid: UUID1, message: { type: 'user', role: 'user', content: [{ type: 'text', text: TEXT }] } })
  await f.tick(3000)
  expect(f.receipts()).toHaveLength(0)
  expect(f.submits).toHaveLength(1)
  expect(f.polls().slice(1).every(r => r.body.ready === false)).toBe(true)
})

test('runtime starts at the actual main turn event and ends with the native duration', async ($, on) => {
  const f = fixture($, on)
  f.jobs.push(job('r1'))
  await f.start()
  await f.tick()
  expect(f.submits).toHaveLength(1)
  expect(f.runtime()).toBeUndefined()
  expect(f.polls()[0]?.body.runtime).toBeUndefined()
  await f.clock.advance(750)
  const started = await $.turn.start({ turnId: 'turn-actual', text: TEXT })
  expect(started).toEqual({ turnId: 'turn-actual' })
  const running: Runtime = { status: 'running', turnId: 'turn-actual', startedAt: 1750, endedAt: null, durationMs: null, updatedAt: 1750 }
  expect(f.runtime()).toEqual(running)
  await f.tick()
  expect(f.polls().at(-1)?.body.runtime).toEqual(running)
  await f.clock.advance(250)
  const finished = await $.turn.complete({ turnId: 'turn-actual', answer: 'unchanged native answer', durationMs: 917, isAborted: false, reason: 'answer' })
  expect(finished).toEqual({ text: 'unchanged native answer' })
  const idle: Runtime = { ...running, status: 'idle', endedAt: 3000, durationMs: 917, updatedAt: 3000, reason: 'answer' }
  expect(f.runtime()).toEqual(idle)
  await f.tick()
  expect(f.polls().at(-1)?.body.runtime).toEqual(idle)
  expect(JSON.stringify(f.runtime())).not.toContain(TEXT)
  expect(JSON.stringify(f.runtime())).not.toContain('unchanged native answer')
  expect(JSON.stringify(f.disk())).not.toContain('turn-actual')
  expect(Object.keys(f.disk() ?? {}).sort()).toEqual(['active', 'completed', 'pendingReceipt', 'revision', 'sessionId', 'version'])
})

test('subagent starts and completions never create or replace main runtime', async ($, on) => {
  const f = fixture($, on)
  await f.start()
  await $.turn.start({ turnId: 'child-turn', text: 'child', agentId: 'child-agent' })
  await $.turn.complete({ turnId: 'child-turn', answer: '', durationMs: 10, isAborted: false, reason: 'answer', agentId: 'child-agent' })
  await f.tick()
  expect(f.runtime()).toBeUndefined()
  expect(f.polls()[0]?.body.runtime).toBeUndefined()
  await $.turn.start({ turnId: 'main-turn', text: TEXT })
  const running = f.runtime()
  await $.turn.start({ turnId: 'other-child', text: '', agentId: 'child-agent' })
  await $.turn.complete({ turnId: 'main-turn', answer: '', durationMs: 20, isAborted: false, reason: 'answer', agentId: 'child-agent' })
  expect(f.runtime()).toEqual(running)
})

test('completion for an older turn cannot overwrite the current running turn', async ($, on) => {
  const f = fixture($, on)
  await f.start()
  await $.turn.start({ turnId: 'old-turn', text: TEXT })
  await f.tick()
  await $.turn.start({ turnId: 'current-turn', text: TEXT })
  const current = f.runtime()
  await $.turn.complete({ turnId: 'old-turn', answer: '', durationMs: 5, isAborted: false, reason: 'answer' })
  expect(f.runtime()).toEqual(current)
  await f.tick()
  expect(f.polls().at(-1)?.body.runtime).toEqual(current)
  await $.turn.complete({ turnId: 'current-turn', answer: '', durationMs: 123, isAborted: true, reason: 'aborted' })
  expect(f.runtime()).toEqual({ ...current, status: 'idle', endedAt: 2000, durationMs: 123, updatedAt: 2000, reason: 'aborted' })
})

test('hot reload preserves an observed start instead of inventing a new running time', async ($, on) => {
  const f = fixture($, on)
  await f.start()
  await f.tick(2000)
  await $.turn.start({ turnId: 'retained-turn', text: TEXT })
  const beforeReload = f.runtime()
  await f.tick(3000)
  await f.start() // a reload re-runs register/session.start; the session state stays
  await f.tick()
  expect(f.runtime()).toEqual(beforeReload)
  expect(f.polls().at(-1)?.body.runtime).toEqual(beforeReload)
  expect(f.runtime()?.startedAt).toBe(2000)
  expect(JSON.stringify(f.disk())).not.toContain('retained-turn')
})

test('a process restart never restores running from the durable bridge checkpoint', async ($, on) => {
  const f = fixture($, on, { durable: seed(pending('submitted')) })
  await f.start()
  await f.tick(2000)
  expect(f.runtime()).toBeUndefined()
  expect(f.polls().every(request => request.body.runtime === undefined)).toBe(true)
  // An end without a matching observed start cannot fabricate a startedAt.
  await $.turn.complete({ turnId: 'old-process-turn', answer: '', durationMs: 9999, isAborted: false, reason: 'error' })
  await f.tick()
  expect(f.runtime()).toBeUndefined()
  expect(f.polls().at(-1)?.body.runtime).toBeUndefined()
  await $.turn.start({ turnId: 'fresh-turn', text: TEXT })
  expect(f.runtime()?.startedAt).toBe(3000)
  await f.tick()
  expect(f.polls().at(-1)?.body.runtime).toEqual(f.runtime())
  expect(f.submits).toHaveLength(0)
})

test('an invalid runtime snapshot is omitted rather than converted into a fake start', async ($, on) => {
  const f = fixture($, on, { runtime: { status: 'running', turnId: 'ghost-turn', startedAt: null } })
  await f.start()
  await f.tick()
  expect(f.polls()[0]?.body.runtime).toBeUndefined()
  await $.turn.start({ turnId: 'observed-turn', text: TEXT })
  await f.tick()
  expect(f.polls().at(-1)?.body.runtime).toEqual({ status: 'running', turnId: 'observed-turn', startedAt: 1000, endedAt: null, durationMs: null, updatedAt: 1000 })
})

test('session end cancels polling without altering the native session result', async ($, on) => {
  const f = fixture($, on)
  await f.start()
  await f.tick()
  const ended = await $.session.end({ reason: 'clear', sessionId: SESSION, resume: { id: SESSION } })
  expect(ended).toEqual({ sessionId: SESSION })
  await f.tick(4000)
  expect(f.polls()).toHaveLength(1)
  expect(f.submits).toHaveLength(0)
})
