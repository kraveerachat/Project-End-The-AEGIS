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

/**
 * How much of that file is resident at once while it is being sent.
 *
 * ⚠️ Bounded on purpose. 256 KiB is large enough that the syscall count is
 *    irrelevant and small enough that the client's memory stays flat however big
 *    the acceptance object is. It must stay a multiple of 32: the deterministic
 *    payload is derived 32 bytes at a time, so a chunk size that was not a
 *    multiple of 32 would move the seed boundaries and change the file itself.
 */
const UPLOAD_CHUNK_BYTES = Number(process.env.PS6_UPLOAD_CHUNK_BYTES ?? 256 * 1024)
if (!Number.isInteger(UPLOAD_CHUNK_BYTES) || UPLOAD_CHUNK_BYTES % 32 !== 0
  || UPLOAD_CHUNK_BYTES < 32 * 1024 || UPLOAD_CHUNK_BYTES > 1024 * 1024) {
  throw new Error(
    `PS6_UPLOAD_CHUNK_BYTES must be a multiple of 32 between 32 KiB and 1 MiB, got ${UPLOAD_CHUNK_BYTES}`,
  )
}

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

let OUT_DONE = false
/** Emit the program's one JSON result. Idempotent: a later call cannot corrupt it. */
function out(value) { if (OUT_DONE) return; OUT_DONE = true; process.stdout.write(JSON.stringify(value)) }

/**
 * Secrets this program knows and must never emit. Populated by the caller after
 * a session exists, because the cookie and the CSRF token only exist then.
 */
const REDACT = []

/** A bounded, redacted excerpt. The only body text any diagnostic may carry. */
function redactPreview(text, max) {
  let s = String(text == null ? '' : text).slice(0, max || 200)
  for (const secret of REDACT) { if (secret) s = s.split(secret).join('<<redacted>>') }
  return s
}

/**
 * Describe a send() result without revealing it.
 *
 * WARNING: send() resolves { error, status: 0 } and NO 'text' on a transport
 *    error. Stage B attempt #2 fed that missing 'text' straight to JSON.parse,
 *    so the real failure -- the 64 MiB upload never completed -- surfaced as
 *    'SyntaxError: "undefined" is not valid JSON' and the real cause was lost.
 *    Nothing below parses anything until a body is known to exist.
 */
function describe(label, res, expectedStatus) {
  const hasText = typeof res.text === 'string' && res.text.length > 0
  return {
    label,
    expectedStatus,
    status: res.status == null ? 0 : res.status,
    error: res.error == null ? null : String(res.error),
    length: res.length == null ? 0 : res.length,
    hasText,
    bodyBytes: typeof res.text === 'string' ? res.text.length : 0,
    contentType: (res.headers && res.headers['content-type']) || null,
  }
}

/**
 * Parse a JSON response body ONLY when one actually exists.
 * Returns { ok: true, value } or { ok: false, diagnostic } — it never throws and
 * never calls JSON.parse on undefined.
 */
function parseJsonBody(label, res, expectedStatus) {
  const d = describe(label, res, expectedStatus)
  if (d.error) { d.reason = 'transport'; return { ok: false, diagnostic: d } }
  if (d.status !== expectedStatus) {
    d.reason = 'status'
    d.preview = redactPreview(res.text, 300)
    return { ok: false, diagnostic: d }
  }
  if (!d.hasText) { d.reason = 'empty-body'; return { ok: false, diagnostic: d } }
  try {
    return { ok: true, value: JSON.parse(res.text) }
  } catch (e) {
    d.reason = 'not-json'
    d.parseError = String((e && e.message) || e).slice(0, 200)
    d.preview = redactPreview(res.text, 300)
    return { ok: false, diagnostic: d }
  }
}
`

/**
 * The large-body upload client, used inside the Drive container.
 *
 * WARNING: Stage B attempt #3 died here, and this is why it exists.
 *    The previous client built a complete 64 MiB Buffer, concatenated it with
 *    the multipart head and tail into a SECOND complete Buffer, and handed the
 *    whole thing to one req.write(). On the AEGIS server host that request
 *    ended with:
 *
 *        PS6-INT-4 upload transport failure: status=0 error=EPIPE
 *
 *    with the Drive container running, healthy, exit code 0, OOMKilled false and
 *    zero restarts, and no error of its own in its log. A single unbounded write
 *    of a body that large is not a write model any HTTP client should use, and
 *    it is the one thing between "the harness asked" and "the socket broke" that
 *    the harness owns.
 *
 * WARNING: THIS IS A HARNESS CLIENT CHANGE ONLY. Same shipped endpoint
 *    (POST /api/files/upload), same 64 MiB, same deterministic bytes, same
 *    server-side SHA-256 comparison, same explicit Content-Length. Nothing is
 *    switched to the V2 chunked upload, to another endpoint, to a smaller file
 *    or to a weaker acceptance.
 *
 * The model: emit the multipart head, then the file in bounded chunks, then the
 * trailer; honour backpressure by waiting for 'drain' whenever write() returns
 * false; and never call end() until every chunk has been accepted for writing.
 * The whole body is never resident at once -- only one chunk is.
 */
const UPLOAD_CLIENT = `
/**
 * The deterministic payload, as a sequential source instead of one Buffer.
 *
 * Byte-for-byte the SAME payload the one-shot version produced: seed =
 * sha256(seed), 32 bytes at a time, starting from sha256(label). Chunk sizes are
 * multiples of 32, so where the chunk boundaries fall changes nothing.
 */
