// dsh-plugin-session-delete — delete-session capability (Host half).
//
// DSH 0.2.x exposes no session-delete API (`dsh-workspace` documents session
// deletion as an absent capability), so this plugin composes one out of the
// services that do exist:
//
//   POST /__session-delete/delete   - HTTP endpoint for the client delete dialog
//   workbench_session_delete        - model tool for the agent
//
// Deletion steps, ordered so the in-memory services and the on-disk units stay
// consistent (no "resurrected" session after the next flush):
//   1. stop a running agent (cancel + quiescence, time-boxed);
//   2. flush a live session, then detach it from the session store, so no
//      pending write can recreate the log directory after we remove it;
//   3. remove the persisted log directory:
//        <sessions root>/<project dir>/<encoded session id>/
//      scanning every project directory, for both id spellings (raw uuid and
//      the `session-` prefixed form) that this build really writes;
//      repeated after a settle window because a dispose-time drain may still
//      be in flight;
//   4. drop the projection-cache row (storageDomain `session_projcache`,
//      table `sessions`) — derived data, safe to delete;
//   5. only once the log is confirmed gone, clear the workspace accounting
//      through the workspace registry's own API (detachSession /
//      unarchiveSession / unpinSession), so its in-memory state cannot write
//      a stale membership back later.
//
// ESM module format (cordis bundle rule): named exports apply/inject/name.
// Every route registration belongs to the plugin fiber through ctx.effect.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'

const name = 'chameleon-session-delete'

// `tools` is a hard dependency: the delete tool is the agent-facing half.
// webServer, sessions, agents, storageDomain, sessionPersistence and
// workspaceRegistry are optional services, probed with ctx.get().
const inject = ['tools']

const DELETE_ROUTE = '/__session-delete/delete'

// A session id is used as one path segment, so it may not contain separators,
// colons, or control characters. DSH mints `session-<uuid>` for top-level
// sessions and bare uuids for subagent sessions; both match.
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,200}$/

const PROJCACHE_DOMAIN = 'session_projcache'
const PROJCACHE_TABLE = 'sessions'

const AGENT_STOP_TIMEOUT_MS = 15000

class DeleteError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

// --- session id + log location ------------------------------------------------

function isValidSessionId(sessionId) {
  return SESSION_ID_RE.test(sessionId) && sessionId !== '.' && sessionId !== '..'
}

// Session ids may appear in two spellings in different stores: the raw id
// (`<uuid>`, used by subagent sessions) and the prefixed form
// (`session-<uuid>`, used by top-level sessions). Both spellings exist on disk
// for different sessions, and derived stores may carry either one for the same
// session, so every spelling is cleaned. A uuid collision between the two
// forms is what would make that unsafe, and uuids do not collide.
function sessionIdVariants(sessionId) {
  const variants = new Set([sessionId])
  if (sessionId.startsWith('session-')) variants.add(sessionId.slice('session-'.length))
  else variants.add(`session-${sessionId}`)
  return [...variants]
}

// The persistence backend owns the sessions root; read it from the live
// backend so a configured home, a relocated root, or a DSH_HOME override all
// resolve correctly. Falls back to the shipped default when persistence is not
// mounted in this composition.
function sessionsRoot(ctx) {
  const persistence = ctx.get('sessionPersistence')
  const configured = persistence && typeof persistence.root === 'string' ? persistence.root : undefined
  if (configured) return path.resolve(configured)
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'sessions')
}

// Locate `<root>/<project dir>/<session id>/` by scanning, because the project
// directory is derived from the session's recorded cwd (or `_no-cwd`) and the
// ids are path-encoded — neither is worth re-deriving here. Returns every
// matching directory for both id spellings.
function findSessionDirs(root, sessionId) {
  const variants = sessionIdVariants(sessionId)
  const found = []
  let projects
  try {
    projects = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    for (const variant of variants) {
      const candidate = path.join(root, project.name, variant)
      try {
        if (fs.statSync(candidate).isDirectory() && !found.includes(candidate)) found.push(candidate)
      } catch { /* not this project directory */ }
    }
  }
  return found
}

