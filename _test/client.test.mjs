// Client-half test for src/client.js.
//
// The bundle is a classic script that registers a factory on
// window.__ModuleLoader__, so it is evaluated in a VM context with a stubbed
// loader, React, and the shared primitives. Every registered slot entry is then
// rendered as a plain function call and its element tree inspected, and the
// injected delete flow is driven against a stubbed fetch.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = fs.readFileSync(path.join(HERE, '..', 'src', 'client.js'), 'utf8')

const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
const HEADER_SLOT = 'conversation.session.header.actions'
const OVERLAY_SLOT = 'shell.overlay'
const PACKAGE_ID = '@arkzenir/dsh-plugin-session-delete'

// --- stubs ---------------------------------------------------------------------

function createReact() {
  const hooks = []
  return {
    hooks,
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() }
    },
    useCallback(fn) {
      hooks.push('useCallback')
      return fn
    },
    useState(initial) {
      hooks.push('useState')
      return [initial, () => {}]
    },
  }
}

function createPrimitives() {
  // The real primitives are components; here each one is its display name so a
  // rendered element can be identified by `type`.
  return {
    Button: 'Button',
    IconTrashOutlineRegular: 'IconTrashOutlineRegular',
    MenuItemButton: 'MenuItemButton',
    Modal: 'Modal',
  }
}

function loadBundle(options = {}) {
  const React = createReact()
  const primitives = createPrimitives()
  const registrations = []
  let registration
  const sandbox = {
    console,
    navigator: options.navigator ?? { languages: ['en-US'], language: 'en-US' },
    fetch: (...args) => options.fetch(...args),
    window: {
      __ModuleLoader__: {
        load(record) { registration = record },
      },
    },
    require(specifier) {
      if (specifier === 'react') return React
      if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
      throw new Error(`unexpected require: ${specifier}`)
    },
  }
  vm.runInNewContext(SOURCE, sandbox, { filename: 'client.js' })
  assert.ok(registration, 'bundle registered a module')
  return { registration, React, primitives }
}

function createClientContext(options = {}) {
  const services = options.services ?? {}
  const registered = []
  const ctx = {
    logger: { warn() {}, info() {} },
    get(name) { return services[name] },
    effect(fn) { return fn() },
    slots: {
      inject(slot, callback) {
        const disposer = callback()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      register(spec, component) {
        registered.push({ spec, component })
        return () => {}
      },
    },
  }
  return { ctx, registered }
}

function findEntry(registered, slotName) {
  return registered.find((entry) => entry.spec.name === slotName)
}

const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object') return (node.children ?? []).map(textOf).join('')
  return ''
}

const findAll = (node, predicate, out = []) => {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, out); return out }
  if (typeof node !== 'object') return out
  if (node.type !== undefined && predicate(node)) out.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, out)
  return out
}

// --- tests ---------------------------------------------------------------------

const tests = []
const test = (label, fn) => tests.push({ label, fn })

test('bundle registers one module under the package name and returns the plugin face', () => {
  const { registration } = loadBundle()
  assert.equal(registration.id, PACKAGE_ID)
  const plugin = registration.factory((specifier) => {
    if (specifier === 'react') return createReact()
    return createPrimitives()
  })
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual([...plugin.inject], ['slots'])
})

test('apply registers the session-row menu row, the header button and one overlay dialog', () => {
  const { registration } = loadBundle()
  const plugin = registration.factory((specifier) => (specifier === 'react' ? createReact() : createPrimitives()))
  const { ctx, registered } = createClientContext()
  plugin.apply(ctx)

  const menu = findEntry(registered, MENU_SLOT)
  const header = findEntry(registered, HEADER_SLOT)
  const overlay = findEntry(registered, OVERLAY_SLOT)
  assert.ok(menu && header && overlay, 'all three slots registered')
  assert.equal(menu.spec.id, 'session-delete')
  assert.equal(menu.spec.order, 500, 'after archive(400) and session-id(450)')
  assert.equal(header.spec.id, 'session-delete')
  assert.equal(header.spec.order, 30)
  assert.equal(overlay.spec.id, 'session-delete-dialog')
  for (const entry of [menu, header, overlay]) {
    assert.equal(entry.spec.name, entry.spec.name)
    assert.equal(typeof entry.spec.inject, 'function')
    assert.equal(entry.spec.locale, undefined, 'no locale seat without the service')
  }
})

