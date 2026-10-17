import { createApp } from './createApp.js'
import { createMachineApp } from './createMachineApp.js'
import { createSqliteRepository } from './repositories/sqliteRepository.js'
import { createMachineContactTracker } from './security/machineIdentity.js'
import { createStatusIngestStore } from './domain/statusIngest.js'

function defaultListen(app, port, host) {
  return app.listen(port, host)
}

function whenListening(server) {
  return new Promise((resolve, reject) => {
    if (server.listening) {
      resolve()
      return
    }
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
  })
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server?.listening) {
      resolve()
      return
    }
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

/**
 * Start the browser listener and, only when PR10 S2 dispatch or the independent
 * status ingest is enabled, the separate machine listener on the configured
 * machine host and port. With both features off no machine listener starts. The
 * machine port is application/container-internal and never host-published.
 * Both apps share one audit repository, which is closed exactly once.
 */
export function startServer({
  config,
  repository,
  appFactory = createApp,
  machineAppFactory = createMachineApp,
  listen = defaultListen,
  clock = () => new Date(),
}) {
  const dispatchEnabled = config.dispatch?.enabled === true
  const statusEnabled = config.statusIngest?.enabled === true
  const machineListener = config.machine?.enabled ? config.machine : config.dispatch
  const sharedRepository = repository
    ?? (dispatchEnabled ? createSqliteRepository({ path: config.auditDbPath, clock }) : undefined)
  // One tracker: the machine app records authenticated contact, and the browser
  // app reads it to show DISPATCH_PENDING or DISPATCH_UNAVAILABLE.
  const machineContact = dispatchEnabled ? createMachineContactTracker({ clock }) : null
  // One in-memory store, shared by the machine route (writer) and the Web live provider (reader). It is never durable.
  const statusStore = statusEnabled
    ? createStatusIngestStore({ maxAgeMs: config.maxEvidenceAgeMs, allowedProfiles: config.production ? ['production'] : null })
    : null
  const app = appFactory({ config, repository: sharedRepository, machineContact, statusStore })
  const machineApp = dispatchEnabled || statusEnabled
    ? machineAppFactory({
      config,
      repository: sharedRepository,
      contact: machineContact ?? createMachineContactTracker({ clock }),
      statusStore,
      clock,
    })
    : null
  let closePromise = null

  const server = listen(app, config.port, config.bindHost)
  const machineServer = machineApp ? listen(machineApp, machineListener.port, machineListener.host) : null

  function close() {
    if (closePromise) return closePromise
    closePromise = Promise.all([closeServer(server), closeServer(machineServer)])
      .then(() => {
        app.locals.close?.()
      })
    return closePromise
  }

  return Promise.all([whenListening(server), machineServer ? whenListening(machineServer) : null])
    .then(() => ({ app, server, machineApp, machineServer, close }))
    .catch(async (error) => {
      await close().catch(() => {})
      throw error
    })
}
