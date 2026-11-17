// Reuses the independent auditor's register/Map/deferred mock structure.
// Runs the actual client with Node's type stripping. No socket, disk ledger,
// application, native history or real prompt is used in these regressions.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { register } from '../hooks/register.ts'

const SESSION = '11111111-1111-4111-8111-111111111111'
const HOST = 'local_22222222-2222-4222-8222-222222222222'
const ENTRYPOINT = 'claude-desktop-3p'
const NATIVE_ID = '33333333-3333-4333-8333-333333333333'
const OLD_INSTANCE = '44444444444444444444444444444444'
const STORE_KEY = `native-bridge-v1:${SESSION}`
const clone = value => value === undefined ? undefined : structuredClone(value)
const drain = async () => { for (let i = 0; i < 40; i++) await new Promise(setImmediate) }
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const fail = () => { throw Object.assign(new Error('mock rejection'), { statusCode: 409 }) }
const row = () => ({ door: 'prompt', origin: { kind: 'plugin', name: 'mobile-native-bridge', asUser: true },
  uuid: NATIVE_ID, message: { type: 'user', role: 'user', isMeta: false, content: [{ type: 'text', text: 'first' }] } })
const stored = (phase, instanceId) => ({ version: 1, revision: 2, sessionId: SESSION,
  active: { requestId: 'r1', sessionId: SESSION, text: 'first', bridgeId: 'old-bridge', leaseId: 'old-lease', phase,
    ...(phase === 'claiming' ? { instanceId } : { dispatchToken: 'dispatch-r1' }) },
  pendingReceipt: null, completed: [] })

let generation = 0
function broker({ ledger = new Map(), queued = [], recoveryReply } = {}) {
  const bridgeId = `bridge-${++generation}`
  const leaseId = `lease-${generation}`
  let instance
  let onClaimCount = 0
  return {
    ledger, queued, bridgeId, leaseId,
    claims: () => onClaimCount,
    instance: () => instance,
    async request(path, body) {
      if (body.sessionId !== SESSION) fail()
      if (path === '/v1/poll') {
        assert.deepEqual(Object.keys(body).sort(), body.runtime === undefined
          ? ['entrypoint', 'hostSessionId', 'instanceId', 'ready', 'sessionId']
          : ['entrypoint', 'hostSessionId', 'instanceId', 'ready', 'runtime', 'sessionId'])
        assert.match(body.instanceId, /^[0-9a-f]{32}$/)
        if (body.hostSessionId !== HOST || body.entrypoint !== ENTRYPOINT) fail()
        instance ??= body.instanceId
        if (instance !== body.instanceId) fail()
        return { protocol: 1, bridgeId, leaseId, job: body.ready ? queued[0] ?? null : null }
      }
      if (path === '/v1/claim') {
        assert.deepEqual(Object.keys(body).sort(), body.recover === true
          ? ['instanceId', 'leaseId', 'previousInstanceId', 'recover', 'requestId', 'sessionId']
          : ['instanceId', 'leaseId', 'requestId', 'sessionId'])
        if (instance !== body.instanceId || body.leaseId !== leaseId) fail()
        const previous = ledger.get(body.requestId)
        if (body.recover === true) {
          if (recoveryReply) return recoveryReply(body)
          if (previous?.instanceId && previous.instanceId !== body.previousInstanceId) fail()
          if (previous?.nativeMessageId) return { claimed: false, terminal: 'accepted', nativeMessageId: previous.nativeMessageId, dispatchToken: previous.dispatchToken }
          ledger.set(body.requestId, { ...previous, status: 'not-dispatched' })
          const index = queued.findIndex(job => job.requestId === body.requestId)
          if (index >= 0) queued.splice(index, 1)
          return { claimed: false, terminal: 'rejected', notDispatched: true }
        }
        if (previous?.dispatchToken) {
          if (previous.instanceId !== body.instanceId || previous.leaseId !== body.leaseId || previous.status !== 'dispatched') fail()
          return { claimed: true, dispatchToken: previous.dispatchToken }
        }
        const index = queued.findIndex(job => job.requestId === body.requestId)
        if (index < 0) fail()
        queued.splice(index, 1)
        const dispatchToken = `dispatch-${body.requestId}`
        ledger.set(body.requestId, { status: 'dispatched', dispatchToken, leaseId, instanceId: body.instanceId })
        onClaimCount++
        return { claimed: true, dispatchToken }
      }
      assert.equal(path, '/v1/receipt')
      const previous = ledger.get(body.requestId)
      if (!previous || previous.dispatchToken !== body.dispatchToken) fail()
      if (body.status === 'accepted') ledger.set(body.requestId, { ...previous, status: 'accepted', nativeMessageId: body.nativeMessageId })
      return { recorded: true }
    },
  }
}

