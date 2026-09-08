// tests/publicShareInternalIntegration.test.js — PUBLIC-SHARE-6 internal integration
//
// Opt in with PUBLIC_SHARE_INTEGRATION_RUNTIME=1. The default IDEA1 suite skips
// this harness so it never builds images or mutates Docker implicitly.
//
// ── What is new here, and why the earlier suites could not do it ──────────────
//
// PUBLIC-SHARE-3's runtime suite proves the gateway CONFIGURATION against a
// purpose-built recorder. PUBLIC-SHARE-5 proves the security MATRIX against the
// Express app in-process, with a local TCP hop standing in for the gateway. Both
// were honest about the gap they left, in the same words:
//
//     "No test in this repository yet puts the real gateway in front of the real
//      Drive — that is exactly PUBLIC-SHARE-6's job."
//
// This file closes that gap. Every request below crosses a real nginx container,
// built from the shipped gateway Dockerfile, into the real AEGIS Drive
// application, built from its shipped Dockerfile, backed by a real PostgreSQL 15
// database carrying the real schema and the real migration 009.
//
// ⚠️ WHAT THIS STILL DOES NOT PROVE. It is INTERNAL integration. No ingress
//    method is chosen (G4 is open), nothing is exposed to the Internet (G5 is
//    open), and Public Internet Share stays NOT IMPLEMENTED until G6. There is
//    no TLS here, no DNS, no NAT, no tunnel and no Production anything. A
//    recipient in this harness is a container on an isolated Docker network, not
//    someone on 4G — that is PUBLIC-SHARE-7.
//
// ⚠️ NO PRODUCTION CONTACT. The harness owns its project name, its three
//    networks, its containers and its anonymous volumes, generates its own
//    throwaway credentials, reads no .env, and is removed in `after`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const ENABLED = process.env.PUBLIC_SHARE_INTEGRATION_RUNTIME === '1'
const COMPOSE_FILE = fileURLToPath(new URL('../../gateway/public-share/integration/docker-compose.yml', import.meta.url))
const MIGRATION_009 = fileURLToPath(new URL('../server/db/migrations/009_public_share_scope.sql', import.meta.url))

const HOST = 'share.example.invalid'
const BASE_URL = `https://${HOST}`
/**
 * The Compose project this run owns, and the ONLY project any teardown here
 * ever names.
 *
 * ⚠️ It is settable because the caller has to be able to know it in advance.
 *    A `process.pid` chosen inside this process is unknowable to the script that
 *    launched it, so a runner could not clean up after a crashed run, and a
 *    runner that guessed would be guessing about `docker compose down` — the one
 *    place a wrong guess is expensive. `PS6_PROJECT` lets the Stage B runner
 *    mint the identifier, pass it in, and own it for the whole run.
 *
 * ⚠️ The `aegis-ps6-` prefix is REQUIRED, not conventional. Every teardown in
 *    this file and in `run-stage-b.sh` is `-p $PROJECT`-scoped, so the prefix is
 *    what makes it impossible to point that teardown at `aegis-prod` — by typo,
 *    by an inherited environment variable, or by a caller that meant well. An
 *    unset variable keeps the previous per-pid default, so a developer machine
 *    behaves exactly as before.
 *
 * The rest of the charset is Compose's own project-name rule (lowercase
 * alphanumerics, `_` and `-`, starting alphanumeric); an invalid value throws
 * here rather than surfacing later as a confusing Compose error.
 */
const PROJECT = resolveProject(process.env.PS6_PROJECT)

function resolveProject(given) {
  if (given === undefined || given === '') return `aegis-ps6-${process.pid}`
  if (given.length > 64 || !/^aegis-ps6-[a-z0-9][a-z0-9_-]*$/.test(given)) {
    throw new Error(
      `PS6_PROJECT must match /^aegis-ps6-[a-z0-9][a-z0-9_-]*$/ and be at most 64 characters, got ${JSON.stringify(given)}. ` +
      'The aegis-ps6- prefix is what keeps every project-scoped teardown away from a production project name.',
    )
  }
  return given
}

const EDGE_NETWORK = 'aegis_ps6_edge'
const UPSTREAM_NETWORK = 'aegis_ps6_upstream'
const DATA_NETWORK = 'aegis_ps6_data'
const NETWORKS = [EDGE_NETWORK, UPSTREAM_NETWORK, DATA_NETWORK]

const RECIPIENT_IP = '172.31.250.3'
const GATEWAY_EDGE_IP = '172.31.250.2'
const GATEWAY_UPSTREAM_IP = '172.31.251.2'
const DRIVE_UPSTREAM_IP = '172.31.251.3'
const POSTGRES_IP = '172.31.252.2'

/**
 * The file the acceptance downloads. 64 MiB by default: big enough that the
 * transfer is a real stream rather than one buffer, and big enough to still be
 * in flight while the slow-client test stalls past a default 60s timeout.
 * Override for a slower machine, but record whatever was actually used —
 * the size is evidence, not a preference.
 */
const FILE_BYTES = Number(process.env.PS6_FILE_BYTES ?? 64 * 1024 * 1024)

/** The 008-era CHECK, i.e. the exact state migration 009 has to widen. */
const PRE_009_SCOPES = ['any', 'zones', 'vlan', 'subnet']

const SEED_USER = 'user'
const SEED_PASSWORD = 'aegis-drive-user'
/** Passes the reset policy: >= 12 chars, not the old one, not the username. */
const RESET_PASSWORD = 'aegis-ps6-user-3b7f1e94'
const LINK_PASSWORD = 'ps6-link-a41d9c72'
const WRONG_LINK_PASSWORD = 'ps6-link-wrong-000'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * How to invoke Docker. Defaults to plain `docker`, which is right on a
 * developer machine.
 *
 * ⚠️ It is configurable because a host can require otherwise, and a hardcoded
 *    `docker` would simply fail there with a socket permission error that looks
 *    like a harness bug. The AEGIS server host is exactly that case: the
 *    administrative account is not in the `docker` group, and `DOCKER_HOST`
 *    points at a Podman socket that does not exist — so both the privilege and
 *    the environment have to be corrected at the call site:
 *
 *      PS6_DOCKER="sudo env -u DOCKER_HOST docker"
 *
 * Split on whitespace, so a wrapper with its own arguments works. Every Docker
 * call in this file goes through it; nothing invokes `docker` directly.
 */
const DOCKER_ARGV = String(process.env.PS6_DOCKER ?? 'docker').trim().split(/\s+/).filter(Boolean)
const DOCKER_BIN = DOCKER_ARGV[0]
const DOCKER_PREFIX = DOCKER_ARGV.slice(1)

