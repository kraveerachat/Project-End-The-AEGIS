// HUB-AEGIS_Entry/tests/driveCspParity.test.mjs — the Content-Security-Policy a
// browser actually receives on /drive/*, and whether it still agrees with the
// policy the Drive application declares for itself.
//
// Why this suite exists, precisely:
//
// PR #41 fixed the Drive application's own CSP (`img-src` gained `blob:`,
// `media-src 'self' blob:` was declared) so the Private Vault preview could show
// the images and videos it decrypts in the tab. The Drive image was rebuilt, the
// container was recreated, health passed — and the live browser-facing header on
// https://aegis.internal/drive/healthz still read:
//
//   img-src 'self' data:        ← no blob:, and no media-src at all
//
// Because `location /drive/` in this file does two things on purpose:
//
//   proxy_hide_header Content-Security-Policy;   ← Express's CSP is discarded
//   add_header Content-Security-Policy "…"       ← nginx publishes its own
//
// The edge is therefore the single owner of the browser-visible policy for
// /drive/*, and that ownership is deliberate — it is what stops two policies
// from being intersected into an unpredictable third one. The cost of owning it
// is that the edge policy has to be kept in step with the application policy by
// hand, and nothing was enforcing that. Fixing `securityHeaders.js` alone could
// not have worked, and no IDEA1 test could have caught it: IDEA1 asserts the
// header Express emits, which is exactly the header this file throws away.
//
// So this suite reads both sides and compares them semantically — directives and
// source tokens, not formatting. It fails when they drift in either direction,
// which is the exact drift that shipped the production defect.
//
// It also pins the security contract that makes the grant acceptable: blob: is a
// same-tab data source, never an execution sink. It may appear in img-src and
// media-src on /drive only, and nowhere else in this file.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseNginx } from './helpers/nginxConfig.mjs'

const HUB_CONF_URL = new URL('../nginx.conf', import.meta.url)
const DRIVE_MIDDLEWARE_URL = new URL(
  '../../IDEA1-AEGIS_Drive_LC/server/middleware/securityHeaders.js',
  import.meta.url,
)

const hubConf = parseNginx(readFileSync(HUB_CONF_URL, 'utf8'))

/** The TLS server block — the only one that serves anything to a browser. */
function tlsServer() {
  const servers = hubConf.blocks.filter((block) => block.header === 'server')
  const tls = servers.filter((block) => block.directives.some((d) => /^listen 443 ssl\b/.test(d)))
  assert.equal(tls.length, 1, 'exactly one server block listens on 443 ssl')
  return tls[0]
}

function locationBlock(header) {
  const matches = tlsServer().blocks.filter((block) => block.header === header)
  assert.equal(matches.length, 1, `exactly one "${header}" block exists`)
  return matches[0]
}