function client({ bridgeRef, store = new Map(), state = new Map(), getGate, afterResponse, env } = {}) {
  const hooks = new Map()
  const submits = [], requests = [], writes = [], envReads = []
  let tick = () => {}
  register((name, fn) => { hooks.set(name, fn); return { catch() { return this } } })
  const variables = env ?? { CLM_NATIVE_CONFIG: '/mock/native.json', CLAUDE_CODE_ENTRYPOINT: ENTRYPOINT, CLAUDE_CODE_HOST_SESSION_ID: HOST }
  const $ = {
    env: { get: async name => { envReads.push(name); return variables[name] } },
    fs: { read: async () => JSON.stringify({ version: 1, socketPath: '/mock/native.sock', token: 'a'.repeat(43) }) },
    session: { id: async () => SESSION },
    store: {
      get: async key => { if (getGate) await getGate(); return clone(store.get(key)) },
      set: async (key, value) => { writes.push(clone(value)); store.set(key, clone(value)) },
    },
    state: {
      get: async ref => ({ value: clone(state.get(ref.key)), version: 0 }),
      set: async (ref, value) => { state.set(ref.key, clone(value)); return { isSet: true, version: 1 } },
    },
    clock: {
      every: (ms, fn) => { assert.equal(ms, 1000); let cancelled = false; tick = () => { if (!cancelled) fn() }; return { cancel() { cancelled = true } } },
      now: async () => Date.now(),
    },
    http: { fetch: async (url, init) => {
      assert.equal(init.socketPath, '/mock/native.sock')
      assert.equal(init.method, 'POST')
      assert.equal(new URL(url).origin, 'http://claude-mobile-native')
      const body = JSON.parse(init.body), path = new URL(url).pathname
      const request = { path, body }
      requests.push(request)
      try {
        const result = await bridgeRef.value.request(path, body)
        if (afterResponse) await afterResponse(path, body, result)
        request.status = 200
        return { status: 200, ok: true, headers: {}, text: JSON.stringify(result) }
      } catch (error) {
        request.status = error.statusCode ?? 503
        return { status: request.status, ok: false, headers: {}, text: '{}' }
      }
    } },
    prompt: { submit: async args => {
      assert.deepEqual(Object.keys(args).sort(), ['asUser', 'text'])
      assert.equal(args.asUser, true)
      assert.equal(state.get('bridge')?.active?.phase, 'dispatching')
      submits.push(args)
      return new Promise(() => {}) // a native submit can wait idle indefinitely
    } },
  }
  return { state, store, submits, requests, writes, envReads,
    start: () => hooks.get('session.start')($, { cwd: '/mock', surface: null, isInteractive: false }, async e => ({ cwd: e.cwd })),
    tick: () => tick(),
    stop: () => hooks.get('session.end')($, { reason: 'other', sessionId: SESSION, resume: { id: SESSION } }, async e => ({ sessionId: e.sessionId })),
    append: (event, next) => hooks.get('session.append')($, event, next),
  }
}
const job = (requestId, text) => ({ requestId, sessionId: SESSION, text })
const posts = (c, path) => c.requests.filter(request => request.path === path)
const tickAll = async (...clients) => { clients.forEach(c => c.tick()); await drain() }