test('the menu row renders the host menu component and dismisses the menu', () => {
  const requests = []
  const closed = []
  const { registration } = loadBundle()
  const plugin = registration.factory((specifier) => (specifier === 'react' ? createReact() : createPrimitives()))
  const { ctx, registered } = createClientContext()
  plugin.apply(ctx)
  const injectProps = findEntry(registered, MENU_SLOT).spec.inject()

  const element = findEntry(registered, MENU_SLOT).component({
    sessionId: 'session-x',
    displayTitle: 'Chat about things',
    useMenuOpenState: () => [true, (open) => closed.push(open)],
    useShortcuts: () => undefined,
    ...injectProps,
  })
  assert.equal(element.type, 'MenuItemButton')
  assert.equal(element.props.danger, true)
  assert.equal(element.props.separatorBefore, true)
  assert.equal(element.props.icon.type, 'IconTrashOutlineRegular')
  assert.equal(textOf(element), 'Delete session')
  element.props.onSelect()
  assert.deepEqual(closed, [false], 'menu closes before the dialog opens')
})

test('the header button reflects the running state and requests the session id', () => {
  const { registration } = loadBundle()
  const plugin = registration.factory((specifier) => (specifier === 'react' ? createReact() : createPrimitives()))
  const { ctx, registered } = createClientContext()
  plugin.apply(ctx)
  const props = findEntry(registered, HEADER_SLOT).spec.inject()
  const requested = []
  const requestDelete = (id) => requested.push(id)

  const runningSnapshot = { byId: { 'session-x': { running: true } } }
  const runningButton = findEntry(registered, HEADER_SLOT).component({
    sessionId: 'session-x',
    useSessions: (selector) => selector(runningSnapshot),
    ...props,
    requestDelete,
  })
  assert.equal(runningButton.type, 'button')
  assert.equal(runningButton.props.title, 'Delete session (running — deleting will stop the task)')
  assert.equal(runningButton.props['aria-label'], 'Delete session')
  runningButton.props.onClick()
  assert.deepEqual(requested, ['session-x'])

  const idleButton = findEntry(registered, HEADER_SLOT).component({
    sessionId: 'session-y',
    useSessions: (selector) => selector({ byId: {} }),
    ...props,
    requestDelete,
  })
  assert.equal(idleButton.props.title, 'Delete session')
})

test('the dialog stays closed without a request and opens with consent gating', () => {
  const { registration } = loadBundle()
  const plugin = registration.factory((specifier) => (specifier === 'react' ? createReact() : createPrimitives()))
  const { ctx, registered } = createClientContext()
  plugin.apply(ctx)
  const injectProps = findEntry(registered, OVERLAY_SLOT).spec.inject()
  const component = findEntry(registered, OVERLAY_SLOT).component

  assert.equal(component({
    ...injectProps,
    useDeleteRequest: () => null,
    useSessions: (selector) => selector({ byId: {} }),
  }), null)

  const snapshot = { byId: { 'session-x': { displayTitle: 'Chat about things', running: false } } }
  // The dialog returns the keyed form element; calling it renders the Modal.
  const formElement = component({
    ...injectProps,
    useDeleteRequest: () => ({ sessionId: 'session-x' }),
    useSessions: (selector) => selector(snapshot),
  })
  assert.equal(typeof formElement.type, 'function')
  assert.equal(formElement.type.name, 'DeleteSessionForm')

  const modal = formElement.type(formElement.props)
  assert.equal(modal.type, 'Modal')
  assert.equal(modal.props.open, true)
  assert.equal(modal.props.title, 'Delete session')
  assert.match(modal.props.description, /permanently delete the session/)
  const buttons = findAll(modal.props.footer, (node) => node.type === 'Button')
  assert.equal(buttons.length, 2)
  assert.equal(buttons[1].props.disabled, true, 'confirm disabled until acknowledged')
  assert.match(textOf(buttons[1]), /^Delete$/)
  assert.match(textOf(modal), /Chat about things/)
  assert.match(textOf(modal), /session-x/)
  assert.equal(findAll(modal, (node) => node.type === 'input').length, 1)

  // A running session warns and explains the consequence instead.
  const runningModal = formElement.type({
    ...formElement.props,
    useSessions: (selector) => selector({ byId: { 'session-x': { displayTitle: 'Busy chat', running: true } } }),
  })
  assert.match(runningModal.props.description, /stop its task immediately/)
  assert.match(textOf(runningModal), /Session is running/)
})

