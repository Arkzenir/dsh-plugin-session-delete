// Host-half integration test for src/index.js (DSH 0.2.x APIs).
//
// Runs the real plugin module against fake services: a scratch sessions root,
// a projection-cache table, a workspace registry, a session store and an agent
// registry. It drives the registered HTTP route and the registered tool.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, 'fixtures')
const ROOT = path.join(FIXTURES, 'sessions')

// `@deepseek-ai/dsh-tools` resolves from the DSH installation in a real profile
// (two-anchor loader resolution), which a plain Node test process does not
// have, so the documented `defineTool` contract is materialized from a local
// shim for the duration of this run.
const SHIM = path.join(HERE, 'shims', 'dsh-tools')
const SHIM_TARGET = path.join(HERE, '..', 'node_modules', '@deepseek-ai', 'dsh-tools')
fs.mkdirSync(SHIM_TARGET, { recursive: true })
for (const file of ['index.js', 'package.json']) {
  fs.copyFileSync(path.join(SHIM, file), path.join(SHIM_TARGET, file))
}

const { apply, inject, name } = await import('../src/index.js')

// --- fake services -------------------------------------------------------------

function createHarness(options = {}) {
  const state = {
    routes: new Map(),
    tools: new Map(),
    calls: {
      cancel: [],
      whenIdle: 0,
      flush: [],
      detachEntered: [],
      detachedWorkspaces: [],
      unarchived: [],
      unpinned: [],
      projectionDeletes: [],
    },
  }

  const projectionRows = new Map(options.projectionRows ?? [])
  const projectionTable = {
    get: (key) => projectionRows.get(key),
    async delete(key) {
      state.calls.projectionDeletes.push(key)
      return projectionRows.delete(key)
    },
  }
  const domain = {
    table(name) {
      assert.equal(name, 'sessions', 'projection cache table name')
      return projectionTable
    },
  }

  const workspaces = options.workspaces ?? []
  const registry = {
    list: () => workspaces,
    archivedSessionIds: options.archivedSessionIds ?? [],
    pinnedSessionIds: options.pinnedSessionIds ?? [],
    async unarchiveSession(id) { state.calls.unarchived.push(id) },
    async unpinSession(id) { state.calls.unpinned.push(id) },
  }

  const sessions = {
    store: options.store ?? new Map(),
    get(id) { return this.store.get(id)?.session },
    async flush(session) { state.calls.flush.push(session.id); return true },
    detachEntered(entry) {
      state.calls.detachEntered.push(entry.id)
      this.store.delete(entry.id)
      if (options.onDetach) options.onDetach(entry)
    },
  }

  const agents = {
    get: (id) => (options.agent && options.agent.id === id ? options.agent : undefined),
  }

  const services = {
    sessionPersistence: options.persistRoot === false ? undefined : { root: ROOT },
    storageDomain: { get: (domainName) => (domainName === 'session_projcache' ? domain : undefined) },
    workspaceRegistry: registry,
    sessions,
    agents,
    webServer: {
      register(route) {
        state.routes.set(route.path, route)
        return () => state.routes.delete(route.path)
      },
    },
  }

  const registered = []
  const ctx = {
    logger: { warn() {}, info() {} },
    webServer: services.webServer,
    get(serviceName) { return services[serviceName] },
    inject(deps, callback) {
      if (deps.every((dep) => services[dep] !== undefined)) {
        registered.push(callback(ctx))
        return { then() {} }
      }
      return { then() {} }
    },
    effect(fn) { return fn() },
    tools: {
      register(definition) {
        state.tools.set(definition.name, definition)
        return () => state.tools.delete(definition.name)
      },
    },
  }

  apply(ctx)
  return { state, services, ctx }
}

function fakeRequest(method, body) {
  const listeners = new Map()
  return {
    method,
    on(event, callback) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(callback)
      return this
    },
    destroy() {},
    start() {
      const emit = (event, arg) => (listeners.get(event) ?? []).forEach((cb) => cb(arg))
      if (body !== undefined) emit('data', Buffer.from(body))
      emit('end')
    },
  }
}