test('two loaded instances share session/store: one lease owner, exactly one native submit', async () => {
  const bridgeRef = { value: broker({ queued: [job('r1', 'first')] }) }
  const store = new Map()
  const a = client({ bridgeRef, store }), b = client({ bridgeRef, store })
  try {
    await Promise.all([a.start(), b.start()])
    assert.equal(a.writes.length + b.writes.length, 0, 'local initialization is read-only')
    for (let i = 0; i < 5; i++) await tickAll(a, b)
    const idA = posts(a, '/v1/poll')[0].body.instanceId
    const idB = posts(b, '/v1/poll')[0].body.instanceId
    assert.notEqual(idA, idB, 'each register invocation generates a fresh identity')
    assert.equal(a.submits.length + b.submits.length, 1)
    assert.equal(bridgeRef.value.claims(), 1)
    const loser = a.submits.length ? b : a
    assert.equal(loser.writes.length, 0, 'a non-admitted stale held copy must not overwrite the owner')
    assert.equal(posts(loser, '/v1/claim').length, 0)
    assert.ok(posts(loser, '/v1/poll').every(request => request.status === 409))
  } finally { await a.stop(); await b.stop() }
})

test('an append during local restore waits for that restore, never for a network grant', async () => {
  const entered = deferred(), release = deferred()
  const ledger = new Map([['r1', { status: 'dispatched', dispatchToken: 'dispatch-r1', instanceId: OLD_INSTANCE }]])
  const bridgeRef = { value: broker({ ledger }) }
  const store = new Map([[STORE_KEY, stored('submitted')]])
  const c = client({ bridgeRef, store, getGate: async () => { entered.resolve(); await release.promise } })
  let startFinished = false, nextCalls = 0
  const startPromise = c.start().then(() => { startFinished = true })
  await entered.promise
  const appendPromise = c.append(row(), async e => { nextCalls++; return { uuid: e.uuid, message: e.message } })
  try {
    await drain()
    assert.equal(startFinished, false)
    assert.equal(nextCalls, 0)
    assert.equal(c.requests.length, 0)
    assert.equal(c.writes.length, 0)
    release.resolve()
    await startPromise
    assert.equal((await appendPromise).uuid, NATIVE_ID)
    assert.equal(nextCalls, 1)
    assert.equal(c.requests.length, 0, 'append finishes before polling or checking native history')
    assert.equal(c.writes.length, 0, 'early UUID stays buffered until admitted')
    await tickAll(c)
    assert.equal(c.submits.length, 0)
    assert.deepEqual(posts(c, '/v1/receipt').map(request => request.body), [{ sessionId: SESSION, requestId: 'r1', dispatchToken: 'dispatch-r1', status: 'accepted', nativeMessageId: NATIVE_ID }])
    assert.equal(c.state.get('bridge').completed[0].nativeMessageId, NATIVE_ID)
  } finally { release.resolve(); await c.stop() }
})

test('lost claim ACK plus gateway restart cancels only the unsent claim and releases the next job', async () => {
  const ledger = new Map()
  const bridgeRef = { value: broker({ ledger, queued: [job('r1', 'first')] }) }
  let lostAck = false
  const c = client({ bridgeRef, afterResponse: async (path, body) => {
    if (path === '/v1/claim' && !body.recover && !lostAck) { lostAck = true; throw new Error('simulated lost response') }
  } })
  try {
    await c.start()
    await tickAll(c)
    assert.equal(lostAck, true)
    assert.equal(c.submits.length, 0)
    assert.equal(c.state.get('bridge').active.phase, 'claiming')
    const old = clone(c.state.get('bridge').active)
    bridgeRef.value = broker({ ledger, queued: [job('r2', 'second')] })
    for (let i = 0; i < 5; i++) await tickAll(c)
    const recovery = posts(c, '/v1/claim').find(request => request.body.recover)
    assert.deepEqual(recovery.body, { sessionId: SESSION, requestId: 'r1', instanceId: old.instanceId,
      leaseId: bridgeRef.value.leaseId, recover: true, previousInstanceId: old.instanceId })
    assert.equal(posts(c, '/v1/poll').find(request => request.body.ready === false)?.status, 200)
    assert.deepEqual(c.state.get('bridge').completed, [{ sessionId: SESSION, requestId: 'r1', status: 'not-dispatched' }])
    assert.deepEqual(c.submits, [{ text: 'second', asUser: true }])
    assert.equal(posts(c, '/v1/receipt').length, 0, 'no dispatchToken or rejection receipt is fabricated')
    assert.equal(ledger.get('r1').status, 'not-dispatched')
    assert.equal(ledger.get('r2').status, 'dispatched')
  } finally { await c.stop() }
})