/**
 * The four variables `docker-compose.yml` interpolates, and the ONLY four this
 * file will ever write to a file on disk.
 *
 * ⚠️ They are the harness's own throwaway values, minted per run with
 *    `randomBytes`. No Production credential is read, derived or written here,
 *    and no Production `.env` is opened anywhere in this file.
 */
const COMPOSE_INTERPOLATION_KEYS = [
  'PS6_SUPER_USER',
  'PS6_SUPER_PASSWORD',
  'PS6_DRIVE_DB_PASSWORD',
  'PS6_SESSION_SECRET',
]

/**
 * Where to write those four values so Compose can interpolate them, when the
 * caller owns a file for that purpose.
 *
 * ⚠️ THIS EXISTS BECAUSE STAGE B ATTEMPT #1 FAILED ON EXACTLY THIS. `PS6_DOCKER`
 *    on the AEGIS server host is `sudo -n env -u DOCKER_HOST docker`. A process
 *    environment does not cross a `sudo` boundary: sudo deliberately drops
 *    arbitrary variables, so the four values this test generates in its own
 *    child environment reached `execFile`, reached `sudo`, and were dropped
 *    there. Compose then refused to interpolate:
 *
 *      required variable PS6_SUPER_USER is missing a value
 *
 *    That is a credential-plumbing defect in the harness, not a product defect.
 *    The fix is to hand Compose the values through an argument it *can* see —
 *    `--env-file`, which is a path, and a path survives any privilege boundary
 *    that an argv survives.
 *
 * ⚠️ NOT SOLVED WITH `sudo -E`, `--preserve-env`, a sudoers `env_keep` entry, a
 *    docker-group change, passwordless sudo or any global environment change.
 *    The privilege boundary is left exactly as it is; only the plumbing across
 *    it becomes explicit.
 *
 * Unset — the developer-machine path — keeps the previous behaviour exactly:
 * no file is written, no `--env-file` is passed, and Compose reads the four
 * values from the inherited child environment as it always did.
 *
 * When set it must be an absolute path inside `PS6_WORKDIR` (when the caller
 * declares one), because the file holds secrets and the caller's cleanup trap
 * is what removes it. A path outside that directory would outlive the run.
 */
const COMPOSE_ENV_FILE = resolveComposeEnvFile(
  process.env.PS6_COMPOSE_ENV_FILE,
  process.env.PS6_WORKDIR,
)

function resolveComposeEnvFile(given, workdir) {
  if (given === undefined || given === '') return null
  if (!isAbsolute(given)) {
    throw new Error(
      `PS6_COMPOSE_ENV_FILE must be an absolute path, got ${JSON.stringify(given)}. ` +
      'A relative path is resolved against whatever directory the suite happens to run in, ' +
      'which is not a directory the caller cleans up.',
    )
  }
  const file = resolve(given)
  if (workdir !== undefined && workdir !== '') {
    const root = resolve(workdir)
    const rel = relative(root, file)
    if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(
        `PS6_COMPOSE_ENV_FILE must be inside PS6_WORKDIR (${root}), got ${file}. ` +
        'The file holds throwaway Compose credentials and is removed by the workdir cleanup trap; ' +
        'a path outside that directory would survive the run.',
      )
    }
  }
  return file
}

/**
 * Write the four throwaway interpolation values, and nothing else, mode 0600.
 *
 * ⚠️ The values are NEVER printed, logged, echoed or returned. The only thing
 *    that ever leaves this function is the path.
 *
 * `writeFile`'s `mode` applies on creation and is masked by the process umask,
 * and is ignored entirely when the file already exists — so the mode is set
 * again explicitly afterwards rather than assumed.
 */
async function writeComposeEnvFile(file, values) {
  const lines = COMPOSE_INTERPOLATION_KEYS.map((key) => {
    const value = values[key]
    // Compose's env-file parser has no quoting rules worth relying on. Every
    // value here is generated by this file (`base64url`, or the fixed
    // `ps6_admin`), so refusing anything outside that charset costs nothing and
    // removes a whole class of injection into the file.
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error(`${key} must be a non-empty [A-Za-z0-9_-] value before it can be written to the Compose env file`)
    }
    return `${key}=${value}`
  })
  await writeFile(file, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'w' })
  await chmod(file, 0o600)
  const mode = (await stat(file)).mode & 0o777
  if (mode !== 0o600) throw new Error(`the Compose env file must be mode 0600, got 0${mode.toString(8)}`)
  return file
}

// ═══ In-container client programs ════════════════════════════════════════════
//
// Programs are fed to `node` on STDIN rather than through `node -e`, so their
// length is never bounded by the platform's command-line limit and nothing in
// them has to survive shell quoting.

/**
 * A minimal cookie+CSRF client, and a raw-target HTTP request function.
 *
 * It speaks node:http rather than fetch on purpose: fetch normalises a request
 * target such as `/s/<token>/../api/me`, and the un-normalised target is exactly
 * what the gateway's traversal guard has to be tested against.
 */
const PRELUDE = `
const http = require('node:http')
const crypto = require('node:crypto')

/** One request. Returns headers plus a sha256/length of the body, never the body itself unless asked. */
function send(opts) {
  return new Promise((resolve) => {
    const req = http.request({
      host: opts.host, port: opts.port, path: opts.path,
      method: opts.method || 'GET', headers: opts.headers || {},
      // setHost false: the caller owns the Host header completely, including
      // the poisoned values this suite has to be able to send.
      setHost: false,
    }, (res) => {
      const hash = crypto.createHash('sha256')
      let length = 0
      const keep = []
      let kept = 0
      res.on('data', (chunk) => {
        hash.update(chunk)
        length += chunk.length
        if (opts.captureBytes && kept < opts.captureBytes) { keep.push(chunk); kept += chunk.length }
      })
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, length,
        sha256: hash.digest('hex'),
        text: opts.captureBytes ? Buffer.concat(keep).toString('utf8').slice(0, opts.captureBytes) : null,
      }))
      res.on('error', (e) => resolve({ error: e.code || e.message, status: 0 }))
    })
    req.on('error', (e) => resolve({ error: e.code || e.message, status: 0 }))
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

function out(value) { process.stdout.write(JSON.stringify(value)) }
`