function fakeResponse() {
  return {
    status: 0,
    headers: undefined,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(text) { this.body = text ?? '' },
  }
}

async function callRoute(harness, pathName, method, body) {
  const route = harness.state.routes.get(pathName)
  assert.ok(route, `route ${pathName} registered`)
  const request = fakeRequest(method, body)
  const response = fakeResponse()
  const pending = route.handler(request, response)
  request.start()
  await pending
  return { status: response.status, json: response.body ? JSON.parse(response.body) : undefined }
}

function resetSessionsRoot(sessionIds) {
  fs.rmSync(FIXTURES, { recursive: true, force: true })
  for (const id of sessionIds) {
    const dir = path.join(ROOT, '--proj-fixture--', id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), '{"type":"session"}\n')
  }
}

function sessionDirsOnDisk(sessionIds) {
  return sessionIds.filter((id) => fs.existsSync(path.join(ROOT, '--proj-fixture--', id)))
}

function workspaceEntity(record, onDetach) {
  return {
    record,
    async detachSession(id) {
      onDetach(id)
      this.record = { ...this.record, sessionIds: this.record.sessionIds.filter((entry) => entry !== id) }
    },
  }
}

// --- tests ---------------------------------------------------------------------

const tests = []
const test = (label, fn) => tests.push({ label, fn })

test('module exports the cordis plugin face', () => {
  assert.equal(typeof apply, 'function')
  assert.deepEqual(inject, ['tools'])
  assert.equal(name, 'chameleon-session-delete')
})

test('registers the delete route and the delete tool', () => {
  resetSessionsRoot(['session-abc'])
  const harness = createHarness()
  assert.ok(harness.state.routes.has('/__session-delete/delete'))
  const tool = harness.state.tools.get('workbench_session_delete')
  assert.ok(tool, 'tool registered')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['sessionId'])
  assert.equal(tool.output.schema.type, 'string')
  assert.deepEqual(tool.output.render({}, 'hi'), [{ type: 'text', text: 'hi' }])
})

test('deletes both id spellings, cache rows and workspace accounting', async () => {
  resetSessionsRoot(['session-abc', 'abc'])
  const detached = []
  const entity = workspaceEntity(
    { path: '/proj', title: 'proj', sessionIds: ['session-abc', 'keep-me'] },
    (id) => detached.push(id),
  )
  const harness = createHarness({
    projectionRows: [['session-abc', { rows: {} }], ['abc', { rows: {} }], ['other', {}]],
    workspaces: [entity],
    archivedSessionIds: ['session-abc'],
    pinnedSessionIds: ['abc'],
    store: new Map([['session-abc', { id: 'session-abc', session: { id: 'session-abc' } }]]),
  })

  const result = await callRoute(harness, '/__session-delete/delete', 'POST', JSON.stringify({ sessionId: 'session-abc' }))
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.dirRemoved, true)
  assert.equal(result.json.projRemoved, true)
  assert.equal(result.json.workspaceRemoved, true)
  assert.equal(result.json.detached, true)

  assert.deepEqual(sessionDirsOnDisk(['session-abc', 'abc']), [], 'both log directories removed')
  assert.deepEqual(harness.state.calls.projectionDeletes.sort(), ['abc', 'session-abc'])
  assert.deepEqual(detached, ['session-abc'])
  assert.deepEqual(entity.record.sessionIds, ['keep-me'])
  assert.deepEqual(harness.state.calls.unarchived, ['session-abc'])
  assert.deepEqual(harness.state.calls.unpinned, ['abc'])
  assert.deepEqual(harness.state.calls.flush, ['session-abc'])
  assert.deepEqual(harness.state.calls.detachEntered, ['session-abc'])
  assert.equal(harness.state.calls.projectionDeletes.includes('other'), false, 'unrelated row kept')
})