function deterministicSource(label) {
  let seed = crypto.createHash('sha256').update(label).digest()
  return function next(size) {
    const buf = Buffer.alloc(size)
    let off = 0
    while (off < size) {
      seed = crypto.createHash('sha256').update(seed).digest()
      const n = Math.min(32, size - off)
      seed.copy(buf, off, 0, n)
      off += n
    }
    return buf
  }
}

/**
 * Stream a multipart/form-data upload with an explicit, correct Content-Length,
 * honouring backpressure, without ever holding the whole body in one Buffer.
 *
 * Resolves ONE record that separates a response from a write failure:
 *
 *   status, headers, length, sha256, text   the response, when one arrived
 *   error                                   set ONLY when NO response arrived
 *   requestError / responseError            always recorded, independently
 *   responseStarted                         did the server begin a response
 *   contentLength / generatedBytes /
 *   writtenBytes / drainWaits /
 *   endedRequest / chunkBytes               the client-side write counters
 *   clientSha256                            digest of the FILE bytes generated
 *
 * WARNING: a server that answers 400 or 413 while the client is still writing
 *    will usually also break the client's pipe. That must be reported as the
 *    HTTP response it is, not collapsed into a generic EPIPE. So a request-side
 *    error does not settle the result immediately: it arms a bounded grace
 *    window, and a response that completes inside that window wins. The
 *    transport code is still recorded next to it.
 */