/** Session helper used on the PRIVATE path, from inside the drive container. */
const PRIVATE_SESSION = `
const DRIVE = { host: '127.0.0.1', port: 8001 }

class Session {
  constructor(hostHeader) { this.cookie = null; this.csrf = null; this.hostHeader = hostHeader || 'localhost' }

  async json(path, { method = 'GET', body, headers = {} } = {}) {
    const h = Object.assign({ Host: this.hostHeader }, headers)
    if (this.cookie) h.cookie = this.cookie
    if (this.csrf && method !== 'GET') h['X-CSRF-Token'] = this.csrf
    let payload = null
    if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(payload) }
    const res = await send({ ...DRIVE, path, method, headers: h, body: payload, captureBytes: 65536 })
    const setCookie = res.headers && res.headers['set-cookie']
    if (setCookie && setCookie.length) this.cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
    let data = null
    try { data = JSON.parse(res.text) } catch (e) { data = null }
    return { status: res.status, data, headers: res.headers }
  }

  /** Log in, walking the seed account's mandatory first-login password reset. */
  async login(username, seedPassword, resetPassword) {
    let used = resetPassword
    let res = await this.json('/api/login', { method: 'POST', body: { username, password: resetPassword } })
    if (res.status !== 200) {
      used = seedPassword
      res = await this.json('/api/login', { method: 'POST', body: { username, password: seedPassword } })
    }
    if (res.status !== 200) throw new Error('login failed: ' + res.status + ' ' + JSON.stringify(res.data))
    this.csrf = res.data.csrfToken
    if (res.data.user && res.data.user.mustResetPassword) {
      const reset = await this.json('/api/password/reset', {
        method: 'POST', body: { currentPassword: used, newPassword: resetPassword },
      })
      if (reset.status !== 200) throw new Error('force-reset failed: ' + reset.status + ' ' + JSON.stringify(reset.data))
    }
    return res.data
  }
}
`

/**
 * Run `docker <args>` with `input` written to its stdin.
 *
 * execFile has no `input` option — that belongs to the *Sync variants — so the
 * stdin-fed calls (migration SQL, in-container programs) go through spawn.
 * Rejects on a non-zero exit, so `assert.rejects` still expresses "this must
 * not be permitted".
 */