test('stops a running agent before deleting', async () => {
  resetSessionsRoot(['session-run'])
  const calls = []
  const agent = {
    id: 'session-run',
    status: 'running',
    cancel(cause) { calls.push(cause) },
    async whenIdle() { calls.push('idle') },
  }
  const harness = createHarness({ agent })
  const result = await callRoute(harness, '/__session-delete/delete', 'POST', JSON.stringify({ sessionId: 'session-run' }))
  assert.equal(result.status, 200)
  assert.equal(result.json.stopped, true)
  assert.deepEqual(calls, [{ kind: 'user' }, 'idle'])
})

test('settles a dispose-time log rewrite instead of leaving it behind', async () => {
  resetSessionsRoot(['session-echo'])
  const dir = path.join(ROOT, '--proj-fixture--', 'session-echo')
  const harness = createHarness({
    store: new Map([['session-echo', { id: 'session-echo', session: { id: 'session-echo' } }]]),
    // Simulate the persistence drain recreating the directory after detach.
    onDetach: () => {
      setTimeout(() => {
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), '{}\n')
      }, 5)
    },
  })
  const result = await callRoute(harness, '/__session-delete/delete', 'POST', JSON.stringify({ sessionId: 'session-echo' }))
  assert.equal(result.status, 200)
  assert.deepEqual(sessionDirsOnDisk(['session-echo']), [])
})

test('unknown session answers 404', async () => {
  resetSessionsRoot([])
  const harness = createHarness()
  const result = await callRoute(harness, '/__session-delete/delete', 'POST', JSON.stringify({ sessionId: 'session-missing' }))
  assert.equal(result.status, 404)
  assert.match(result.json.error, /session not found/)
})

test('unsafe and missing ids are rejected', async () => {
  resetSessionsRoot([])
  const harness = createHarness()
  for (const sessionId of ['../escape', 'C:\\abs', '..', '']) {
    const result = await callRoute(harness, '/__session-delete/delete', 'POST', JSON.stringify({ sessionId }))
    assert.ok(result.status === 400 || result.status === 404, `${sessionId} rejected with ${result.status}`)
  }
  const wrongMethod = await callRoute(harness, '/__session-delete/delete', 'GET')
  assert.equal(wrongMethod.status, 405)
  const badBody = await callRoute(harness, '/__session-delete/delete', 'POST', '{not json')
  assert.equal(badBody.status, 400)
})

test('the tool deletes and reports the steps', async () => {
  resetSessionsRoot(['session-tool'])
  const harness = createHarness()
  const tool = harness.state.tools.get('workbench_session_delete')
  const text = await tool.execute({ sessionId: 'session-tool' })
  assert.match(text, /deleted: session-tool/)
  assert.match(text, /log directory removed: true/)
  assert.deepEqual(sessionDirsOnDisk(['session-tool']), [])

  const missing = await tool.execute({ sessionId: 'session-absent' })
  assert.match(missing, /delete failed: session not found/)
})

test('falls back to DSH_HOME when persistence is not mounted', async () => {
  const home = path.join(FIXTURES, 'home')
  const dir = path.join(home, 'sessions', '--proj--', 'session-home')
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), '{}\n')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const harness = createHarness({ persistRoot: false })
    const result = await callRoute(harness, '/__session-delete/delete', 'POST', JSON.stringify({ sessionId: 'session-home' }))
    assert.equal(result.status, 200)
    assert.equal(fs.existsSync(dir), false)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

// --- runner ---------------------------------------------------------------------

let failed = 0
for (const { label, fn } of tests) {
  try {
    await fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${label}`)
    console.error(error)
  }
}
fs.rmSync(FIXTURES, { recursive: true, force: true })
fs.rmSync(path.join(HERE, '..', 'node_modules'), { recursive: true, force: true })
console.log(failed === 0 ? `\nall ${tests.length} host tests passed` : `\n${failed} of ${tests.length} host tests failed`)
process.exit(failed === 0 ? 0 : 1)
