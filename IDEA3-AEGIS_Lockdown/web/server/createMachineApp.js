import express from 'express'
import helmet from 'helmet'
import { AuditPersistenceError } from './repositories/auditRecords.js'
import { createMachineRouter } from './routes/machineRoutes.js'
import { createMachineIdentityGuard } from './security/machineIdentity.js'

function notFound(res) {
  return res.status(404).json({ error: { code: 'NOT_FOUND' } })
}

/**
 * The PR10 S2 machine app (spec §4.4). It runs on its own
 * application/container-internal listener, separate from the browser app. It
 * mounts no session, auth, CSRF, static, or Admin route, and every request must
 * pass the machine identity check before anything else runs.
 */
export function createMachineApp({ config, repository, contact }) {
  if (config.dispatch?.enabled !== true) {
    throw new Error('The machine app requires dispatch to be enabled')
  }
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
    trustedProxy: config.dispatch.trustedProxy,
    expectedSubject: config.dispatch.expectedSubject,
    contact,
  }))
  // Exact-case prefix: any other casing of the machine path is not served.
  app.use((req, res, next) => (req.path.startsWith(`${base}/`) ? next() : notFound(res)))
  app.use(express.json({ limit: '8kb', strict: true }))
  app.use(base, createMachineRouter({ repository }))
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