/** Every `add_header <name> "<value>"` declared directly in a block. */
function addedHeaders(block) {
  const headers = new Map()
  for (const directive of block.directives) {
    const match = directive.match(/^add_header\s+(\S+)\s+(.*?)(\s+always)?$/is)
    if (!match) continue
    const name = match[1].toLowerCase()
    const raw = match[2].trim()
    const value = /^(["']).*\1$/s.test(raw) ? raw.slice(1, -1) : raw
    assert.equal(headers.has(name), false, `add_header ${name} is declared twice in "${block.header}"`)
    headers.set(name, value)
  }
  return headers
}

function cspOf(block) {
  const policy = addedHeaders(block).get('content-security-policy')
  assert.equal(typeof policy, 'string', `"${block.header}" declares a Content-Security-Policy`)
  return policy
}

/* ── reading a policy the way a user agent reads it ─────────────────── */

/**
 * Directives split on ';', sources split on ASCII whitespace, directive names
 * case-insensitive. Keyword sources keep their quotes: `self` and `'self'` are
 * different tokens to a browser.
 */
function parsePolicy(policy, label) {
  const directives = new Map()
  for (const chunk of policy.split(';')) {
    const parts = chunk.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) continue
    const name = parts[0].toLowerCase()
    // A browser honours the FIRST occurrence and ignores repeats, so a duplicate
    // must never be able to look like a widening — or a narrowing.
    assert.equal(directives.has(name), false, `${label}: directive ${name} is declared twice`)
    directives.set(name, parts.slice(1))
  }
  return directives
}

/** Sources for one directive, following the fallback a browser applies. */
function effectiveSources(directives, name, fallback = 'default-src') {
  if (directives.has(name)) return directives.get(name)
  return directives.get(fallback) ?? null
}

/* ── the two policies under comparison ──────────────────────────────── */

const driveLocation = locationBlock('location /drive/')
const monitorLocation = locationBlock('location /monitor/')

/** The browser-visible policy for /drive/* — the one nginx publishes. */
function edgeDrivePolicy() {
  return cspOf(driveLocation)
}

/** The HUB landing page policy, inherited by every location without its own. */
function globalHubPolicy() {
  return cspOf(tlsServer())
}

/**
 * The Drive application's policy, generated by running the real IDEA1
 * middleware rather than grepping its source. The module has no imports of its
 * own, so it loads without IDEA1's dependency tree.
 */
async function driveApplicationPolicy() {
  const { securityHeaders } = await import(DRIVE_MIDDLEWARE_URL)
  const headers = new Map()
  const res = { setHeader: (name, value) => headers.set(String(name).toLowerCase(), value) }
  let nextCalls = 0
  securityHeaders({}, res, () => { nextCalls += 1 })
  assert.equal(nextCalls, 1, 'the Drive middleware hands the request on exactly once')
  const policy = headers.get('content-security-policy')
  assert.equal(typeof policy, 'string', 'the Drive middleware sets a Content-Security-Policy')
  return policy
}

/* ── the parity contract this suite exists to enforce ───────────────── */

// Every directive whose drift between the two policies is user-visible or
// security-relevant. If IDEA1 declares one of these and the edge does not, the
// edge is silently stricter and a feature breaks in the browser with no test
// failing — which is exactly what happened.
const PARITY_DIRECTIVES = [
  'default-src',
  'script-src',
  'style-src',
  'img-src',
  'media-src',
  'font-src',
  'connect-src',
  'frame-ancestors',
  'base-uri',
  'form-action',
  'object-src',
]

const sorted = (sources) => [...sources].sort()

test('the browser-visible /drive policy is semantically equal to the Drive application policy', async () => {
  const edge = parsePolicy(edgeDrivePolicy(), 'HUB /drive')
  const app = parsePolicy(await driveApplicationPolicy(), 'IDEA1 securityHeaders')

  for (const name of PARITY_DIRECTIVES) {
    const appSources = app.get(name)
    assert.ok(appSources, `the Drive application declares ${name} — update this list if it stops`)
    const edgeSources = edge.get(name)
    assert.ok(
      edgeSources,
      `HUB /drive must declare ${name} explicitly; the Drive application declares it as `
      + `"${appSources.join(' ')}", and an absent directive at the edge falls back to default-src, `
      + 'which is a silent narrowing',
    )
    assert.deepEqual(
      sorted(edgeSources),
      sorted(appSources),
      `${name} drifted: HUB /drive publishes "${edgeSources.join(' ')}" but the Drive application declares `
      + `"${appSources.join(' ')}". nginx hides the upstream CSP, so the edge value is the one a browser enforces.`,
    )
  }

  // Parity is compared by directive and source token, never by formatting — but
  // neither side may carry a directive the other has never heard of.
  assert.deepEqual(
    [...edge.keys()].sort(),
    [...app.keys()].sort(),
    'both policies declare the same set of directives',
  )
})

/* ── the production defect, asserted directly ───────────────────────── */

test('/drive img-src admits the object URLs the vault preview creates', () => {
  const img = parsePolicy(edgeDrivePolicy(), 'HUB /drive').get('img-src')
  assert.ok(img, 'img-src is declared explicitly at the edge')

  // The exact live failure: https://aegis.internal/drive/healthz published
  // "img-src 'self' data:" and the decrypted picture rendered as a broken image.
  assert.ok(img.includes('blob:'), `/drive img-src must allow blob: — got "${img.join(' ')}"`)
  assert.ok(img.includes("'self'"), 'same-origin images stay allowed')
  assert.ok(img.includes('data:'), 'bundler-inlined favicons and small assets stay allowed')
  assert.deepEqual(sorted(img), sorted(["'self'", 'data:', 'blob:']),
    'img-src gained blob: and nothing else — no wildcard, no remote host')
})

test('/drive media-src is declared and admits the vault video object URL', () => {
  const media = parsePolicy(edgeDrivePolicy(), 'HUB /drive').get('media-src')
  assert.ok(media, 'media-src is declared at the edge — an absent directive falls back to '
    + 'default-src, which is what blocked <video src="blob:…">')

  assert.ok(media.includes('blob:'), `/drive media-src must allow blob: — got "${media.join(' ')}"`)
  assert.ok(media.includes("'self'"), 'same-origin media stays allowed')
  assert.equal(media.includes('data:'), false,
    'decrypted video never arrives as a data: URL, so data: is not granted to media-src')
  assert.deepEqual(sorted(media), sorted(["'self'", 'blob:']), 'media-src is exactly self + blob:')
})

/* ── display, never execute: the half that makes the grant safe ─────── */

test('/drive script-src and default-src do not admit blob:', () => {
  const directives = parsePolicy(edgeDrivePolicy(), 'HUB /drive')

  const script = directives.get('script-src')
  assert.deepEqual(script, ["'self'", "'wasm-unsafe-eval'"],
    "script-src stays exactly 'self' 'wasm-unsafe-eval' — no blob:, no unsafe-inline, no bare unsafe-eval")
  assert.equal(script.includes('blob:'), false, 'a blob URL must never be executable')

  // default-src is the fallback for every directive not named — worker-src and
  // script-src-elem included. blob: there would grant it everywhere by the back
  // door, and new Worker(blobUrl) executes attacker bytes in the app origin.
  const fallback = directives.get('default-src')
  assert.deepEqual(fallback, ["'self'"], 'default-src stays exactly self')
  assert.equal(fallback.includes('blob:'), false, 'blob: must not leak in through the fallback')

  for (const name of ['style-src', 'font-src', 'connect-src', 'form-action', 'base-uri', 'object-src']) {
    assert.equal(effectiveSources(directives, name).includes('blob:'), false, `${name} must not admit blob:`)
  }
  for (const name of ['worker-src', 'child-src', 'script-src-elem', 'frame-src']) {
    assert.equal(effectiveSources(directives, name).includes('blob:'), false, `${name} resolves without blob:`)
  }
})

test('the rest of the /drive policy is untouched by this fix', () => {
  const policy = edgeDrivePolicy()
  const directives = parsePolicy(policy, 'HUB /drive')

  assert.deepEqual(directives.get('object-src'), ["'none'"],
    "object-src stays 'none' — decrypted content is never handed to <object>/<embed>")
  assert.deepEqual(directives.get('connect-src'), ["'self'"],
    'connect-src stays scoped to this origin — no exfiltration path was opened')
  assert.deepEqual(directives.get('frame-ancestors'), ["'none'"], 'clickjacking defence unchanged')
  assert.deepEqual(directives.get('style-src'), ["'self'"])
  assert.deepEqual(directives.get('font-src'), ["'self'"])
  assert.deepEqual(directives.get('base-uri'), ["'none'"])
  assert.deepEqual(directives.get('form-action'), ["'self'"])

  assert.doesNotMatch(policy, /'unsafe-inline'/, "no 'unsafe-inline' was introduced")
  assert.doesNotMatch(policy, /(^|[^-])'unsafe-eval'/, "no bare 'unsafe-eval' was introduced")

  for (const [name, sources] of directives) {
    for (const source of sources) {
      assert.notEqual(source, '*', `${name} must not use a wildcard`)
      assert.equal(/^https?:$/.test(source), false, `${name} must not open a whole scheme (${source})`)
      assert.equal(source.startsWith('*.'), false, `${name} must not use a host wildcard (${source})`)
      assert.equal(/^https?:\/\//.test(source), false, `${name} must not name a remote host (${source})`)
    }
  }
})

/* ── the edge keeps sole ownership of the browser-visible headers ───── */

test('/drive still hides the upstream CSP and every other duplicated header', () => {
  // Removing this would let Express's CSP through alongside nginx's, and a
  // browser enforces the intersection of both — an unpredictable third policy.
  // The fix is parity, not pass-through: this must survive it.
  const hidden = driveLocation.directives
    .filter((directive) => /^proxy_hide_header\s/i.test(directive))
    .map((directive) => directive.split(/\s+/)[1].toLowerCase())

  assert.ok(hidden.includes('content-security-policy'),
    'proxy_hide_header Content-Security-Policy must remain — nginx stays the single owner of the /drive policy')

  for (const name of [
    'x-frame-options',
    'x-content-type-options',
    'referrer-policy',
    'strict-transport-security',
    'permissions-policy',
  ]) {
    assert.ok(hidden.includes(name), `proxy_hide_header ${name} is unchanged`)
  }
})

test('/drive re-declares the non-CSP security headers it stops inheriting', () => {
  // nginx rule that bites: one add_header in a location suppresses inheritance
  // of every add_header from the server block. Publishing a /drive CSP therefore
  // obliges this location to republish the rest, and it still does.
  const headers = addedHeaders(driveLocation)
  assert.equal(headers.get('x-frame-options'), 'DENY')
  assert.equal(headers.get('x-content-type-options'), 'nosniff')
  assert.equal(headers.get('referrer-policy'), 'no-referrer')
  assert.equal(headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains')
  assert.equal(headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=(), payment=()')
})

/* ── nothing outside /drive was widened ─────────────────────────────── */

test('the global HUB landing-page policy gains neither blob: nor wasm-unsafe-eval', () => {
  const policy = globalHubPolicy()
  const directives = parsePolicy(policy, 'HUB global')

  // The landing page is static nginx output. It renders no Vault media and
  // compiles no WebAssembly, so it keeps the stricter policy.
  assert.equal(policy.includes('blob:'), false, 'the global HUB CSP must not gain blob:')
  assert.equal(policy.includes('wasm-unsafe-eval'), false, 'the global HUB CSP must not gain wasm-unsafe-eval')
  assert.equal(directives.has('media-src'), false, 'the landing page needs no media-src')

  assert.deepEqual(directives.get('script-src'), ["'self'"], 'global script-src stays exactly self')
  assert.deepEqual(directives.get('default-src'), ["'self'"])
  assert.deepEqual(directives.get('img-src'), ["'self'", 'data:'])
  assert.deepEqual(directives.get('object-src'), ["'none'"])
  assert.deepEqual(directives.get('frame-ancestors'), ["'none'"])
  assert.deepEqual(directives.get('connect-src'), ["'self'"])
})

test('/monitor is not widened and still inherits the strict server policy', () => {
  // IDEA2 asked for nothing here. A location that declares no add_header of its
  // own inherits the server block's, so /monitor is governed by the global HUB
  // policy asserted above — and this task must not change that.
  assert.equal(addedHeaders(monitorLocation).size, 0,
    '/monitor declares no add_header of its own; it inherits the stricter server policy')

  const raw = JSON.stringify(monitorLocation)
  assert.equal(raw.includes('blob:'), false, '/monitor must not gain blob:')
  assert.equal(raw.includes('wasm-unsafe-eval'), false, '/monitor must not gain wasm permissions')

  // And the guard in front of the service-to-service ingest surface is untouched.
  const guard = tlsServer().blocks.find((block) => block.header.startsWith('location ~*'))
  assert.ok(guard, 'the /monitor/internal guard block is still present')
  assert.ok(guard.directives.includes('return 404'), '/monitor/internal/* is still refused at the edge')
})

test('blob: appears nowhere in this config except the /drive img-src and media-src grants', () => {
  const conf = readFileSync(HUB_CONF_URL, 'utf8')
  const grants = conf
    .split(/\r?\n/)
    .filter((line) => line.includes('blob:') && !line.trimStart().startsWith('#'))

  assert.equal(grants.length, 1, `exactly one non-comment line grants blob: — found ${grants.length}`)
  assert.match(grants[0], /add_header Content-Security-Policy/,
    'the only blob: grant is a Content-Security-Policy declaration')
  assert.match(grants[0], /img-src 'self' data: blob:/)
  assert.match(grants[0], /media-src 'self' blob:/)
  assert.match(grants[0], /script-src 'self' 'wasm-unsafe-eval';/)
})
