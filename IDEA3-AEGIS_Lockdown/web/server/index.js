import { loadConfig } from './config.js'
import { startServer } from './runtime.js'

const config = loadConfig()
const runtime = await startServer({ config })
let shuttingDown = false

process.stdout.write(`AEGIS IDEA3 Security Center listening on http://${config.bindHost}:${config.port}${config.webBasePath}/\n`)
if (runtime.machineServer) {
  process.stdout.write(
    `AEGIS IDEA3 machine dispatch listener on ${config.dispatch.host}:${config.dispatch.port} (application-internal; never host-published)\n`,
  )
}

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  process.stdout.write(`AEGIS IDEA3 Security Center stopping after ${signal}\n`)
  try {
    await runtime.close()
  } catch (error) {
    process.stderr.write(`AEGIS IDEA3 Security Center shutdown failed: ${error?.name || 'Error'}\n`)
    process.exitCode = 1
  }
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