function uploadMultipart(o) {
  return new Promise((resolve) => {
    const head = Buffer.from(
      '--' + o.boundary + '\\r\\nContent-Disposition: form-data; name="' + o.fieldName +
      '"; filename="' + o.filename + '"\\r\\nContent-Type: application/octet-stream\\r\\n\\r\\n')
    const tail = Buffer.from('\\r\\n--' + o.boundary + '--\\r\\n')
    const chunkBytes = o.chunkBytes || 262144
    const contentLength = head.length + o.totalBytes + tail.length
    const graceMs = o.errorGraceMs === undefined ? 2000 : o.errorGraceMs

    const state = {
      contentLength, chunkBytes,
      generatedBytes: 0, writtenBytes: 0, drainWaits: 0,
      responseStarted: false, status: 0, headers: null,
      requestError: null, responseError: null, endedRequest: false,
      clientSha256: null, error: null,
    }

    const fileHash = crypto.createHash('sha256')
    let settled = false
    let graceTimer = null
    let releaseDrain = null

    const settle = (extra) => {
      if (settled) return
      settled = true
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null }
      // 'error' is the field the shared classifier reads. It is set ONLY when no
      // response arrived, so an HTTP answer is never reported as a transport
      // failure -- while requestError/responseError stay visible either way.
      if (!state.responseStarted) state.error = state.requestError || state.responseError
      const result = Object.assign({}, state, extra)
      try { req.destroy() } catch (e) { /* already gone */ }
      resolve(result)
    }
    const wake = () => { if (releaseDrain) { const r = releaseDrain; releaseDrain = null; r() } }

    const headers = Object.assign({}, o.headers || {}, {
      'Content-Type': 'multipart/form-data; boundary=' + o.boundary,
      'Content-Length': String(contentLength),
    })

    const req = http.request({
      host: o.host, port: o.port, path: o.path, method: 'POST', headers, setHost: false,
    }, (res) => {
      state.responseStarted = true
      state.status = res.statusCode
      state.headers = res.headers
      const hash = crypto.createHash('sha256')
      let length = 0
      const keep = []
      let kept = 0
      res.on('data', (c) => {
        hash.update(c)
        length += c.length
        if (o.captureBytes && kept < o.captureBytes) { keep.push(c); kept += c.length }
      })
      res.on('end', () => {
        wake()
        settle({
          length, sha256: hash.digest('hex'),
          text: o.captureBytes ? Buffer.concat(keep).toString('utf8').slice(0, o.captureBytes) : null,
        })
      })
      res.on('error', (e) => {
        state.responseError = e.code || e.message
        wake()
        settle({ length, text: o.captureBytes ? Buffer.concat(keep).toString('utf8').slice(0, o.captureBytes) : null })
      })
    })

    req.on('error', (e) => {
      state.requestError = e.code || e.message
      wake()
      // Give a response that may already be on the wire its bounded chance.
      if (graceTimer === null) graceTimer = setTimeout(() => settle({ length: 0, text: null }), graceMs)
      if (graceTimer.unref) graceTimer.unref()
    })

    const writeChunk = (buf) => new Promise((accepted) => {
      const ok = req.write(buf)
      state.writtenBytes += buf.length
      if (ok || settled) return accepted()
      state.drainWaits += 1
      releaseDrain = accepted
      req.once('drain', () => { if (releaseDrain === accepted) { releaseDrain = null; accepted() } })
    })

    const pump = async () => {
      await writeChunk(head)
      let offset = 0
      while (offset < o.totalBytes) {
        if (settled || state.requestError) return
        const size = Math.min(chunkBytes, o.totalBytes - offset)
        const chunk = o.nextChunk(size)
        fileHash.update(chunk)
        state.generatedBytes += chunk.length
        await writeChunk(chunk)
        offset += size
      }
      state.clientSha256 = fileHash.digest('hex')
      if (settled || state.requestError) return
      await writeChunk(tail)
      if (settled) return
      state.endedRequest = true
      req.end()
    }

    pump().catch((e) => {
      state.requestError = state.requestError || (e && (e.code || e.message)) || 'pump-failed'
      settle({ length: 0, text: null })
    })
  })
}
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
    // A transport error has no body at all; recording it is what makes a failed
    // login say ECONNRESET instead of 'login failed: 0 null'.
    try { data = JSON.parse(res.text) } catch (e) { data = null }
    return { status: res.status, data, headers: res.headers, error: res.error == null ? null : String(res.error) }
  }

  /** Log in, walking the seed account's mandatory first-login password reset. */
  async login(username, seedPassword, resetPassword) {
    let used = resetPassword
    let res = await this.json('/api/login', { method: 'POST', body: { username, password: resetPassword } })
    if (res.status !== 200) {
      used = seedPassword
      res = await this.json('/api/login', { method: 'POST', body: { username, password: seedPassword } })
    }
    if (res.status !== 200) throw new Error('login failed: status=' + res.status + ' error=' + res.error + ' body=' + redactPreview(JSON.stringify(res.data), 200))
    this.csrf = res.data.csrfToken
    if (res.data.user && res.data.user.mustResetPassword) {
      const reset = await this.json('/api/password/reset', {
        method: 'POST', body: { currentPassword: used, newPassword: resetPassword },
      })
      if (reset.status !== 200) throw new Error('force-reset failed: status=' + reset.status + ' error=' + reset.error + ' body=' + redactPreview(JSON.stringify(reset.data), 200))
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
  const artifact = { token: null, privateToken: null, sha256: null, size: null, shareId: null, fileId: null }

  /**
   * A subtest that consumes the artifact must not masquerade as an independent
   * finding when PS6-INT-4 never provisioned one.
   *
   * ⚠️ Stage B attempt #2 reported NINE failures. Eight of them were one
   *    failure: PS6-INT-4 never minted a token, a share id or a file id, so
   *    every dependent subtest asked the gateway for `/s/undefined` and
   *    asserted on the 404 it correctly returned. Seven confirmed defects were
   *    reported that did not exist.
   *
   * Returning a string here makes node:test SKIP the subtest and print the
   * reason, so the run says "blocked" where it used to say "failed". The value
   * is computed when the subtest is declared — i.e. after PS6-INT-4 has already
   * run — so a successful PS6-INT-4 leaves every dependent subtest executing
   * exactly as before. The acceptance meaning is unchanged.
   */
  const blockedByInt4 = (...required) => {
    const missing = required.filter((key) => artifact[key] === null || artifact[key] === undefined)
    return missing.length === 0
      ? false
      : `BLOCKED_BY_PS6_INT_4 — PS6-INT-4 did not provision ${missing.join(', ')}, ` +
        'so this subtest would assert against a non-existent artifact. It is blocked, not failed: ' +
        'nothing here is evidence of a product defect.'
  }

  /**
   * A token for the routing, default-deny and B5 probes, which are about the
   * gateway's map rather than about the artifact and must keep running when the
   * artifact is missing. It is deliberately obvious in any log or assertion
   * message that no real token was involved.
   */
  const UNPROVISIONED_TOKEN = 'ps6-unprovisioned-token'
  const routingToken = () => artifact.token ?? UNPROVISIONED_TOKEN

  // ── PS6-only failure evidence, captured BEFORE teardown ────────────────────
  //
  // ⚠️ Everything below is scoped to THIS project's containers, and each one is
  //    checked against its own `com.docker.compose.project` label before it is
  //    inspected or read. No production container is inspected, and no
  //    production log is ever read or printed.
  //
  // ⚠️ Every string that leaves this block passes through `redact()` first, so
  //    the four throwaway PS6 credentials, the link password and the reset
  //    password cannot reach the runner's output even if a log line carried one.

  const REDACTIONS = [
    env.PS6_SUPER_PASSWORD, env.PS6_DRIVE_DB_PASSWORD, env.PS6_SESSION_SECRET, env.PS6_SUPER_USER,
    LINK_PASSWORD, RESET_PASSWORD, SEED_PASSWORD,
  ].filter((value) => typeof value === 'string' && value.length >= 4)

  const redact = (value) => {
    let text = String(value ?? '')
    for (const secret of REDACTIONS) text = text.split(secret).join('«redacted»')
    return text
  }
  const bounded = (value, max) => {
    const text = redact(value)
    return text.length <= max ? text : `${text.slice(0, max)}\n      … ${text.length - max} more characters not shown`
  }

  /** Refuse to touch any container that is not labelled with THIS project. */
  const ownedByThisProject = async (id) => {
    if (!id) return false
    try {
      const { stdout } = await docker(['inspect', id, '--format', '{{index .Config.Labels "com.docker.compose.project"}}'])
      return stdout.trim() === PROJECT
    } catch {
      return false
    }
  }

  /**
   * Enough PS6-only evidence to tell a connection reset from a process exit,
   * a health failure, a rejected body, a storage failure or an OOM kill —
   * captured while the stack is still up, because the cleanup trap is about to
   * remove it. Never throws: a diagnostic that fails must not replace the
   * failure it was called to explain.
   */
  const ps6FailureEvidence = async (reason) => {
    const lines = [
      '',
      `  ── PS6-only failure evidence — ${reason} ──`,
      `  project ${PROJECT}; no production container is inspected, read or logged`,
    ]
    const named = [['drive', driveId], ['public-share-gateway', gatewayId], ['postgres', postgresId], ['recipient', recipientId]]

    lines.push('  container state  service | status | running | exitCode | oomKilled | restarts | health')
    for (const [service, id] of named) {
      if (!(await ownedByThisProject(id))) {
        lines.push(`    ${service}: not labelled ${PROJECT} — refusing to inspect it`)
        continue
      }
      try {
        const { stdout } = await docker(['inspect', id, '--format',
          '{{.State.Status}}|{{.State.Running}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.RestartCount}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'])
        lines.push(`    ${service}: ${stdout.trim()}`)
      } catch (e) {
        lines.push(`    ${service}: inspect failed — ${bounded(e.message, 200)}`)
      }
    }

    if (await ownedByThisProject(driveId)) {
      try {
        const { stdout } = await docker(['inspect', driveId, '--format',
          '{{if .State.Health}}{{range .State.Health.Log}}{{.ExitCode}} {{.Output}}{{end}}{{else}}no healthcheck{{end}}'])
        lines.push(`  drive health log (bounded, redacted):\n      ${bounded(stdout.trim(), 800)}`)
      } catch (e) {
        lines.push(`  drive health log: unavailable — ${bounded(e.message, 200)}`)
      }

      // The decisive artefact: why the Drive process stopped answering. Bounded
      // and redacted; this is the harness's own throwaway Drive, never Production's.
      try {
        const { stdout, stderr } = await docker(['logs', '--tail', '160', driveId], { maxBuffer: 8 * 1024 * 1024 })
        lines.push(`  drive logs, last 160 lines (bounded, redacted):\n      ${bounded(`${stdout}${stderr}`, 6000)}`)
      } catch (e) {
        lines.push(`  drive logs: unavailable — ${bounded(e.message, 200)}`)
      }
    }

    try {
      const { stdout } = await compose(['ps', '--format', 'json'])
      const rows = stdout.trim().split('\n').filter(Boolean).map((line) => {
        try {
          const p = JSON.parse(line)
          return `${p.Service}=${p.State}/${p.Health || 'none'} exit=${p.ExitCode ?? 'n/a'}`
        } catch { return 'unparseable row' }
      })
      lines.push(`  compose ps: ${bounded(rows.join('  '), 1000)}`)
    } catch (e) {
      lines.push(`  compose ps: unavailable — ${bounded(e.message, 200)}`)
    }

    lines.push('  ── end PS6-only failure evidence ──')
    return lines.join('\n')
  }

  /**
   * Turn an in-container `ps6Failure` record into a message that says what
   * actually happened, and attach the PS6-only evidence captured before teardown.
   */
  const explainFailure = async (label, failure) => {
    const f = failure ?? {}
    const headline = f.reason === 'transport'
      ? `${label} transport failure: status=${f.status ?? 0} error=${f.error ?? 'unknown'}`
      : `${label} ${f.stage ?? 'request'} failure (${f.reason ?? 'unknown'}): ` +
        `status=${f.status ?? 'n/a'} expected=${f.expectedStatus ?? 'n/a'} error=${f.error ?? 'none'}`
    const detail = [
      `    response length: ${f.length ?? 'n/a'} bytes; body present: ${f.hasText === undefined ? 'n/a' : f.hasText};` +
      ` body bytes captured: ${f.bodyBytes ?? 'n/a'}; content-type: ${f.contentType ?? 'none'}`,
    ]
    if (f.upload) {
      const u = f.upload
      // ⚠️ The client-side write counters. They are what separates "the harness
      //    never produced the bytes" from "the socket stopped accepting them"
      //    from "the server answered while we were still writing".
      detail.push(
        `    upload client: contentLength=${u.contentLength} chunkBytes=${u.chunkBytes}` +
        ` generated=${u.generatedBytes} written=${u.writtenBytes} drainWaits=${u.drainWaits}` +
        ` endedRequest=${u.endedRequest}`,
        `    upload outcome: responseStarted=${u.responseStarted} responseStatus=${u.responseStatus}` +
        ` requestError=${u.requestError ?? 'none'} responseError=${u.responseError ?? 'none'}`,
      )
    }
    if (f.parseError) detail.push(`    parse error: ${redact(f.parseError)}`)
    if (f.preview) detail.push(`    body excerpt (bounded, redacted): ${bounded(f.preview, 300)}`)
    if (f.keys) detail.push(`    response shape: keys=${redact(JSON.stringify(f.keys))}`)
    if (f.stack) detail.push(`    in-container stack (redacted): ${bounded(f.stack, 1200)}`)
    return `${headline}\n${detail.join('\n')}\n${await ps6FailureEvidence(headline)}`
  }

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
  REDACT.push(s.cookie, s.csrf, ${JSON.stringify(LINK_PASSWORD)}, ${JSON.stringify(RESET_PASSWORD)}, ${JSON.stringify(SEED_PASSWORD)})
  const body = Buffer.alloc(1024, 0x61)
  const boundary = '----ps6probe' + Date.now()
  const parts = Buffer.concat([
    Buffer.from('--' + boundary + '\\r\\nContent-Disposition: form-data; name="file"; filename="ps6-probe.bin"\\r\\nContent-Type: application/octet-stream\\r\\n\\r\\n'),
    body, Buffer.from('\\r\\n--' + boundary + '--\\r\\n'),
  ])
  const up = await send({ ...DRIVE, path: '/api/files/upload', method: 'POST', captureBytes: 65536,
    headers: { Host: 'localhost', cookie: s.cookie, 'X-CSRF-Token': s.csrf,
      'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': parts.length }, body: parts })
  const parsed = parseJsonBody('PS6-INT-3 probe upload', up, 201)
  if (!parsed.ok) { out({ ps6Failure: { stage: 'probe-upload', ...parsed.diagnostic } }); return }
  const uploaded = parsed.value
  if (!uploaded || !uploaded.file || uploaded.file.id === undefined) {
    out({ ps6Failure: { stage: 'probe-upload', reason: 'unexpected-shape', status: up.status, length: up.length, hasText: true, keys: Object.keys(uploaded || {}) } })
    return
  }
  const share = await s.json('/api/shares', { method: 'POST', body: {
    fileId: uploaded.file.id, expiry: '1h', authType: 'password', scope: 'public', password: ${JSON.stringify(LINK_PASSWORD)},
  } })
  out({ uploadStatus: up.status, fileId: uploaded.file.id, shareStatus: share.status, shareBody: share.data })
})().catch((e) => { out({ ps6Failure: { stage: 'probe-program', reason: 'exception', stack: redactPreview(String((e && e.stack) || e), 1200) } }) })
`
    let pre
    try {
      pre = await runNode(driveId, provision, { timeoutMs: 180_000 })
    } catch (cause) {
      assert.fail(`PS6-INT-3 the probe program did not complete inside the Drive container: ` +
        `${bounded(cause && cause.message, 2000)}\n${await ps6FailureEvidence('PS6-INT-3 probe program did not complete')}`)
    }
    if (pre.ps6Failure) assert.fail(await explainFailure('PS6-INT-3', pre.ps6Failure))
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
    const provision = `${PRELUDE}${UPLOAD_CLIENT}${PRIVATE_SESSION}