// Remove every on-disk session directory, retrying across a short settle
// window: detaching a live session emits `session/disposed`, whose listeners
// drain the persistence handle asynchronously and can recreate the directory
// after the first removal. Returns whether anything was removed.
async function removeSessionDirs(root, sessionId, attempts = 6) {
  let removed = false
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const dirs = findSessionDirs(root, sessionId)
    if (dirs.length === 0) return removed
    for (const dir of dirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
        removed = true
      } catch { /* retried on the next attempt */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
  }
  return removed
}

// --- live services ------------------------------------------------------------

// Stop a running agent (cancel the active turn, wait for quiescence) before its
// session is deleted. The cancel surfaces in the log as a user cancel; the wait
// is time-boxed so a stuck driver never blocks the deletion.
async function stopAgentIfRunning(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.get !== 'function') return false
  const agent = agents.get(sessionId)
  if (!agent) return false
  if (typeof agent.cancel === 'function' && agent.status === 'running') {
    try { agent.cancel({ kind: 'user' }) } catch { /* agent may already be settling */ }
  }
  if (typeof agent.whenIdle === 'function') {
    try {
      await Promise.race([
        Promise.resolve(agent.whenIdle()).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, AGENT_STOP_TIMEOUT_MS)),
      ])
    } catch { /* proceed with deletion anyway */ }
  }
  return true
}

// Flush a live session before detaching it: the persistence layer flushes on
// `session/disposed`, so draining the buffer here first leaves the dispose with
// nothing to write after we remove the log directory.
async function flushLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.get !== 'function' || typeof sessions.flush !== 'function') return false
  let flushed = false
  for (const id of sessionIdVariants(sessionId)) {
    const session = sessions.get(id)
    if (!session) continue
    try {
      await sessions.flush(session)
      flushed = true
    } catch { /* deletion proceeds and removes the log anyway */ }
  }
  return flushed
}

// Remove the session from the in-memory store so host listings stop returning
// it and no flush can re-materialize its files. `detachEntered` is the store's
// own teardown path: it deletes the entry and emits `session/disposed`.
function detachLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.detachEntered !== 'function' || !sessions.store) return false
  let detached = false
  for (const id of sessionIdVariants(sessionId)) {
    const entry = sessions.store.get(id)
    if (entry === undefined) continue
    try {
      sessions.detachEntered(entry)
      detached = true
    } catch { /* the directory removal below is the fallback */ }
  }
  return detached
}

// The projection cache keeps one derived document per session. It is the only
// place a deleted session's row can outlive its log, and the cache service
// exposes no removal API, so the open domain table is used directly. The
// facility's `get()` returns the handle the cache service itself opened.
function projectionSessions(ctx) {
  const storageDomain = ctx.get('storageDomain')
  const domain = storageDomain && typeof storageDomain.get === 'function'
    ? storageDomain.get(PROJCACHE_DOMAIN)
    : undefined
  if (!domain || typeof domain.table !== 'function') return undefined
  try {
    return domain.table(PROJCACHE_TABLE)
  } catch {
    return undefined
  }
}

async function dropProjectionRows(ctx, sessionId) {
  const table = projectionSessions(ctx)
  if (!table) return false
  let removed = false
  for (const id of sessionIdVariants(sessionId)) {
    try {
      if (table.get(id) !== undefined && await table.delete(id)) removed = true
    } catch { /* unit closed or row absent */ }
  }
  return removed
}

// Workspace accounting (membership, archive set, pin set) goes through the
// workspace registry's public API: it serializes its own writes and keeps the
// in-memory records it later rewrites. Writing the `workspace` domain directly
// would leave that cache stale, and the next registry mutation would then write
// the deleted session's membership back.
async function clearWorkspaceAccounting(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (!registry) return false
  const variants = sessionIdVariants(sessionId)
  let changed = false

  try {
    for (const workspace of registry.list()) {
      const recorded = Array.isArray(workspace.record?.sessionIds)
        ? workspace.record.sessionIds
        : []
      for (const id of variants) {
        if (!recorded.includes(id)) continue
        await workspace.detachSession(id)
        changed = true
      }
    }
  } catch { /* registry not started, or a workspace write failed */ }

  try {
    for (const id of variants) {
      if (registry.archivedSessionIds.includes(id)) {
        await registry.unarchiveSession(id)
        changed = true
      }
      if (registry.pinnedSessionIds.includes(id)) {
        await registry.unpinSession(id)
        changed = true
      }
    }
  } catch { /* registry not started */ }

  return changed
}