test('the injected delete flow posts the id, refreshes the list and opens the next session', async () => {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ ok: true, sessionId: 'session-x' }) }
  }
  const { registration } = loadBundle({ fetch })
  const plugin = registration.factory((specifier) => (specifier === 'react' ? createReact() : createPrimitives()))
  const opened = []
  let refreshed = 0
  const snapshot = {
    ids: ['session-x', 'session-y'],
    byId: { 'session-x': { id: 'session-x', retainedBy: { mainView: 1 } }, 'session-y': { id: 'session-y', retainedBy: { mainView: 0 } } },
  }
  const services = {
    sessions: {
      list: { getSnapshot: () => snapshot },
      async refresh() { refreshed += 1 },
    },
    uiWorkspace: { openSession: (id) => opened.push(id) },
  }
  const { ctx, registered } = createClientContext({ services })
  plugin.apply(ctx)
  const injectProps = findEntry(registered, OVERLAY_SLOT).spec.inject()

  await injectProps.deleteSession('session-x')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/__session-delete/delete')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { sessionId: 'session-x' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(refreshed, 1)
  assert.deepEqual(opened, ['session-y'], 'the deleted main-view session is replaced')
})

test('deleting a background session does not navigate', async () => {
  const fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
  const { registration } = loadBundle({ fetch })
  const plugin = registration.factory((specifier) => (specifier === 'react' ? createReact() : createPrimitives()))
  const opened = []
  const snapshot = {
    ids: ['session-a', 'session-b'],
    byId: { 'session-a': { id: 'session-a', retainedBy: { mainView: 0 } }, 'session-b': { id: 'session-b', retainedBy: { mainView: 1 } } },
  }
  const services = {
    sessions: { list: { getSnapshot: () => snapshot }, async refresh() {} },
    uiWorkspace: { openSession: (id) => opened.push(id) },
  }
  const { ctx, registered } = createClientContext({ services })
  plugin.apply(ctx)
  await findEntry(registered, OVERLAY_SLOT).spec.inject().deleteSession('session-a')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(opened, [])
})

test('a host refusal surfaces the host message', async () => {
  const fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: 'session not found: session-x' }) })
  const { registration } = loadBundle({ fetch })
  const plugin = registration.factory((specifier) => (specifier === 'react' ? createReact() : createPrimitives()))
  const { ctx, registered } = createClientContext()
  plugin.apply(ctx)
  await assert.rejects(
    () => findEntry(registered, OVERLAY_SLOT).spec.inject().deleteSession('session-x'),
    /session not found: session-x/,
  )
})

test('with the locale service present, dictionaries register and entries take the t seat', () => {
  const registeredDictionaries = []
  const { registration } = loadBundle()
  const plugin = registration.factory((specifier) => (specifier === 'react' ? createReact() : createPrimitives()))
  const services = {
    locale: {
      register(ns, dicts) {
        registeredDictionaries.push({ ns, locales: Object.keys(dicts) })
        return () => {}
      },
    },
  }
  const { ctx, registered } = createClientContext({ services })
  plugin.apply(ctx)
  assert.deepEqual(registeredDictionaries, [{ ns: 'session-delete', locales: ['zh', 'en'] }])
  for (const slot of [MENU_SLOT, HEADER_SLOT, OVERLAY_SLOT]) {
    assert.equal(findEntry(registered, slot).spec.locale, 'session-delete')
  }

  // The t seat wins over the built-in dictionaries.
  const t = (key) => `seat:${key}`
  const element = findEntry(registered, HEADER_SLOT).component({
    sessionId: 'session-x',
    useSessions: (selector) => selector({ byId: {} }),
    requestDelete: () => {},
    t,
  })
  assert.equal(element.props.title, 'seat:button.title')
})

test('Chinese fallback copy is used when the browser prefers zh', () => {
  const { registration } = loadBundle({ navigator: { languages: ['zh-CN'], language: 'zh-CN' } })
  const plugin = registration.factory((specifier) => (specifier === 'react' ? createReact() : createPrimitives()))
  const { ctx, registered } = createClientContext()
  plugin.apply(ctx)
  const element = findEntry(registered, MENU_SLOT).component({
    sessionId: 'session-x',
    displayTitle: '聊点什么',
    useMenuOpenState: () => [false, () => {}],
    ...findEntry(registered, MENU_SLOT).spec.inject(),
  })
  assert.equal(textOf(element), '删除会话')
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
console.log(failed === 0 ? `\nall ${tests.length} client tests passed` : `\n${failed} of ${tests.length} client tests failed`)
process.exit(failed === 0 ? 0 : 1)