test('recovery can learn an already recorded native UUID without submitting or sending a new receipt', async () => {
  const ledger = new Map([['r1', { status: 'accepted', instanceId: OLD_INSTANCE, dispatchToken: 'dispatch-r1', nativeMessageId: NATIVE_ID }]])
  const bridgeRef = { value: broker({ ledger }) }
  const c = client({ bridgeRef, store: new Map([[STORE_KEY, stored('claiming', OLD_INSTANCE)]]) })
  try {
    await c.start()
    await tickAll(c)
    assert.notEqual(posts(c, '/v1/poll')[0].body.instanceId, OLD_INSTANCE)
    assert.equal(posts(c, '/v1/claim')[0].body.previousInstanceId, OLD_INSTANCE)
    assert.equal(c.submits.length, 0)
    assert.equal(posts(c, '/v1/receipt').length, 0)
    assert.deepEqual(c.state.get('bridge').completed, [{ sessionId: SESSION, requestId: 'r1', status: 'accepted', nativeMessageId: NATIVE_ID, dispatchToken: 'dispatch-r1' }])
  } finally { await c.stop() }
})

test('recover:true never turns claimed:true into execution authorization', async () => {
  const bridgeRef = { value: broker({ recoveryReply: () => ({ claimed: true, dispatchToken: 'dispatch-r1' }) }) }
  const c = client({ bridgeRef, store: new Map([[STORE_KEY, stored('claiming', OLD_INSTANCE)]]) })
  try {
    await c.start()
    for (let i = 0; i < 3; i++) await tickAll(c)
    assert.equal(c.submits.length, 0)
    assert.equal(c.state.get('bridge').active.phase, 'claiming')
    assert.ok(posts(c, '/v1/claim').every(request => request.body.recover === true))
  } finally { await c.stop() }
})

for (const phase of ['dispatching', 'submitted', 'unknown']) {
  test(`${phase} checkpoint never takes the not-dispatched recovery path after a new load`, async () => {
    const ledger = new Map([['r1', { status: 'dispatched', dispatchToken: 'dispatch-r1', instanceId: OLD_INSTANCE }]])
    const bridgeRef = { value: broker({ ledger, queued: [job('r2', 'second')] }) }
    const c = client({ bridgeRef, store: new Map([[STORE_KEY, stored(phase)]]) })
    try {
      await c.start()
      for (let i = 0; i < 3; i++) await tickAll(c)
      assert.equal(c.submits.length, 0)
      assert.equal(posts(c, '/v1/claim').length, 0)
      assert.ok(posts(c, '/v1/poll').every(request => request.body.ready === false))
      assert.notEqual(posts(c, '/v1/poll')[0].body.instanceId, OLD_INSTANCE)
    } finally { await c.stop() }
  })
}

test('missing host identity disables polling; an incorrect actual host is never replaced with a guessed one', async () => {
  const bridgeRef = { value: broker({ queued: [job('r1', 'first')] }) }
  const missing = client({ bridgeRef, env: { CLM_NATIVE_CONFIG: '/mock/native.json' } })
  const wrong = client({ bridgeRef, env: { CLM_NATIVE_CONFIG: '/mock/native.json', CLAUDE_CODE_HOST_SESSION_ID: 'actual-but-wrong-host', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' } })
  try {
    await Promise.all([missing.start(), wrong.start()])
    await tickAll(missing, wrong)
    assert.equal(missing.requests.length, 0)
    assert.equal(wrong.requests[0].body.hostSessionId, 'actual-but-wrong-host')
    assert.equal(wrong.requests[0].body.entrypoint, 'sdk-ts')
    assert.equal(wrong.requests[0].status, 409)
    assert.equal(wrong.writes.length + missing.writes.length, 0)
    assert.equal(wrong.submits.length + missing.submits.length, 0)
    assert.ok(wrong.envReads.includes('CLAUDE_CODE_ENTRYPOINT'))
    assert.ok(wrong.envReads.includes('CLAUDE_CODE_HOST_SESSION_ID'))
  } finally { await missing.stop(); await wrong.stop() }
})