// --- core delete --------------------------------------------------------------

async function deleteSessionCore(ctx, sessionId) {
  if (!isValidSessionId(sessionId)) throw new DeleteError(`invalid session id: ${sessionId}`, 400)
  const root = sessionsRoot(ctx)
  const hadLogDir = findSessionDirs(root, sessionId).length > 0

  const stopped = await stopAgentIfRunning(ctx, sessionId)
  await flushLiveSession(ctx, sessionId)
  const detached = detachLiveSession(ctx, sessionId)

  // Remove the log before touching accounting: if the filesystem refuses, fail
  // while the session still belongs to its workspace instead of leaving a
  // half-deleted row behind.
  const removedLog = await removeSessionDirs(root, sessionId)
  const projRemoved = await dropProjectionRows(ctx, sessionId)
  const remaining = findSessionDirs(root, sessionId)
  if (remaining.length > 0) {
    throw new DeleteError(`session files could not be fully removed: ${remaining.join(', ')}`, 500)
  }

  const workspaceRemoved = await clearWorkspaceAccounting(ctx, sessionId)

  if (!hadLogDir && !removedLog && !projRemoved && !workspaceRemoved && !detached) {
    throw new DeleteError(`session not found: ${sessionId}`, 404)
  }
  return { stopped, detached, dirRemoved: hadLogDir || removedLog, projRemoved, workspaceRemoved }
}

// --- http ---------------------------------------------------------------------

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1e6) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

function deleteHandler(ctx) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    let args
    try {
      const body = await readBody(req)
      args = body ? JSON.parse(body) : {}
    } catch {
      sendJson(res, 400, { error: 'bad json body' })
      return
    }
    const sessionId = String((args && args.sessionId) || '').trim()
    if (!sessionId) {
      sendJson(res, 400, { error: 'sessionId required' })
      return
    }
    try {
      const result = await deleteSessionCore(ctx, sessionId)
      sendJson(res, 200, { ok: true, sessionId, ...result })
    } catch (error) {
      const status = error instanceof DeleteError && error.status ? error.status : 500
      if (status === 500) ctx.logger?.warn?.(`session-delete: ${String(error?.message ?? error)}`)
      sendJson(res, status, { error: String(error?.message ?? error) })
    }
  }
}

// --- plugin -------------------------------------------------------------------
// webServer is optional (a terminal-only profile has no web surface): the route
// registers when the service exists or appears later, while the tool registers
// unconditionally — so the plugin never waits on a service a profile will never
// provide.

function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: DELETE_ROUTE,
      handler: deleteHandler(ctx),
    }), 'session-delete: delete route')
  })

  ctx.tools.register(defineTool({
    name: 'workbench_session_delete',
    description: 'Permanently delete one session of this workbench: stops the agent if it is running (cancel + quiescence), then removes its persisted log, projection-cache row and workspace accounting. The client sidebar refreshes on its next pull; verify with the session list afterwards.',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'The session id to delete (uuid or session-<uuid> form).',
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: value }] },
    },
    async execute(args) {
      const sessionId = String(args.sessionId || '').trim()
      if (!isValidSessionId(sessionId)) return `delete failed: invalid session id: ${sessionId}`
      try {
        const result = await deleteSessionCore(ctx, sessionId)
        return [
          `deleted: ${sessionId}`,
          `agent stopped: ${result.stopped}`,
          `session detached from the live store: ${result.detached}`,
          `log directory removed: ${result.dirRemoved}`,
          `projection cache row removed: ${result.projRemoved}`,
          `workspace accounting cleared: ${result.workspaceRemoved}`,
        ].join('\n')
      } catch (error) {
        return `delete failed: ${String(error?.message ?? error)}`
      }
    },
  }))
}

export { apply, inject, name }