function dockerStdin(args, input, { env, timeoutMs = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(DOCKER_BIN, [...DOCKER_PREFIX, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`docker ${args.slice(0, 3).join(' ')} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`docker exited ${code}: ${stderr.slice(0, 4000)}`))
      resolve({ stdout, stderr })
    })
    child.stdin.end(input)
  })
}

/**
 * Run a program inside a container and parse its JSON stdout.
 *
 * @param {string} containerId
 * @param {string} program CommonJS source, fed on stdin
 * @param {{ timeoutMs?: number }} [options]
 */
async function runNode(containerId, program, { timeoutMs = 600_000 } = {}) {
  const { stdout, stderr } = await dockerStdin(['exec', '-i', containerId, 'node'], program, { timeoutMs })
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`in-container program printed non-JSON: ${stdout.slice(0, 2000)} / stderr ${stderr.slice(0, 2000)}`)
  }
}

// ═══ The suite ═══════════════════════════════════════════════════════════════

test('PS6-INT the real gateway integrates with the real Drive on an internal address', {
  skip: ENABLED ? false : 'set PUBLIC_SHARE_INTEGRATION_RUNTIME=1 to run the isolated Docker harness',
  timeout: 1_800_000,
}, async (t) => {
  // Throwaway credentials, generated here, never read from or written to a .env.
  const env = {
    ...process.env,
    PS6_SUPER_USER: 'ps6_admin',
    PS6_SUPER_PASSWORD: randomBytes(18).toString('base64url'),
    PS6_DRIVE_DB_PASSWORD: randomBytes(18).toString('base64url'),
    PS6_SESSION_SECRET: randomBytes(32).toString('base64url'),
  }

  const docker = (args, options = {}) => execFileAsync(DOCKER_BIN, [...DOCKER_PREFIX, ...args], {
    env, maxBuffer: 64 * 1024 * 1024, ...options,
  })
  /**
   * Every Compose invocation in this file, and the only place `--env-file` is
   * ever added.
   *
   * ⚠️ `--env-file` is a top-level Compose flag: it has to come BEFORE `-p` and
   *    `-f`, and before the subcommand. Placing it after the subcommand is a
   *    different, service-scoped flag and would not supply interpolation.
   *
   * With no owned env file — the developer-machine path — the argv is
   * byte-for-byte what it was before: `compose -p <project> -f <file> …`.
   */
  const compose = (args, options) => docker([
    'compose',
    ...(COMPOSE_ENV_FILE ? ['--env-file', COMPOSE_ENV_FILE] : []),
    '-p', PROJECT, '-f', COMPOSE_FILE,
    ...args,
  ], options)

  // The values have to be on disk BEFORE the first Compose invocation, because
  // the very first one (`up --build`) is the one that interpolates them. Nothing
  // below prints the file, its contents, or any of the four values.
  if (COMPOSE_ENV_FILE) {
    await writeComposeEnvFile(COMPOSE_ENV_FILE, env)
    const mode = (await stat(COMPOSE_ENV_FILE)).mode & 0o777
    assert.equal(mode, 0o600, 'the Compose env file must be readable only by its owner')
    if (process.env.PS6_WORKDIR) {
      const rel = relative(resolve(process.env.PS6_WORKDIR), COMPOSE_ENV_FILE)
      assert.ok(
        rel !== '' && !rel.startsWith('..') && !isAbsolute(rel),
        'the Compose env file must live inside PS6_WORKDIR, which is what the cleanup trap removes',
      )
    }
    // The path is evidence; the contents never are.
    console.log(`[ps6] Compose interpolation is supplied by ${COMPOSE_ENV_FILE} (mode 0600, contents never printed)`)
  }

  // Fixed network names are part of the accepted contract. Refuse to adopt or
  // delete a pre-existing network whose ownership is unknown.
  for (const name of NETWORKS) {
    await assert.rejects(
      docker(['network', 'inspect', name]),
      `${name} already exists — refusing to adopt a network this harness did not create`,
    )
  }

  let started = false
  t.after(async () => {
    if (!started) return
    await compose(['down', '--volumes', '--remove-orphans', '--timeout', '10']).catch(() => {})
  })

  started = true
  await compose(['up', '--build', '-d', '--wait', '--wait-timeout', '300'])

  const idOf = async (service) => (await compose(['ps', '-q', service])).stdout.trim()
  const [gatewayId, driveId, postgresId, recipientId] = await Promise.all(
    ['public-share-gateway', 'drive', 'postgres', 'recipient'].map(idOf),
  )
  assert.ok(gatewayId && driveId && postgresId && recipientId, 'all four containers must be running')

  /** Run SQL as the bootstrap superuser. Returns trimmed stdout. */
  const psql = async (sql, { db = 'aegis_drive' } = {}) => (await docker([
    'exec', '-e', `PGPASSWORD=${env.PS6_SUPER_PASSWORD}`, postgresId,
    'psql', '-v', 'ON_ERROR_STOP=1', '-U', env.PS6_SUPER_USER, '-d', db, '-tAc', sql,
  ])).stdout.trim()

  const scopeConstraint = () => psql(
    "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'shares_scope_check'",
  )

  /** Feed a whole SQL file to psql on stdin, as a chosen role. */
  const psqlScript = (sql, { user = env.PS6_SUPER_USER, password = env.PS6_SUPER_PASSWORD } = {}) => dockerStdin([
    'exec', '-i', '-e', `PGPASSWORD=${password}`, postgresId,
    'psql', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', 'aegis_drive', '-f', '-',
  ], sql, { timeoutMs: 120_000 })

  /** Everything the run needs to know about the artifact under test. */
  const artifact = { token: null, sha256: null, size: null, shareId: null, fileId: null }

  // ── PS6-INT-1 ──────────────────────────────────────────────────────────────
  await t.test('PS6-INT-1 three internal isolated networks, and no host port anywhere', async () => {
    for (const name of NETWORKS) {
      const net = JSON.parse((await docker(['network', 'inspect', name])).stdout)[0]
      assert.equal(net.Internal, true, `${name} must be internal`)
      assert.equal(
        net.Options?.['com.docker.network.bridge.gateway_mode_ipv4'], 'isolated',
        `${name} must also drop the Docker-host bridge address; internal alone leaves it reachable`,
      )
    }

    // Membership by container ID, from the networks' own point of view rather
    // than from the compose file that claimed it. Comparing IDs avoids depending
    // on how compose happens to name containers.
    const membersOf = async (name) => {
      const net = JSON.parse((await docker(['network', 'inspect', name])).stdout)[0]
      return new Set(Object.keys(net.Containers ?? {}))
    }
    const expect = async (name, ids, label) => {
      const members = await membersOf(name)
      assert.deepEqual([...members].sort(), [...ids].sort(), `${name} must hold exactly ${label}`)
    }
    await expect(EDGE_NETWORK, [recipientId, gatewayId], 'the recipient and the gateway')
    await expect(UPSTREAM_NETWORK, [gatewayId, driveId], 'the gateway and Drive')
    await expect(DATA_NETWORK, [driveId, postgresId], 'Drive and PostgreSQL')

    // No published host port on any service. Docker cannot publish from an
    // internal network, so this asserts the invariant rather than creating it —
    // which is the point: it fails loudly if someone later un-internals a network.
    const ps = (await compose(['ps', '--format', 'json'])).stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    assert.equal(ps.length, 4, 'exactly four services')
    for (const service of ps) {
      assert.equal(
        String(service.Publishers ? service.Publishers.filter((p) => p.PublishedPort).length : 0), '0',
        `${service.Service} must publish no host port`,
      )
    }
  })

  // ── PS6-INT-2 ──────────────────────────────────────────────────────────────
  await t.test('PS6-INT-2 the recipient can reach the gateway and nothing else', async () => {
    const probe = `${PRELUDE}
const net = require('node:net')
const targets = ${JSON.stringify([
      { label: 'gateway', host: GATEWAY_EDGE_IP, port: 8080, expect: 'open' },
      { label: 'drive-by-name', host: 'drive', port: 8001, expect: 'closed' },
      { label: 'drive-by-address', host: DRIVE_UPSTREAM_IP, port: 8001, expect: 'closed' },
      { label: 'postgres-by-name', host: 'postgres', port: 5432, expect: 'closed' },
      { label: 'postgres-by-address', host: POSTGRES_IP, port: 5432, expect: 'closed' },
      { label: 'gateway-upstream-leg', host: GATEWAY_UPSTREAM_IP, port: 8080, expect: 'closed' },
    ])}
const probe = (t) => new Promise((resolve) => {
  const socket = net.connect({ host: t.host, port: t.port })
  const done = (result) => { socket.destroy(); resolve({ label: t.label, expect: t.expect, result }) }
  socket.setTimeout(5000)
  socket.on('connect', () => done('open'))
  socket.on('timeout', () => done('timeout'))
  socket.on('error', (e) => done(e.code || 'error'))
})
Promise.all(targets.map(probe)).then(out)
`
    const results = await runNode(recipientId, probe, { timeoutMs: 60_000 })
    for (const r of results) {
      if (r.expect === 'open') {
        assert.equal(r.result, 'open', `recipient must reach ${r.label}`)
      } else {
        assert.notEqual(r.result, 'open', `recipient must NOT reach ${r.label} — it did`)
      }
    }
  })

  // ── PS6-INT-3 ──────────────────────────────────────────────────────────────
  await t.test('PS6-INT-3 migration 009 is load-bearing on a real 008-era database', async () => {
    // The harness deliberately provisions the pre-009 shape, so this measures the
    // migration rather than schema.sql. Prove that starting point first.
    const before = await scopeConstraint()
    assert.ok(before, 'shares_scope_check must exist before the migration')
    assert.doesNotMatch(before, /'public'/, `the harness database must start pre-009, saw: ${before}`)
    for (const value of PRE_009_SCOPES) {
      assert.match(before, new RegExp(`'${value}'`), `pre-009 CHECK must still carry '${value}'`)
    }

    // The 008-era constraint this harness reconstructs is the one migration 009
    // itself names. Assert that against the real file rather than trusting the
    // db-init script's comment.
    const sql009 = await readFile(MIGRATION_009, 'utf8')
    assert.match(sql009, /CHECK \(scope IN \('any', 'zones', 'public', 'vlan', 'subnet'\)\)/,
      'migration 009 must add exactly the five-value CHECK this test expects')

    // End to end, through the real application: a public share cannot be minted
    // while the database still carries the old constraint. This is the negative
    // control that makes the migration load-bearing rather than decorative.
    const provision = `${PRELUDE}${PRIVATE_SESSION}
;(async () => {
  const s = new Session('localhost')
  await s.login(${JSON.stringify(SEED_USER)}, ${JSON.stringify(SEED_PASSWORD)}, ${JSON.stringify(RESET_PASSWORD)})
  const body = Buffer.alloc(1024, 0x61)
  const boundary = '----ps6probe' + Date.now()
  const parts = Buffer.concat([
    Buffer.from('--' + boundary + '\\r\\nContent-Disposition: form-data; name="file"; filename="ps6-probe.bin"\\r\\nContent-Type: application/octet-stream\\r\\n\\r\\n'),
    body, Buffer.from('\\r\\n--' + boundary + '--\\r\\n'),
  ])
  const up = await send({ ...DRIVE, path: '/api/files/upload', method: 'POST', captureBytes: 65536,
    headers: { Host: 'localhost', cookie: s.cookie, 'X-CSRF-Token': s.csrf,
      'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': parts.length }, body: parts })
  const uploaded = JSON.parse(up.text)
  const share = await s.json('/api/shares', { method: 'POST', body: {
    fileId: uploaded.file.id, expiry: '1h', authType: 'password', scope: 'public', password: ${JSON.stringify(LINK_PASSWORD)},
  } })
  out({ uploadStatus: up.status, fileId: uploaded.file.id, shareStatus: share.status, shareBody: share.data })
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1) })
`
    const pre = await runNode(driveId, provision, { timeoutMs: 180_000 })
    assert.equal(pre.uploadStatus, 201, 'the probe upload must succeed on the private path')
    assert.notEqual(pre.shareStatus, 201,
      'a public share must NOT be creatable before migration 009 — the database constraint has to refuse it')

    // Apply the real migration file, as a superuser. The application role must
    // not be able to: migrations stay deployment work, not runtime work.
    const migrationSql = await readFile(MIGRATION_009, 'utf8')
    await psqlScript(migrationSql)

    const after = await scopeConstraint()
    assert.match(after, /'public'/, `migration 009 must widen the CHECK, saw: ${after}`)
    for (const value of PRE_009_SCOPES) {
      assert.match(after, new RegExp(`'${value}'`), `009 must preserve the legacy value '${value}'`)
    }

    // Re-running is safe, as the migration's own header claims.
    await psqlScript(migrationSql)
    assert.equal(await scopeConstraint(), after, 're-running migration 009 must be a no-op')

    // The scoped application role owns no table, so it cannot run this itself.
    await assert.rejects(
      psqlScript(migrationSql, { user: 'drive_app', password: env.PS6_DRIVE_DB_PASSWORD }),
      'drive_app must NOT be able to apply a migration',
    )
  })

  // ── PS6-INT-4 ──────────────────────────────────────────────────────────────
  await t.test('PS6-INT-4 the private path uploads 64 MiB and mints a public share', async () => {
    const provision = `${PRELUDE}${PRIVATE_SESSION}
const FILE_BYTES = ${FILE_BYTES}
;(async () => {
  const s = new Session('localhost')
  await s.login(${JSON.stringify(SEED_USER)}, ${JSON.stringify(SEED_PASSWORD)}, ${JSON.stringify(RESET_PASSWORD)})

  // Deterministic, incompressible-enough content derived from a fixed seed, so
  // the expected digest is a property of the test rather than of a lucky run.
  const body = Buffer.alloc(FILE_BYTES)
  let seed = crypto.createHash('sha256').update('ps6-payload').digest()
  for (let off = 0; off < FILE_BYTES; off += 32) {
    seed = crypto.createHash('sha256').update(seed).digest()
    seed.copy(body, off, 0, Math.min(32, FILE_BYTES - off))
  }
  const expected = crypto.createHash('sha256').update(body).digest('hex')

  const boundary = '----ps6payload' + Date.now()
  const head = Buffer.from('--' + boundary + '\\r\\nContent-Disposition: form-data; name="file"; filename="ps6-payload.bin"\\r\\nContent-Type: application/octet-stream\\r\\n\\r\\n')
  const tail = Buffer.from('\\r\\n--' + boundary + '--\\r\\n')
  const parts = Buffer.concat([head, body, tail])
  const up = await send({ ...DRIVE, path: '/api/files/upload', method: 'POST', captureBytes: 65536,
    headers: { Host: 'localhost', cookie: s.cookie, 'X-CSRF-Token': s.csrf,
      'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': parts.length }, body: parts })
  const uploaded = JSON.parse(up.text)

  // Created through a request carrying a POISONED Host header. The public URL
  // must come from PUBLIC_SHARE_BASE_URL alone.
  const poisoned = new Session('evil.attacker.invalid')
  poisoned.cookie = s.cookie; poisoned.csrf = s.csrf
  const share = await poisoned.json('/api/shares', { method: 'POST', body: {
    fileId: uploaded.file.id, expiry: '1h', authType: 'password', scope: 'public', password: ${JSON.stringify(LINK_PASSWORD)},
  } })

  // A second, NON-public share for the ingress-split test.
  const priv = await s.json('/api/shares', { method: 'POST', body: {
    fileId: uploaded.file.id, expiry: '1h', authType: 'none', scope: 'any',
  } })

  out({
    uploadStatus: up.status, serverSha256: uploaded.file.sha256, serverSize: uploaded.file.size,
    expectedSha256: expected, fileId: uploaded.file.id,
    shareStatus: share.status, publicUrl: share.data && share.data.publicUrl,
    path: share.data && share.data.path, shareId: share.data && share.data.share && share.data.share.id,
    scope: share.data && share.data.share && share.data.share.scope,
    privateStatus: priv.status, privatePath: priv.data && priv.data.path,
    privatePublicUrl: priv.data ? (priv.data.publicUrl ?? null) : null,
  })
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1) })
`
    const r = await runNode(driveId, provision, { timeoutMs: 900_000 })
    assert.equal(r.uploadStatus, 201, 'the 64 MiB upload must succeed on the private path')
    assert.equal(r.serverSize, FILE_BYTES, 'the server must store exactly the bytes that were sent')
    assert.equal(r.serverSha256, r.expectedSha256,
      'the server-side digest must match the digest of the deterministic payload')

    assert.equal(r.shareStatus, 201, 'a public share must be creatable now that 009 is applied')
    assert.equal(r.scope, 'public')
    assert.equal(r.publicUrl, `${BASE_URL}${r.path}`,
      'the public URL must be the configured origin plus the server-created path')
    assert.doesNotMatch(String(r.publicUrl), /evil\.attacker\.invalid/,
      'T-09: a poisoned Host must contribute nothing to the public URL')

    assert.equal(r.privateStatus, 201, 'the non-public control share must be creatable')
    assert.equal(r.privatePublicUrl, null, "a non-public share must not carry a publicUrl")

    artifact.token = r.path.replace('/s/', '')
    artifact.privateToken = r.privatePath.replace('/s/', '')
    artifact.sha256 = r.serverSha256
    artifact.size = r.serverSize
    artifact.shareId = r.shareId
    artifact.fileId = r.fileId
  })

  /** Drive the gateway as the recipient, from the edge network. */
  const recipientRequest = async (spec, { timeoutMs = 600_000 } = {}) => {
    const program = `${PRELUDE}
send(${JSON.stringify({ host: GATEWAY_EDGE_IP, port: 8080, ...spec })}).then(out)
`
    return runNode(recipientId, program, { timeoutMs })
  }

  const formBody = (password) => `password=${encodeURIComponent(password)}`
  const redeemSpec = (token, password, extraHeaders = {}) => ({
    path: `/s/${token}`, method: 'POST', body: formBody(password),
    headers: {
      Host: HOST, 'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(Buffer.byteLength(formBody(password))), ...extraHeaders,
    },
  })

  const hitsOf = async (shareId) => Number(await psql(`SELECT hits FROM shares WHERE id = ${Number(shareId)}`))

  // ── PS6-INT-5 ──────────────────────────────────────────────────────────────
  await t.test('PS6-INT-5 normal redemption end to end through the real gateway', async () => {
    const form = await recipientRequest({ path: `/s/${artifact.token}`, headers: { Host: HOST }, captureBytes: 65536 })
    assert.equal(form.status, 200, 'the password page must render through the gateway')
    assert.match(String(form.headers['content-type']), /text\/html/)
    // The password page carries its controls as a per-response CSP header plus a
    // robots META TAG — server/routes/share.js `page()` sets no X-Robots-Tag —
    // so both are asserted where they actually live. The gateway must relay them
    // unchanged; a proxy that dropped either would fail here.
    assert.match(String(form.headers['content-security-policy'] ?? ''), /default-src 'none'/)
    assert.match(String(form.headers['content-security-policy'] ?? ''), /frame-ancestors 'none'/)
    assert.equal(form.headers['referrer-policy'], 'no-referrer')
    assert.match(String(form.headers['cache-control']), /no-store/)
    assert.match(String(form.text ?? ''), /<meta name="robots" content="noindex,nofollow">/)
    assert.doesNotMatch(String(form.text ?? ''), /<script/i, 'the password page must contain no JavaScript')

    const wrong = await recipientRequest(redeemSpec(artifact.token, WRONG_LINK_PASSWORD))
    assert.notEqual(wrong.status, 200, 'a wrong link password must not deliver')
    assert.notEqual(wrong.length, FILE_BYTES, 'a wrong link password must not deliver the file bytes')

    const before = await hitsOf(artifact.shareId)
    const ok = await recipientRequest(redeemSpec(artifact.token, LINK_PASSWORD))
    assert.equal(ok.status, 200, 'the correct link password must deliver')
    assert.equal(ok.length, FILE_BYTES, 'the delivered length must be exact')
    assert.equal(ok.sha256, artifact.sha256, 'the delivered bytes must be byte-identical to what Drive stored')
    assert.match(String(ok.headers['content-type']), /application\/octet-stream/)
    assert.match(String(ok.headers['content-disposition']), /attachment/)
    assert.equal(ok.headers['x-content-type-options'], 'nosniff')
    assert.match(String(ok.headers['cache-control']), /no-store/)
    assert.equal(await hitsOf(artifact.shareId), before + 1,
      'exactly one hit per delivery — the form view and the wrong password must count none')
  })

  // ── PS6-INT-6 ──────────────────────────────────────────────────────────────
  await t.test('PS6-INT-6 a slow client with a 75s stall completes intact', async () => {
    // 75s exceeds the 60s nginx default for proxy_read_timeout and send_timeout.
    // With `proxy_buffering off` the gateway stops reading from Drive while the
    // recipient is not draining, so this stall lands on those very timers. It
    // passes only because the shipped template raises both to 300s — remove that
    // and this test fails, which is what makes it load-bearing rather than slow.
    const program = `${PRELUDE}
const started = Date.now()
const body = ${JSON.stringify(formBody(LINK_PASSWORD))}
const req = http.request({
  host: ${JSON.stringify(GATEWAY_EDGE_IP)}, port: 8080, path: ${JSON.stringify(`/s/${artifact.token}`)},
  method: 'POST', setHost: false,
  headers: { Host: ${JSON.stringify(HOST)}, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
}, (res) => {
  const hash = crypto.createHash('sha256')
  let length = 0
  let stalled = false
  res.on('data', (chunk) => {
    hash.update(chunk); length += chunk.length
    if (!stalled && length >= 1024 * 1024) {
      // One long stall, then drain at full speed. A single 75s gap is the
      // measurement; dribbling would only test the total duration.
      stalled = true
      res.pause()
      setTimeout(() => res.resume(), 75000)
    }
  })
  res.on('end', () => out({ status: res.statusCode, length, sha256: hash.digest('hex'), ms: Date.now() - started, stalled }))
  res.on('error', (e) => out({ error: e.code || e.message, length, ms: Date.now() - started }))
})
req.on('error', (e) => out({ error: e.code || e.message, ms: Date.now() - started }))
req.end(body)
`
    const slow = await runNode(recipientId, program, { timeoutMs: 600_000 })
    assert.equal(slow.error, undefined, `the slow transfer must not error: ${slow.error}`)
    assert.equal(slow.stalled, true, 'the stall must actually have been taken')
    assert.equal(slow.status, 200)
    assert.equal(slow.length, FILE_BYTES, 'a slow client must still receive every byte')
    assert.equal(slow.sha256, artifact.sha256, 'a slow client must receive the same bytes')
    assert.ok(slow.ms > 75_000, `the transfer must genuinely have outlived a 60s default, took ${slow.ms}ms`)
  })

  // ── PS6-INT-7 ──────────────────────────────────────────────────────────────
  await t.test('PS6-INT-7 an interrupted transfer harms neither the gateway nor Drive', async () => {
    const before = await hitsOf(artifact.shareId)
    const program = `${PRELUDE}
const body = ${JSON.stringify(formBody(LINK_PASSWORD))}
const req = http.request({
  host: ${JSON.stringify(GATEWAY_EDGE_IP)}, port: 8080, path: ${JSON.stringify(`/s/${artifact.token}`)},
  method: 'POST', setHost: false,
  headers: { Host: ${JSON.stringify(HOST)}, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
}, (res) => {
  let length = 0
  res.on('data', (chunk) => {
    length += chunk.length
    if (length >= 1024 * 1024) { req.destroy(); out({ status: res.statusCode, aborted: true, length }) }
  })
  res.on('end', () => out({ status: res.statusCode, aborted: false, length }))
  res.on('error', () => { /* the abort surfaces here; already reported */ })
})
req.on('error', () => { /* expected after destroy */ })
req.end(body)
`
    const cut = await runNode(recipientId, program, { timeoutMs: 300_000 })
    assert.equal(cut.aborted, true, 'the transfer must actually have been interrupted')
    assert.ok(cut.length < FILE_BYTES, 'the interrupted transfer must be partial')

    // The hit is counted at authorization time, before a single byte is streamed
    // (server/routes/share.js counts, then delivers). So an aborted download
    // DOES count. That is recorded as observed behaviour, not asserted as a
    // desirable property — see this suite's limitations in the receipt.
    assert.equal(await hitsOf(artifact.shareId), before + 1,
      'an authorised-then-interrupted redemption counts one hit, because counting precedes delivery')

    // Both tiers survived, and a full redemption still works afterwards.
    await sleep(1000)
    const health = JSON.parse((await docker(['inspect', '-f', '{{json .State.Health.Status}}', driveId])).stdout.trim())
    assert.equal(health, 'healthy', 'Drive must still be healthy after a client abort')
    const again = await recipientRequest(redeemSpec(artifact.token, LINK_PASSWORD))
    assert.equal(again.status, 200)
    assert.equal(again.sha256, artifact.sha256, 'a full redemption after an abort must still be intact')
  })

  // ── PS6-INT-8 ──────────────────────────────────────────────────────────────
  await t.test('PS6-INT-8 concurrent downloads all complete intact', async () => {
    const CONCURRENCY = 4
    const before = await hitsOf(artifact.shareId)
    const program = `${PRELUDE}
const body = ${JSON.stringify(formBody(LINK_PASSWORD))}
const one = () => send({
  host: ${JSON.stringify(GATEWAY_EDGE_IP)}, port: 8080, path: ${JSON.stringify(`/s/${artifact.token}`)},
  method: 'POST', body,
  headers: { Host: ${JSON.stringify(HOST)}, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
})
const started = Date.now()
Promise.all(Array.from({ length: ${CONCURRENCY} }, one))
  .then((rs) => out({ ms: Date.now() - started, results: rs.map((r) => ({ status: r.status, length: r.length, sha256: r.sha256, error: r.error })) }))
`
    const runs = await runNode(recipientId, program, { timeoutMs: 900_000 })
    assert.equal(runs.results.length, CONCURRENCY)
    for (const [i, r] of runs.results.entries()) {
      assert.equal(r.error, undefined, `concurrent download ${i} errored: ${r.error}`)
      assert.equal(r.status, 200, `concurrent download ${i} status`)
      assert.equal(r.length, FILE_BYTES, `concurrent download ${i} length`)
      assert.equal(r.sha256, artifact.sha256, `concurrent download ${i} digest`)
    }
    assert.equal(await hitsOf(artifact.shareId), before + CONCURRENCY,
      'every concurrent delivery must count exactly one hit')
  })

  // ── PS6-INT-9 ──────────────────────────────────────────────────────────────
  await t.test('PS6-INT-9 no AEGIS surface but /s/:token is reachable through the gateway', async () => {
    const auditBefore = Number(await psql('SELECT count(*) FROM audit_log'))

    const forbidden = [
      '/', '/healthz', '/drive/', '/drive/index.html', '/monitor/',
      '/api', '/api/me', '/api/shares', '/api/files', '/api/audit',
      // Traversal: normalises to /api/me, but the RAW target is what the map checks.
      `/s/${artifact.token}/../api/me`,
      `/s/${artifact.token}/../../api/me`,
      '/s/', '/s',
    ]
    const program = `${PRELUDE}
const paths = ${JSON.stringify(forbidden)}
Promise.all(paths.map((p) => send({
  host: ${JSON.stringify(GATEWAY_EDGE_IP)}, port: 8080, path: p, headers: { Host: ${JSON.stringify(HOST)} }, captureBytes: 4096,
}).then((r) => ({ path: p, status: r.status, text: r.text, error: r.error })))).then(out)
`
    const results = await runNode(recipientId, program, { timeoutMs: 120_000 })
    for (const r of results) {
      assert.equal(r.status, 404, `${r.path} must be refused by the gateway, got ${r.status}`)
      assert.doesNotMatch(String(r.text ?? ''), /AEGIS|csrfToken|DataLake|aegis_drive/i,
        `${r.path} must not return anything from the application`)
    }

    // A method the contract does not allow, on the one allowed route.
    const put = await recipientRequest({ path: `/s/${artifact.token}`, method: 'PUT', headers: { Host: HOST }, captureBytes: 4096 })
    assert.equal(put.status, 405, 'only GET and POST are allowed on the share route')

    // The decisive half: none of that reached Drive. Every refused request was
    // terminated by nginx, so the application recorded nothing at all.
    assert.equal(Number(await psql('SELECT count(*) FROM audit_log')), auditBefore,
      'not one refused request may reach the application')

    // An alternate-case form of the ONE allowed route. Both the gateway's
    // location and its route map are case-insensitive (`~*`), and Express is
    // case-insensitive by default, so this is a spelling of the share route
    // rather than a new surface — it is deliberately NOT asserted to 404. What
    // must hold is the security property: it is still a gated redemption and
    // cannot hand over the file without the link password.
    const upper = await recipientRequest({ path: `/S/${artifact.token}`, headers: { Host: HOST }, captureBytes: 4096 })
    assert.notEqual(upper.length, FILE_BYTES,
      'no spelling of the share route may deliver the file without the link password')
    assert.doesNotMatch(String(upper.text ?? ''), /csrfToken|DataLake/i,
      'no spelling of the share route may expose an application surface')
  })

  // ── PS6-INT-10 ─────────────────────────────────────────────────────────────
  await t.test('PS6-INT-10 forged forwarding headers cannot move the attributed source', async () => {
    const forged = await recipientRequest(redeemSpec(artifact.token, LINK_PASSWORD, {
      'X-Forwarded-For': '203.0.113.9',
      'X-Real-IP': '203.0.113.9',
      Forwarded: 'for=203.0.113.9;proto=https;host=evil.attacker.invalid',
    }))
    assert.equal(forged.status, 200, 'the redemption itself is legitimate; only the headers are forged')

    const source = await psql(
      "SELECT host(source_ip) FROM audit_log WHERE action = 'SHARE_REDEEM' AND result = 'OK' ORDER BY id DESC LIMIT 1",
    )
    assert.equal(source, RECIPIENT_IP,
      'the audit must attribute the real recipient address the gateway observed')
    assert.notEqual(source, '203.0.113.9', 'a forged X-Forwarded-For must not reach attribution')
    assert.notEqual(source, GATEWAY_UPSTREAM_IP, 'the gateway peer must not be attributed as the recipient')

    // Nothing secret reached the audit, from a real end-to-end redemption.
    const leaked = await psql(
      `SELECT count(*) FROM audit_log WHERE actor_label LIKE '%${artifact.token}%' OR target_hash LIKE '%${artifact.token}%'`,
    )
    assert.equal(Number(leaked), 0, 'the raw share token must never reach the audit')
  })

  // ── PS6-INT-11 ─────────────────────────────────────────────────────────────
  await t.test('PS6-INT-11 an unknown Host terminates at the gateway', async () => {
    const auditBefore = Number(await psql('SELECT count(*) FROM audit_log'))
    for (const host of ['evil.attacker.invalid', '172.31.250.2', 'localhost', `${HOST}.attacker.invalid`]) {
      const res = await recipientRequest({ path: `/s/${artifact.token}`, headers: { Host: host }, captureBytes: 4096 })
      assert.equal(res.status, 404, `Host ${host} must fall to the default server, got ${res.status}`)
    }
    assert.equal(Number(await psql('SELECT count(*) FROM audit_log')), auditBefore,
      'a poisoned Host must not reach the application at all')
  })

  // ── PS6-INT-12 ─────────────────────────────────────────────────────────────
  await t.test('PS6-INT-12 the ingress split holds in both directions', async () => {
    // A non-public share offered to the gateway is refused, because arriving
    // through the public ingress is not a private ingress.
    const viaGateway = await recipientRequest({
      path: `/s/${artifact.privateToken}`, headers: { Host: HOST }, captureBytes: 4096,
    })
    assert.equal(viaGateway.status, 403,
      'a scope=any share must be out of scope when it arrives through the public gateway')
    assert.notEqual(viaGateway.length, FILE_BYTES)
    assert.equal(
      await psql("SELECT result FROM audit_log WHERE action = 'SHARE_REDEEM_OUT_OF_SCOPE' ORDER BY id DESC LIMIT 1"),
      'BLOCKED', 'the refusal must be recorded as BLOCKED')

    // The same link, from the private path, still works — the block is about the
    // ingress, not about the link having been damaged.
    const program = `${PRELUDE}
send({ host: '127.0.0.1', port: 8001, path: ${JSON.stringify(`/s/${artifact.privateToken}`)}, headers: { Host: 'localhost' } }).then(out)
`
    const viaPrivate = await runNode(driveId, program, { timeoutMs: 600_000 })
    assert.equal(viaPrivate.status, 200, 'the same share must still redeem on the private path')
    assert.equal(viaPrivate.length, FILE_BYTES)
    assert.equal(viaPrivate.sha256, artifact.sha256)
  })

  // ── PS6-INT-13 ─────────────────────────────────────────────────────────────
  await t.test('PS6-INT-13 B5 holds: the gateway reaches its upstream and nothing else', async () => {
    // Busybox in the nginx:alpine image. No default route means no Internet and
    // no Docker host; PostgreSQL is on a network the gateway is not a member of.
    const routes = (await docker(['exec', gatewayId, 'ip', 'route'])).stdout
    assert.doesNotMatch(routes, /^default /m, 'the gateway must have no default route')

    const probe = async (target, port) => {
      const out = await docker(['exec', gatewayId, 'sh', '-c',
        `nc -w 3 -z ${target} ${port} >/dev/null 2>&1 && echo open || echo closed`]).catch(() => ({ stdout: 'closed' }))
      return out.stdout.trim()
    }
    assert.equal(await probe('drive', 8001), 'open', 'the gateway must reach its one upstream')
    assert.equal(await probe(POSTGRES_IP, 5432), 'closed', 'the gateway must not reach PostgreSQL')
    assert.equal(await probe('172.31.250.1', 8080), 'closed', 'the gateway must not reach a host bridge address')
    assert.equal(await probe('172.31.251.1', 8001), 'closed', 'the gateway must not reach a host bridge address')

    // Token-safe logging survives a real end-to-end run: neither the token nor
    // the link password may appear in the gateway's own logs.
    const logs = (await docker(['logs', gatewayId])).stdout + (await docker(['logs', gatewayId])).stderr
    assert.ok(logs.length > 0, 'the gateway must have produced access logs to inspect')
    assert.ok(!logs.includes(artifact.token), 'the raw share token must never reach the gateway log')
    assert.ok(!logs.includes(LINK_PASSWORD), 'the link password must never reach the gateway log')
    assert.ok(!logs.includes(RECIPIENT_IP), 'the recipient address must not be persisted in the gateway log')
  })

  // ── PS6-INT-14 ─────────────────────────────────────────────────────────────
  await t.test('PS6-INT-14 revocation propagates through the gateway immediately', async () => {
    const program = `${PRELUDE}${PRIVATE_SESSION}
;(async () => {
  const s = new Session('localhost')
  await s.login(${JSON.stringify(SEED_USER)}, ${JSON.stringify(SEED_PASSWORD)}, ${JSON.stringify(RESET_PASSWORD)})
  const res = await s.json('/api/shares/' + ${JSON.stringify(String(artifact.shareId))}, { method: 'DELETE' })
  out({ status: res.status })
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1) })
`
    const revoked = await runNode(driveId, program, { timeoutMs: 120_000 })
    assert.equal(revoked.status, 200, 'the owner must be able to revoke')

    const before = await hitsOf(artifact.shareId)
    const after = await recipientRequest(redeemSpec(artifact.token, LINK_PASSWORD))
    assert.equal(after.status, 404, 'a revoked link must be indistinguishable from an unknown one')
    assert.notEqual(after.length, FILE_BYTES, 'a revoked link must deliver no bytes')
    assert.equal(await hitsOf(artifact.shareId), before, 'a revoked attempt must count no hit')
  })

  // ── PS6-INT-15 ─────────────────────────────────────────────────────────────
  await t.test('PS6-INT-15 the harness removes everything it created', async () => {
    await compose(['down', '--volumes', '--remove-orphans', '--timeout', '10'])
    started = false

    for (const name of NETWORKS) {
      await assert.rejects(docker(['network', 'inspect', name]), `${name} must be gone`)
    }
    for (const id of [gatewayId, driveId, postgresId, recipientId]) {
      await assert.rejects(docker(['container', 'inspect', id]), 'every harness container must be gone')
    }
    const remaining = (await docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${PROJECT}`])).stdout.trim()
    assert.equal(remaining, '', 'no container may survive the teardown')

    // Drive's /datalake is an anonymous volume, so Compose labels it with the
    // project and `down --volumes` is what removes it. Asserting the label query
    // is empty proves the removal happened rather than assuming the flag worked.
    const volumes = (await docker([
      'volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`,
    ])).stdout.trim()
    assert.equal(volumes, '', 'no volume may survive the teardown')

    // The teardown is project-scoped, so it must NOT have reached the shared
    // base images. This is the cheap negative that catches a future `--rmi all`.
    for (const image of ['postgres:15-alpine', 'node:20-alpine']) {
      await docker(['image', 'inspect', image])
    }
  })
})
