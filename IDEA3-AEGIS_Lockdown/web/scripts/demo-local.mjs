#!/usr/bin/env node
/**
 * Local, non-production AEGIS IDEA3 Security Center launcher for the Demo presentation.
 *
 *   npm run build && npm run demo:local
 *
 * It starts the normal Express app on loopback with: development mode, a throw-away random password (printed
 * once to this terminal, never stored), an audit database in a private temporary directory that is deleted on
 * exit, no IDEA1/IDEA2/runtime upstream (so Live shows NOT_CONFIGURED), and machine dispatch disabled. It cannot
 * run in production, cannot reach MQTT/ESP32/relay, and starts no second control plane.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_PORT = '8003'
// Everything that could point the launcher at a real upstream, machine listener or proxy is dropped.
const STRIPPED = /^(AEGIS_(IDEA1|IDEA2)_|AEGIS_IDEA3_(RUNTIME_STATUS_URL|DISPATCH_|ADMIN_PASSWORD_HASH)|AEGIS_WEB_TRUSTED_PROXY|AEGIS_WEB_BASE_PATH)/

export function buildDemoEnv(baseEnv, { auditDir, staticDir, password = randomBytes(18).toString('base64url') }) {
  if (baseEnv.NODE_ENV === 'production') throw new Error('demo-local refuses to run when NODE_ENV=production')
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

async function main() {
  const staticDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
  if (!existsSync(path.join(staticDir, 'index.html'))) {
    process.stderr.write('demo-local: dist/ is missing. Run `npm run build` first.\n')
    process.exit(1)
  }
  const auditDir = mkdtempSync(path.join(tmpdir(), 'aegis-idea3-demo-'))
  const env = buildDemoEnv(process.env, { auditDir, staticDir })
  Object.assign(process.env, env)
  for (const key of Object.keys(process.env)) if (STRIPPED.test(key)) delete process.env[key]

  const { loadConfig } = await import('../server/config.js')
  const { startServer } = await import('../server/runtime.js')
  const config = loadConfig(process.env)
  const runtime = await startServer({ config })
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

  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    try { await runtime.close() } finally { rmSync(auditDir, { recursive: true, force: true }) }
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`demo-local failed: ${error?.message ?? 'error'}\n`)
    process.exit(1)
  })
}