const FILE_BYTES = ${FILE_BYTES}
const CHUNK_BYTES = ${UPLOAD_CHUNK_BYTES}
;(async () => {
  const s = new Session('localhost')
  await s.login(${JSON.stringify(SEED_USER)}, ${JSON.stringify(SEED_PASSWORD)}, ${JSON.stringify(RESET_PASSWORD)})
  REDACT.push(s.cookie, s.csrf, ${JSON.stringify(LINK_PASSWORD)}, ${JSON.stringify(RESET_PASSWORD)}, ${JSON.stringify(SEED_PASSWORD)})

  // Deterministic, incompressible-enough content derived from a fixed seed, so
  // the expected digest is a property of the test rather than of a lucky run.
  // Generated one bounded chunk at a time and handed straight to the socket:
  // byte-for-byte the same payload as the one-shot version, a flat memory
  // profile instead of ~190 MiB, and a write model that honours backpressure.
  const source = deterministicSource('ps6-payload')
  const boundary = '----ps6payload' + Date.now()
  const up = await uploadMultipart({
    ...DRIVE, path: '/api/files/upload', captureBytes: 65536,
    headers: { Host: 'localhost', cookie: s.cookie, 'X-CSRF-Token': s.csrf },
    boundary, fieldName: 'file', filename: 'ps6-payload.bin',
    totalBytes: FILE_BYTES, chunkBytes: CHUNK_BYTES, nextChunk: source,
  })
  const expected = up.clientSha256

  // Client-side write counters. A failure now says whether the bytes were even
  // generated, how far the socket accepted them, how often it pushed back, and
  // whether the server had already begun answering. None of this is a secret.
  const counters = {
    contentLength: up.contentLength, chunkBytes: up.chunkBytes,
    generatedBytes: up.generatedBytes, writtenBytes: up.writtenBytes,
    drainWaits: up.drainWaits, endedRequest: up.endedRequest,
    responseStarted: up.responseStarted, responseStatus: up.status,
    requestError: up.requestError, responseError: up.responseError,
  }

  // The upload is the step Stage B attempts #2 and #3 died on. Classify it here,
  // where
  // the response object still exists, and hand the classification back as data.
  // JSON.parse is reached only when a body is known to be present.
  const parsed = parseJsonBody('PS6-INT-4 64 MiB private upload', up, 201)
  if (!parsed.ok) { out({ ps6Failure: { stage: 'upload', ...parsed.diagnostic, upload: counters } }); return }
  const uploaded = parsed.value
  if (!uploaded || !uploaded.file || uploaded.file.id === undefined || uploaded.file.sha256 === undefined) {
    out({ ps6Failure: { stage: 'upload', reason: 'unexpected-shape', status: up.status, length: up.length, hasText: true,
      keys: Object.keys(uploaded || {}), fileKeys: Object.keys((uploaded && uploaded.file) || {}), upload: counters } })
    return
  }

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
    expectedSha256: expected, fileId: uploaded.file.id, upload: counters,
    shareStatus: share.status, publicUrl: share.data && share.data.publicUrl,
    path: share.data && share.data.path, shareId: share.data && share.data.share && share.data.share.id,
    scope: share.data && share.data.share && share.data.share.scope,
    privateStatus: priv.status, privatePath: priv.data && priv.data.path,
    privatePublicUrl: priv.data ? (priv.data.publicUrl ?? null) : null,
  })
})().catch((e) => { out({ ps6Failure: { stage: 'provisioning-program', reason: 'exception', stack: redactPreview(String((e && e.stack) || e), 1200) } }) })
`
    // ⚠️ The program can also fail to RUN — an OOM kill inside the container, a
    //    daemon error, a timeout — in which case `docker exec` itself is
    //    non-zero. Both paths capture PS6-only evidence before the cleanup trap
    //    removes the stack, because after teardown there is nothing left to ask.
    let r
    try {
      r = await runNode(driveId, provision, { timeoutMs: 900_000 })
    } catch (cause) {
      assert.fail(`PS6-INT-4 the provisioning program did not complete inside the Drive container: ` +
        `${bounded(cause && cause.message, 2000)}\n${await ps6FailureEvidence('PS6-INT-4 provisioning program did not complete')}`)
    }
    if (r.ps6Failure) assert.fail(await explainFailure('PS6-INT-4 upload', r.ps6Failure))

    if (r.upload) {
      const u = r.upload
      console.log(`[ps6] PS6-INT-4 upload client: contentLength=${u.contentLength} chunkBytes=${u.chunkBytes} ` +
        `generated=${u.generatedBytes} written=${u.writtenBytes} drainWaits=${u.drainWaits} ` +
        `endedRequest=${u.endedRequest} responseStatus=${u.responseStatus}`)
      assert.equal(u.generatedBytes, FILE_BYTES, 'the client must have generated exactly the acceptance size')
      assert.equal(u.writtenBytes, u.contentLength, 'every byte of the request must have been handed to the socket')
      assert.equal(u.endedRequest, true, 'the request must only be ended after every chunk was accepted')
    }
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
  await t.test('PS6-INT-5 normal redemption end to end through the real gateway',
    { skip: blockedByInt4('token', 'shareId', 'sha256') }, async () => {
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
  await t.test('PS6-INT-6 a slow client with a 75s stall completes intact',
    { skip: blockedByInt4('token', 'sha256') }, async () => {
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
  await t.test('PS6-INT-7 an interrupted transfer harms neither the gateway nor Drive',
    { skip: blockedByInt4('token', 'shareId', 'sha256') }, async () => {
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
  await t.test('PS6-INT-8 concurrent downloads all complete intact',
    { skip: blockedByInt4('token', 'shareId', 'sha256') }, async () => {
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
  // ⚠️ PS6-INT-9, -11 and -13 measure the gateway's ROUTE MAP, its default-deny
  //    and B5 — none of which is a property of the artifact — so they keep
  //    running when PS6-INT-4 provisioned nothing. They then use an obviously
  //    synthetic token, and each says so, so a reader never mistakes a routing
  //    result for an artifact result.
  await t.test('PS6-INT-9 no AEGIS surface but /s/:token is reachable through the gateway', async (sub) => {
    if (!artifact.token) sub.diagnostic(`route-map probes use the synthetic token ${UNPROVISIONED_TOKEN} — BLOCKED_BY_PS6_INT_4 for anything artifact-shaped`)
    const auditBefore = Number(await psql('SELECT count(*) FROM audit_log'))

    const forbidden = [
      '/', '/healthz', '/drive/', '/drive/index.html', '/monitor/',
      '/api', '/api/me', '/api/shares', '/api/files', '/api/audit',
      // Traversal: normalises to /api/me, but the RAW target is what the map checks.
      `/s/${routingToken()}/../api/me`,
      `/s/${routingToken()}/../../api/me`,
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
    const put = await recipientRequest({ path: `/s/${routingToken()}`, method: 'PUT', headers: { Host: HOST }, captureBytes: 4096 })
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
    const upper = await recipientRequest({ path: `/S/${routingToken()}`, headers: { Host: HOST }, captureBytes: 4096 })
    assert.notEqual(upper.length, FILE_BYTES,
      'no spelling of the share route may deliver the file without the link password')
    assert.doesNotMatch(String(upper.text ?? ''), /csrfToken|DataLake/i,
      'no spelling of the share route may expose an application surface')
  })

  // ── PS6-INT-10 ─────────────────────────────────────────────────────────────
  await t.test('PS6-INT-10 forged forwarding headers cannot move the attributed source',
    { skip: blockedByInt4('token') }, async () => {
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
  await t.test('PS6-INT-11 an unknown Host terminates at the gateway', async (sub) => {
    if (!artifact.token) sub.diagnostic(`Host probes use the synthetic token ${UNPROVISIONED_TOKEN}; the Host contract does not depend on the artifact`)
    const auditBefore = Number(await psql('SELECT count(*) FROM audit_log'))
    for (const host of ['evil.attacker.invalid', '172.31.250.2', 'localhost', `${HOST}.attacker.invalid`]) {
      const res = await recipientRequest({ path: `/s/${routingToken()}`, headers: { Host: host }, captureBytes: 4096 })
      assert.equal(res.status, 404, `Host ${host} must fall to the default server, got ${res.status}`)
    }
    assert.equal(Number(await psql('SELECT count(*) FROM audit_log')), auditBefore,
      'a poisoned Host must not reach the application at all')
  })

  // ── PS6-INT-12 ─────────────────────────────────────────────────────────────
  await t.test('PS6-INT-12 the ingress split holds in both directions',
    { skip: blockedByInt4('privateToken', 'sha256') }, async () => {
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
  await t.test('PS6-INT-13 B5 holds: the gateway reaches its upstream and nothing else', async (sub) => {
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
    // Asserting `!logs.includes(undefined)` would be a check on the string
    // "undefined", which proves nothing. Say so instead of scoring a free pass.
    if (artifact.token) {
      assert.ok(!logs.includes(artifact.token), 'the raw share token must never reach the gateway log')
    } else {
      sub.diagnostic('BLOCKED_BY_PS6_INT_4 — the raw-token log assertion was NOT evaluated: no token was ever minted')
    }
    assert.ok(!logs.includes(LINK_PASSWORD), 'the link password must never reach the gateway log')
    assert.ok(!logs.includes(RECIPIENT_IP), 'the recipient address must not be persisted in the gateway log')
  })

  // ── PS6-INT-14 ─────────────────────────────────────────────────────────────
  await t.test('PS6-INT-14 revocation propagates through the gateway immediately',
    { skip: blockedByInt4('token', 'shareId') }, async () => {
    const program = `${PRELUDE}${PRIVATE_SESSION}
;(async () => {
  const s = new Session('localhost')
  await s.login(${JSON.stringify(SEED_USER)}, ${JSON.stringify(SEED_PASSWORD)}, ${JSON.stringify(RESET_PASSWORD)})
  const res = await s.json('/api/shares/' + ${JSON.stringify(String(artifact.shareId))}, { method: 'DELETE' })
  out({ status: res.status, error: res.error })
})().catch((e) => { out({ ps6Failure: { stage: 'revocation-program', reason: 'exception', stack: redactPreview(String((e && e.stack) || e), 1200) } }) })
`
    let revoked
    try {
      revoked = await runNode(driveId, program, { timeoutMs: 120_000 })
    } catch (cause) {
      assert.fail(`PS6-INT-14 the revocation program did not complete inside the Drive container: ` +
        `${bounded(cause && cause.message, 2000)}\n${await ps6FailureEvidence('PS6-INT-14 revocation program did not complete')}`)
    }
    if (revoked.ps6Failure) assert.fail(await explainFailure('PS6-INT-14 revocation', revoked.ps6Failure))
    assert.equal(revoked.status, 200, `the owner must be able to revoke (transport error: ${revoked.error ?? 'none'})`)

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
