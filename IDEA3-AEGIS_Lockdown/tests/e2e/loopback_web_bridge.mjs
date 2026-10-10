// TEST SUPPORT ONLY. Starts the REAL web apps on 127.0.0.1 ephemeral ports for the local E2E acceptance (tests/test_local_e2e_acceptance.py):
//   * the browser app (createApp) and the machine dispatch app (createMachineApp) over ONE disposable SQLite audit database,
//   * a fixed clock (so Core/Web agree on the dispatch TTL), a random one-shot Admin password, no TLS terminator (documented gap).
// It binds loopback only, mints one accepted CUT_UPLINK decision with the repository API (the web's own incident intake is IDEA1/IDEA2 feeds,
// which this bridge deliberately does not fake), prints one JSON line, and exits when stdin closes. It never contacts any other host.
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { loadConfig } from '../../web/server/config.js'
import { createApp } from '../../web/server/createApp.js'
import { createMachineApp } from '../../web/server/createMachineApp.js'
import { createSqliteRepository } from '../../web/server/repositories/sqliteRepository.js'
import { createMachineContactTracker } from '../../web/server/security/machineIdentity.js'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, value, index, all) => (index % 2 === 0 ? [...acc, [value.replace(/^--/, ''), all[index + 1]]] : acc), []))
const nowMs = Number(args.nowEpoch) * 1000
if (!args.db || !Number.isFinite(nowMs)) { console.error('usage: --db FILE --nowEpoch N [--runtimeStatusFile FILE]'); process.exit(2) }
const clock = () => new Date(nowMs)
const password = randomBytes(18).toString('hex')
const env = {
  NODE_ENV: 'test', SESSION_SECRET: randomBytes(32).toString('hex'), AEGIS_ALLOW_DEV_LOGIN: 'true', AEGIS_IDEA3_ADMIN_USER: 'admin',
  AEGIS_IDEA3_DEV_PASSWORD: password, AEGIS_IDEA3_DISPATCH_ENABLED: 'true', AEGIS_IDEA3_DISPATCH_PORT: '18103',
  AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY: '127.0.0.1', AEGIS_IDEA3_DISPATCH_EXPECTED_SUBJECT: 'idea3-core', AEGIS_IDEA3_AUDIT_DB_PATH: args.db,
}
// Optional: serve the Core's runtime status document (written by the Python test) at /status on loopback, as AEGIS_IDEA3_RUNTIME_STATUS_URL.
let statusServer = null
if (args.runtimeStatusFile) {
  statusServer = createServer((req, res) => {
    let body = null
    try { body = readFileSync(args.runtimeStatusFile) } catch { body = null }
    if (body === null) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(body)
  })
  await new Promise((resolve) => statusServer.listen(0, '127.0.0.1', resolve))
  env.AEGIS_IDEA3_RUNTIME_STATUS_URL = `http://127.0.0.1:${statusServer.address().port}/status`
}
const config = loadConfig(env)
const repository = createSqliteRepository({ path: args.db, clock })
const contact = createMachineContactTracker({ clock })
const app = createApp({ config, repository, machineContact: contact })
const machineApp = createMachineApp({ config, repository, contact })
const listen = (a) => new Promise((resolve) => { const s = a.listen(0, '127.0.0.1', () => resolve(s)) })
const [web, machine] = await Promise.all([listen(app), listen(machineApp)])
const decision = { incidentId: 'inc-0123456789abcd', decision: 'ACCEPT', state: 'CONTAINMENT_ACCEPTED', correlationKey: 'e2e-synthetic-incident', evidenceIds: ['IDEA1:e2e-synthetic-1', 'IDEA2:e2e-synthetic-1'], severity: 'HIGH' }
const minted = repository.recordContainmentDecision(decision, { mintDispatch: true })
process.stdout.write(`${JSON.stringify({ webPort: web.address().port, machinePort: machine.address().port, basePath: config.webBasePath || '', password, actionId: minted.dispatch.actionId })}\n`)
const shutdown = () => { web.close(); machine.close(); statusServer?.close(); try { repository.close() } catch {} process.exit(0) }
process.stdin.resume(); process.stdin.on('end', shutdown); process.on('SIGTERM', shutdown)
