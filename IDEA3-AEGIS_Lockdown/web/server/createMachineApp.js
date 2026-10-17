import express from 'express'
import helmet from 'helmet'
import { AuditPersistenceError } from './repositories/auditRecords.js'
import { createMachineRouter, createStatusRouter } from './routes/machineRoutes.js'
import { createMachineIdentityGuard } from './security/machineIdentity.js'

function notFound(res) {
  return res.status(404).json({ error: { code: 'NOT_FOUND' } })
}

/**
 * The machine app (PR10 S2 spec §4.4). It runs on its own application/container-internal listener, separate from the
 * browser app. It mounts no session, auth, CSRF, static, or Admin route, and every request must pass the machine
 * identity check before anything else runs.
 *
 * Two independent features may be mounted on it: dispatch (config.dispatch.enabled) and the read-only status ingest
 * (config.statusIngest.enabled). A route group that is not enabled does not exist (404), so status-only mode exposes
 * no dispatch route and dispatch-only mode exposes no status route.
 */
export function createMachineApp({ config, repository, contact, statusStore = null, clock = () => new Date() }) {
  const dispatchOn = config.dispatch?.enabled === true
  const statusOn = config.statusIngest?.enabled === true
  if (!dispatchOn && !statusOn) {
    throw new Error('The machine app requires dispatch or status ingest to be enabled')
  }
  if (statusOn && !statusStore) throw new Error('Status ingest requires a status store')
  const listener = config.machine?.enabled ? config.machine : config.dispatch
  const base = `${config.webBasePath}/api/machine/v1`
  const app = express()
  // The shared audit repository is closed by the runtime that owns it.
  app.locals.close = () => {}
  app.disable('x-powered-by')
  app.set('trust proxy', false)
  app.set('case sensitive routing', true)

  app.use(helmet())
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })
  app.use(createMachineIdentityGuard({
    trustedProxy: listener.trustedProxy,
    expectedSubject: listener.expectedSubject,
    contact,
    // A status push proves nothing about the dispatch worker, so it never counts as dispatch machine contact.
    recordsContact: (req) => !(statusOn && req.path === `${base}/status`),
  }))
  // Exact-case prefix: any other casing of the machine path is not served.
  app.use((req, res, next) => (req.path.startsWith(`${base}/`) ? next() : notFound(res)))
  app.use(express.json({ limit: '8kb', strict: true }))
  if (dispatchOn) app.use(base, createMachineRouter({ repository }))
  if (statusOn) app.use(base, createStatusRouter({ store: statusStore, clock }))
  app.use((_req, res) => notFound(res))

  app.use((error, _req, res, _next) => {
    if (error instanceof AuditPersistenceError) {
      return res.status(503).json({ error: { code: 'AUDIT_PERSISTENCE_FAILURE' } })
    }
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'REQUEST_TOO_LARGE' } })
    if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'REQUEST_INVALID' } })
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR' } })
  })

  return app
}
