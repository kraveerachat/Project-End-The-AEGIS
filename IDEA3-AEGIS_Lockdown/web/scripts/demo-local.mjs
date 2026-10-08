#!/usr/bin/env node
/**
 * Local, non-production AEGIS IDEA3 Security Center launcher for the Demo presentation.
 *
 *   npm run build && npm run demo:local
 *
 * It starts the normal Express app on loopback with: development mode, a throw-away random password (printed
 * once to this terminal, never stored), an audit database in a private temporary directory, no IDEA1/IDEA2/runtime
 * upstream (so Live shows NOT_CONFIGURED), and machine dispatch disabled. It cannot run in production, cannot reach
 * MQTT/ESP32/relay, and starts no second control plane.
 *
 * Cleanup: the launcher deletes ONLY the directory it allocated itself. That directory is removed on SIGINT, SIGTERM
 * and SIGHUP, on a startup failure (for example a busy port), and on any normal or uncaught-error process exit. The
 * production refusal happens before anything is allocated. SIGKILL (or a power loss) cannot be handled, so after one
 * of those a leftover `aegis-idea3-demo-*` directory in the temporary directory can remain and is safe to delete.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_PORT = '8003'
// Everything that could point the launcher at a real upstream, machine listener or proxy is dropped.
const STRIPPED = /^(AEGIS_(IDEA1|IDEA2)_|AEGIS_IDEA3_(RUNTIME_STATUS_URL|DISPATCH_|ADMIN_PASSWORD_HASH)|AEGIS_WEB_TRUSTED_PROXY|AEGIS_WEB_BASE_PATH)/

export function assertDemoAllowed(baseEnv) {
  if (baseEnv.NODE_ENV === 'production') throw new Error('demo-local refuses to run when NODE_ENV=production')
}

export function buildDemoEnv(baseEnv, { auditDir, staticDir, password = randomBytes(18).toString('base64url') }) {
  assertDemoAllowed(baseEnv)
  const env = {}
  for (const [key, value] of Object.entries(baseEnv)) if (!STRIPPED.test(key)) env[key] = value
  const port = /^[1-9][0-9]{0,4}$/.test(baseEnv.PORT ?? '') ? baseEnv.PORT : DEFAULT_PORT
  return {
    ...env,
    NODE_ENV: 'development',
    PORT: port,
    AEGIS_BIND_HOST: '127.0.0.1',
    AEGIS_ALLOW_DEV_LOGIN: 'true',
    AEGIS_DEMO_ALLOWED: 'true',
    AEGIS_IDEA3_ADMIN_USER: 'admin',
    AEGIS_IDEA3_DEV_PASSWORD: password,
    SESSION_SECRET: randomBytes(32).toString('base64url'),
    AEGIS_IDEA3_AUDIT_DB_PATH: path.join(auditDir, 'security-center-audit.sqlite3'),
    AEGIS_WEB_STATIC_DIR: staticDir,
  }
}

const AUDIT_DIR_PREFIX = 'aegis-idea3-demo-'
const SHUTDOWN_GRACE_MS = 3_000
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']

/**
 * Owns the one temporary directory this process allocates. remove() is synchronous (safe inside the 'exit' event),
 * idempotent, and refuses to delete anything that is not the exact directory this object created.
 */
export function createTempAuditDir({ root = tmpdir(), make = mkdtempSync, remove = rmSync } = {}) {
  let owned = null
  return {
    allocate() {
      owned = make(path.join(root, AUDIT_DIR_PREFIX))
      return owned
    },
    remove() {
      const target = owned
      owned = null
      if (target === null) return
      if (path.dirname(target) !== root || !path.basename(target).startsWith(AUDIT_DIR_PREFIX)) return
      try { remove(target, { recursive: true, force: true }) } catch { /* nothing else to do at exit */ }
    },
  }
}

async function main() {
  // Refuse production before anything is allocated.
  assertDemoAllowed(process.env)
  const staticDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
  if (!existsSync(path.join(staticDir, 'index.html'))) {
    process.stderr.write('demo-local: dist/ is missing. Run `npm run build` first.\n')
    process.exit(1)
  }

  const temp = createTempAuditDir()
  let runtime = null
  let stopping = false
  // Handlers are installed before the directory exists, so every later path (startup failure, signal, exit) is covered.
  process.on('exit', () => temp.remove())
  const stop = (code) => {
    if (stopping) return
    stopping = true
    const finish = () => { temp.remove(); process.exit(code) }
    if (runtime === null) return finish()
    const timer = setTimeout(finish, SHUTDOWN_GRACE_MS)
    timer.unref()
    Promise.resolve().then(() => runtime.close()).catch(() => {}).finally(finish)
  }
  for (const signal of SIGNALS) process.on(signal, () => stop(0))

  const auditDir = temp.allocate()
  const env = buildDemoEnv(process.env, { auditDir, staticDir })
  Object.assign(process.env, env)
  for (const key of Object.keys(process.env)) if (STRIPPED.test(key)) delete process.env[key]

  const { loadConfig } = await import('../server/config.js')
  const { startServer } = await import('../server/runtime.js')
  const config = loadConfig(process.env)
  runtime = await startServer({ config })
  process.stdout.write([
    '',
    'AEGIS IDEA3 Security Center — LOCAL DEMO (non-production, no hardware, no upstream)',
    `  URL       http://127.0.0.1:${config.port}/`,
    '  Username  admin',
    `  Password  ${env.AEGIS_IDEA3_DEV_PASSWORD}   (random, this run only)`,
    '  Then open Settings → Demo Mode. Live mode will show NOT_CONFIGURED integrations by design.',
    '  Stop with Ctrl+C; the temporary audit database is deleted.',
    '',
  ].join('\n'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // The 'exit' handler installed in main() removes the temporary directory.
    process.stderr.write(`demo-local failed: ${error?.message ?? 'error'}\n`)
    process.exit(1)
  })
}
