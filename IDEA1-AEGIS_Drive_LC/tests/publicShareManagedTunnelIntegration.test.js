// tests/publicShareManagedTunnelIntegration.test.js — PUBLIC-SHARE-7 pre-exposure
//
// ── What this file is, and what it is NOT ─────────────────────────────────────
//
// PUBLIC-SHARE-3 shipped a gateway that assumes it is the IMMEDIATE
// recipient-facing HTTP peer. PUBLIC-SHARE-6 proved that gateway in front of the
// real Drive on real PostgreSQL — still as the immediate peer. Both were explicit
// that a G4 Option B managed tunnel inserts another hop, that `$remote_addr`
// would then be the tunnel connector rather than the recipient, and that the
// provider trust/attribution adapter had to be designed and reviewed BEFORE any
// deployment. This suite is that adapter's acceptance.
//
// ⚠️ NOTHING HERE IS EXTERNAL EVIDENCE. There is no Cloudflare account, no
//    cloudflared, no tunnel, no domain, no DNS record, no TLS certificate, no
//    public URL and no Internet path. `tunnel-connector` is a stock node
//    container that re-originates HTTP with `CF-Connecting-IP`, because that one
//    behaviour is the entire security question a managed hop raises. A PASS here
//    is PRE-EXPOSURE / LOCALLY VERIFIED. G5 and G6 stay OPEN and
//    `Public Internet Share = NOT IMPLEMENTED`.
//
// ⚠️ NO PRODUCTION CONTACT. The harness owns its project name, its four
//    networks, its containers and its anonymous volumes, generates its own
//    throwaway credentials, reads no .env, and is removed in `after`.
//
// The static PS7-STRUCT tests below always run and need no Docker. The
// PS7-PRE runtime matrix is opt-in with PUBLIC_SHARE_MANAGED_TUNNEL_RUNTIME=1,
// so the default IDEA1 suite never builds an image or mutates Docker implicitly.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const ENABLED = process.env.PUBLIC_SHARE_MANAGED_TUNNEL_RUNTIME === '1'

const GATEWAY_ROOT = new URL('../../gateway/public-share/', import.meta.url)
const readGateway = (name) => readFileSync(new URL(name, GATEWAY_ROOT), 'utf8')
const COMPOSE_FILE = fileURLToPath(new URL('managed-tunnel/docker-compose.yml', GATEWAY_ROOT))
const EDGE_VALIDATOR = fileURLToPath(new URL('validate-public-share-edge.sh', GATEWAY_ROOT))

const POSIX_SHELL = (() => {
  if (process.platform !== 'win32') return 'sh'
  const found = spawnSync('where.exe', ['sh'], { encoding: 'utf8' })
  if (found.status === 0) {
    const direct = found.stdout.split(/\r?\n/).find(Boolean)
    if (direct) return direct
  }
  for (const candidate of [
    'C:\\Program Files\\Git\\bin\\sh.exe',
    'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
    'C:\\Program Files (x86)\\Git\\bin\\sh.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\sh.exe',
  ]) {
    try {
      if (spawnSync(candidate, ['-c', 'exit 0']).status === 0) return candidate
    } catch {}
  }
  return 'sh'
})()

const posixShellAvailable = (() => {
  try {
    return spawnSync(POSIX_SHELL, ['-c', 'exit 0']).status === 0
  } catch {
    return false
  }
})()

const HOST = 'share.example.invalid'
const BASE_URL = `https://${HOST}`

/** The exact path the shipped entrypoint generates and the template includes. */
const EDGE_INCLUDE = '/tmp/aegis-edge/http.conf'

const EDGE_NETWORK = 'aegis_ps7_edge'
const UPSTREAM_NETWORK = 'aegis_ps7_upstream'
const DATA_NETWORK = 'aegis_ps7_data'
const NETWORKS = [EDGE_NETWORK, UPSTREAM_NETWORK, DATA_NETWORK]

const GATEWAY_EDGE_IP = '172.31.240.2'
const CONNECTOR_IP = '172.31.240.3'
const DIRECT_CALLER_IP = '172.31.240.4'
const GATEWAY_UPSTREAM_IP = '172.31.241.2'
const DRIVE_UPSTREAM_IP = '172.31.241.3'
const POSTGRES_IP = '172.31.242.2'
const PRIVATE_SURFACE_IP = '172.31.242.4'

/**
 * Two simulated external recipients, and one simulated IPv6 recipient.
 *
 * They are HEADER VALUES the connector asserts, exactly as a managed provider
 * edge would. No container in this harness holds any of them, which is the
 * point: attribution has to survive a hop where the recipient is not the peer.
 * All three are documentation ranges (RFC 5737 / RFC 3849), so none of them can
 * collide with a real address if one ever leaked into a log.
 */
const RECIPIENT_A = '203.0.113.10'
const RECIPIENT_B = '198.51.100.20'
const RECIPIENT_V6 = '2001:db8::1234'
/** Addresses a caller forges. Attribution must never land on any of them. */
const FORGED_IP = '192.0.2.66'

const SEED_USER = 'user'
const SEED_PASSWORD = 'aegis-drive-user'
/** Passes the reset policy: >= 12 chars, not the old one, not the username. */
const RESET_PASSWORD = 'aegis-ps7-user-6d21ba53'
const LINK_PASSWORD = 'ps7-link-7c5e14bd'

/** Small on purpose: PS7 measures trust and attribution, not transfer size. */
const FILE_BYTES = Number(process.env.PS7_FILE_BYTES ?? 128 * 1024)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ═══ Static shape — always runs, no Docker ═══════════════════════════════════

/**
 * Parse the nginx subset used here. Quoted strings, comments, semicolons and
 * nested blocks are understood; malformed braces/strings fail closed.
 *
 * Deliberately the same parser shape as publicShareGatewayStructure.test.js:
 * these suites must agree about what the config says.
 */
function parseNginx(source) {
  let index = 0

  function parseBlock(nested) {
    const node = { directives: [], blocks: [] }
    let token = ''

    while (index < source.length) {
      const char = source[index]
      if (char === '"' || char === "'") {
        let end = index + 1
        while (end < source.length && source[end] !== char) {
          if (source[end] === '\\') end += 1
          end += 1
        }
        assert.ok(end < source.length, `unterminated ${char} string near offset ${index}`)
        token += source.slice(index, end + 1)
        index = end + 1
        continue
      }
      if (char === '#') {
        while (index < source.length && source[index] !== '\n') index += 1
        continue
      }
      if (char === ';') {
        const directive = token.trim().replace(/\s+/g, ' ')
        if (directive) node.directives.push(directive)
        token = ''
        index += 1
        continue
      }
      if (char === '{') {
        index += 1
        const child = parseBlock(true)
        node.blocks.push({ header: token.trim().replace(/\s+/g, ' '), ...child })
        token = ''
        continue
      }
      if (char === '}') {
        index += 1
        assert.ok(nested, 'unbalanced closing brace in nginx config')
        return node
      }
      token += char
      index += 1
    }

    assert.equal(nested, false, 'unbalanced opening brace in nginx config')
    return node
  }

  return parseBlock(false)
}

function directiveValues(block, name) {
  const prefix = `${name} `
  return block.directives
    .filter((value) => value === name || value.startsWith(prefix))
    .map((value) => value.slice(name.length).trim())
}

function oneDirective(block, name) {
  const values = directiveValues(block, name)
  assert.equal(values.length, 1, `expected exactly one ${name}, found ${values.length}`)
  return values[0]
}

function shareLocation() {
  const config = parseNginx(readGateway('nginx.conf.template'))
  const http = config.blocks.find((block) => block.header === 'http')
  assert.ok(http, 'the template must have an http block')
  const publicServer = http.blocks.find(
    (block) => directiveValues(block, 'server_name').includes('$PUBLIC_SHARE_HOST'),
  )
  assert.ok(publicServer, 'the configured-host listener must exist')
  const share = publicServer.blocks.find(
    (block) => block.header === 'location ~* ^/s/[A-Za-z0-9_-]+/?$',
  )
  assert.ok(share, 'the single share location must exist')
  return { http, publicServer, share }
}

test('PS7-STRUCT-1 the edge trust model is an included file, generated before nginx starts', () => {
  const { http } = shareLocation()

  // An EXACT path, not a wildcard. A wildcard that matches nothing is silently
  // fine to nginx, which would let a gateway start with no trust model at all
  // while the template still referenced $aegis_edge_deny.
  const includes = directiveValues(http, 'include')
  assert.ok(includes.includes(EDGE_INCLUDE), `http must include ${EDGE_INCLUDE}`)
  assert.equal(includes.some((value) => value.includes('*')), false, 'no wildcard include may exist')

  const entrypoint = readGateway('entrypoint.sh')
  const hostAt = entrypoint.indexOf('/usr/local/bin/aegis-validate-public-share-host.sh')
  const edgeAt = entrypoint.indexOf('/usr/local/bin/aegis-validate-public-share-edge.sh')
  const handoverAt = entrypoint.indexOf('exec /docker-entrypoint.sh')
  assert.ok(hostAt > -1 && edgeAt > -1 && handoverAt > -1, 'both validators must run from the entrypoint')
  assert.ok(edgeAt < handoverAt, 'the edge trust file must be generated before nginx renders and starts')
  assert.match(entrypoint, /^set -eu$/m, 'either refusal must abort the entrypoint')
  // The include path is fixed in the entrypoint, so no environment value can
  // choose which trust file nginx loads.
  assert.match(
    entrypoint,
    /aegis-validate-public-share-edge\.sh \/tmp\/aegis-edge$/m,
    'the generated trust directory must be a literal, never an environment value',
  )

  const dockerfile = readGateway('Dockerfile')
  assert.match(dockerfile, /^COPY .*validate-public-share-edge\.sh \/usr\/local\/bin\/aegis-validate-public-share-edge\.sh$/m)
  assert.match(dockerfile, /chmod 0555 \/usr\/local\/bin\/aegis-validate-public-share-edge\.sh/)
  assert.match(readGateway('.dockerignore'), /^!validate-public-share-edge\.sh$/m)

  // The PUBLIC-SHARE-3 envsubst hardening is UNCHANGED: the managed-proxy
  // values reach nginx through a generated file, never through substitution.
  assert.match(dockerfile, /^ENV NGINX_ENVSUBST_FILTER=\^PUBLIC_SHARE_HOST\$$/m)
})

test('PS7-STRUCT-2 the managed-proxy gate fails closed before limiting or proxying', () => {
  const { share } = shareLocation()

  const gate = share.blocks.find((block) => block.header === 'if ($aegis_edge_deny)')
  assert.ok(gate, 'the share location must carry the managed-proxy gate')
  assert.deepEqual(gate.directives, ['return 403'], 'the gate may only refuse; it must not rewrite or proxy')

  // Order is the control. nginx runs the rewrite phase (this `if`) before the
  // preaccess phase (limit_req), so a refused request consumes no rate-limit
  // token and never reaches proxy_pass. Asserting the source order as well
  // keeps a future edit from moving the gate below the limiter and quietly
  // handing an untrusted caller a way to exhaust a recipient's bucket.
  const source = readGateway('nginx.conf.template')
  const gateAt = source.indexOf('if ($aegis_edge_deny)')
  const limitAt = source.indexOf('limit_req zone=public_share_edge')
  const proxyAt = source.indexOf('proxy_pass http://drive:8001')
  assert.ok(gateAt > -1 && limitAt > -1 && proxyAt > -1)
  assert.ok(gateAt < limitAt, 'the trust gate must precede the rate limiter')
  assert.ok(gateAt < proxyAt, 'the trust gate must precede the upstream')

  // The limiter key is unchanged, and that is deliberate: realip makes
  // $binary_remote_addr the canonical recipient in managed mode, so the
  // PUBLIC-SHARE-3 spelling stays correct instead of being special-cased.
  const { http } = shareLocation()
  assert.match(
    oneDirective(http, 'limit_req_zone'),
    /^\$binary_remote_addr zone=public_share_edge:1m rate=5r\/s$/,
  )
})

test('PS7-STRUCT-3 the gateway authors identity and relays no provider header', () => {
  const { share } = shareLocation()
  const actual = Object.fromEntries(directiveValues(share, 'proxy_set_header').map((value) => {
    const [name, ...rest] = value.split(/\s+/)
    return [name, rest.join(' ')]
  }))

  // Authored from the canonical recipient, exactly as PUBLIC-SHARE-3 shipped.
  assert.equal(actual['X-Forwarded-For'], '$remote_addr')
  assert.equal(actual['X-Real-IP'], '$remote_addr')
  assert.equal(actual.Forwarded, '""')
  assert.equal(actual['X-Forwarded-Proto'], 'https')
  assert.equal(actual.Host, '$PUBLIC_SHARE_HOST')
  assert.equal(actual['X-Forwarded-Host'], '$PUBLIC_SHARE_HOST')

  // Every provider identity header this task can name is consumed at the
  // gateway. Drive must keep req.ip as its only client-source accessor, and a
  // header it never receives cannot be parsed by a future route.
  for (const header of [
    'CF-Connecting-IP', 'CF-Connecting-IPv6', 'CF-Pseudo-IPv4', 'True-Client-IP',
    'CF-Visitor', 'CF-IPCountry', 'CF-Ray', 'CF-Worker', 'CDN-Loop',
  ]) {
    assert.equal(actual[header], '""', `${header} must be stripped before Drive`)
  }
})

test('PS7-STRUCT-4 the shipped edge validator is fail-closed and renders only validated text', async (t) => {
  // Git for Windows cannot reliably project the native user TEMP path through
  // every POSIX-shell utility, so keep the disposable directory in the checkout.
  const tempRoot = process.platform === 'win32' ? process.cwd() : tmpdir()
  const workdir = await mkdtemp(join(tempRoot, '.ps7-edge-'))
  t.after(() => rm(workdir, { recursive: true, force: true }))

  // Git for Windows `sh` needs POSIX separators for an output path consumed by
  // shell utilities. Keep native paths for Node cleanup/reads and translate
  // only the two argv values crossing into the POSIX shell.
  const shellPath = (value) => {
    if (process.platform !== 'win32') return value
    return value
      .replaceAll('\\', '/')
      .replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`)
  }

  const run = (env) => {
    const out = join(workdir, `case-${randomBytes(6).toString('hex')}`)
    const scriptArgs = [shellPath(EDGE_VALIDATOR), shellPath(out)]
    const shellArgs = process.platform === 'win32'
      ? ['-c', 'PATH=/usr/bin:/mingw64/bin; export PATH; exec sh "$@"', 'sh', ...scriptArgs]
      : scriptArgs
    const result = spawnSync(POSIX_SHELL, shellArgs, {
      env: { PATH: process.env.PATH, ...env },
      encoding: 'utf8',
    })
    let rendered = null
    try {
      rendered = readFileSync(join(out, 'http.conf'), 'utf8')
    } catch { /* not rendered */ }
    return { ...result, rendered }
  }

  // ── the default is the already-accepted direct model ──────────────────────
  const direct = run({})
  assert.equal(
    direct.status,
    0,
    `an unconfigured gateway must keep the direct-peer model: ${direct.stderr}`,
  )
  assert.match(direct.rendered, /mode: direct/)
  assert.match(direct.rendered, /map \$remote_addr \$aegis_edge_deny \{\s*\n\s*default 0;/)
  assert.equal(direct.rendered.includes('set_real_ip_from'), false,
    'direct mode must not configure any provider trust')
  assert.equal(direct.rendered.includes('real_ip_header'), false)

  assert.equal(run({ PUBLIC_SHARE_EDGE_MODE: '' }).status, 0, 'an empty mode is the direct default')

  // ── managed mode is explicit, pinned, and single-identity ─────────────────
  const managed = run({
    PUBLIC_SHARE_EDGE_MODE: 'cloudflare',
    PUBLIC_SHARE_EDGE_PROXY_CIDR: `${CONNECTOR_IP}/32`,
  })
  assert.equal(managed.status, 0)
  assert.match(managed.rendered, new RegExp(`^set_real_ip_from ${CONNECTOR_IP.replace(/\./g, '\\.')}/32;$`, 'm'))
  assert.match(managed.rendered, /^real_ip_header CF-Connecting-IP;$/m)
  assert.match(managed.rendered, /^real_ip_recursive off;$/m)
  // All three controls exist, and the gate passes only when all three pass.
  assert.match(managed.rendered, /map \$realip_remote_addr \$aegis_edge_peer_untrusted/)
  assert.match(managed.rendered, /map "x\$http_cf_connecting_ip" \$aegis_edge_recipient_absent/)
  assert.match(managed.rendered, /map \$http_cf_connecting_ip \$aegis_edge_recipient_ambiguous/)
  assert.match(managed.rendered, /map \$remote_addr \$aegis_edge_not_canonical/)
  // Four controls, and the gate opens on exactly one combination.
  assert.match(managed.rendered, /"0000" 0;/)
  assert.match(managed.rendered, /default 1;/)
  // Exactly one trusted source. A second one would be a second identity.
  assert.equal((managed.rendered.match(/^set_real_ip_from /gm) ?? []).length, 1)

  // ── every malformed or ambiguous configuration refuses to start ───────────
  const refused = {
    'unknown mode': { PUBLIC_SHARE_EDGE_MODE: 'tunnel' },
    'case variant mode': { PUBLIC_SHARE_EDGE_MODE: 'Cloudflare' },
    'managed without a connector': { PUBLIC_SHARE_EDGE_MODE: 'cloudflare' },
    'managed with an empty connector': { PUBLIC_SHARE_EDGE_MODE: 'cloudflare', PUBLIC_SHARE_EDGE_PROXY_CIDR: '' },
    'connector without managed mode': { PUBLIC_SHARE_EDGE_PROXY_CIDR: '10.1.2.3/32' },
    'connector with explicit direct mode': { PUBLIC_SHARE_EDGE_MODE: 'direct', PUBLIC_SHARE_EDGE_PROXY_CIDR: '10.1.2.3/32' },
    'a /24 range': { PUBLIC_SHARE_EDGE_MODE: 'cloudflare', PUBLIC_SHARE_EDGE_PROXY_CIDR: '10.1.2.0/24' },
    'a /31 range': { PUBLIC_SHARE_EDGE_MODE: 'cloudflare', PUBLIC_SHARE_EDGE_PROXY_CIDR: '10.1.2.2/31' },
    'the whole Internet': { PUBLIC_SHARE_EDGE_MODE: 'cloudflare', PUBLIC_SHARE_EDGE_PROXY_CIDR: '0.0.0.0/0' },
    'a bare address': { PUBLIC_SHARE_EDGE_MODE: 'cloudflare', PUBLIC_SHARE_EDGE_PROXY_CIDR: '10.1.2.3' },
    'two identities': { PUBLIC_SHARE_EDGE_MODE: 'cloudflare', PUBLIC_SHARE_EDGE_PROXY_CIDR: '10.1.2.3/32,10.1.2.4/32' },
    'directive injection': { PUBLIC_SHARE_EDGE_MODE: 'cloudflare', PUBLIC_SHARE_EDGE_PROXY_CIDR: '1.2.3.4;x/32' },
    'brace injection': { PUBLIC_SHARE_EDGE_MODE: 'cloudflare', PUBLIC_SHARE_EDGE_PROXY_CIDR: '1.2.3.4}/32' },
    'newline injection': { PUBLIC_SHARE_EDGE_MODE: 'cloudflare', PUBLIC_SHARE_EDGE_PROXY_CIDR: '1.2.3.4/32\ndeny all;' },
    'nginx variable': { PUBLIC_SHARE_EDGE_MODE: 'cloudflare', PUBLIC_SHARE_EDGE_PROXY_CIDR: '$host/32' },
    'surrounding whitespace': { PUBLIC_SHARE_EDGE_MODE: 'cloudflare', PUBLIC_SHARE_EDGE_PROXY_CIDR: ' 1.2.3.4/32 ' },
    loopback: { PUBLIC_SHARE_EDGE_MODE: 'cloudflare', PUBLIC_SHARE_EDGE_PROXY_CIDR: '127.0.0.1/32' },
    unspecified: { PUBLIC_SHARE_EDGE_MODE: 'cloudflare', PUBLIC_SHARE_EDGE_PROXY_CIDR: '0.0.0.0/32' },
    multicast: { PUBLIC_SHARE_EDGE_MODE: 'cloudflare', PUBLIC_SHARE_EDGE_PROXY_CIDR: '239.1.2.3/32' },
    'octet above 255': { PUBLIC_SHARE_EDGE_MODE: 'cloudflare', PUBLIC_SHARE_EDGE_PROXY_CIDR: '10.1.2.256/32' },
    'leading zero octet': { PUBLIC_SHARE_EDGE_MODE: 'cloudflare', PUBLIC_SHARE_EDGE_PROXY_CIDR: '010.1.2.3/32' },
    'three octets': { PUBLIC_SHARE_EDGE_MODE: 'cloudflare', PUBLIC_SHARE_EDGE_PROXY_CIDR: '10.1.2/32' },
    'an IPv6 connector': { PUBLIC_SHARE_EDGE_MODE: 'cloudflare', PUBLIC_SHARE_EDGE_PROXY_CIDR: '2001:db8::1/128' },
  }
  for (const [label, env] of Object.entries(refused)) {
    const result = run(env)
    assert.equal(result.status, 1, `${label} must refuse to start (exit ${result.status})`)
    assert.match(result.stderr, /refusing to start/, `${label} must explain the refusal`)
    assert.equal(result.rendered, null, `${label} must render no trust file at all`)
  }

  // A refusal must never echo attacker-influenced input back into a log.
  const echoed = run({ PUBLIC_SHARE_EDGE_MODE: 'cloudflare', PUBLIC_SHARE_EDGE_PROXY_CIDR: '1.2.3.4;x/32' })
  assert.doesNotMatch(echoed.stderr, /1\.2\.3\.4/, 'the rejected value must not be echoed')
})

test('PS7-STRUCT-5 the managed-tunnel harness is isolated, port-free and does not widen Drive trust', () => {
  const compose = readFileSync(COMPOSE_FILE, 'utf8')

  // No host port anywhere, in any spelling.
  assert.doesNotMatch(compose, /^\s{4}ports:/m, 'no service may request a host port')
  assert.doesNotMatch(compose, /0\.0\.0\.0:/)

  // Every network carries BOTH isolation controls.
  for (const name of NETWORKS) {
    assert.match(compose, new RegExp(`^  ${name}:$`, 'm'), `${name} must be declared`)
  }
  assert.equal((compose.match(/^    internal: true$/gm) ?? []).length, 3)
  assert.equal(
    (compose.match(/com\.docker\.network\.bridge\.gateway_mode_ipv4: "isolated"/g) ?? []).length, 3,
    'an ordinary internal bridge still keeps the Docker-host bridge address',
  )

  // The gateway runs the REAL image in managed mode against ONE pinned /32.
  assert.match(compose, /^      context: \.\.$/m, 'the gateway must build from the shipped context')
  assert.match(compose, /^      PUBLIC_SHARE_EDGE_MODE: cloudflare$/m)
  assert.match(compose, new RegExp(`^      PUBLIC_SHARE_EDGE_PROXY_CIDR: ${CONNECTOR_IP.replace(/\./g, '\\.')}/32$`, 'm'))

  // Drive's trust boundary is NOT widened by this task: the same two pinned
  // identities PUBLIC-SHARE-6 used, and no Cloudflare range anywhere.
  assert.match(compose, new RegExp(`^      TRUSTED_PROXY_CIDRS: 172\\.19\\.255\\.2/32,${GATEWAY_UPSTREAM_IP.replace(/\./g, '\\.')}/32$`, 'm'))
  assert.match(compose, new RegExp(`^      PUBLIC_SHARE_GATEWAY_CIDR: ${GATEWAY_UPSTREAM_IP.replace(/\./g, '\\.')}/32$`, 'm'))
  assert.doesNotMatch(compose, /PUBLIC_SHARE_UI_ENABLED: "true"/)

  // The connector and the untrusted caller are stock images with no AEGIS code,
  // no credential and no volume — a stand-in must not be able to do more than
  // the thing it stands in for.
  for (const service of ['tunnel-connector', 'direct-caller']) {
    const block = compose.slice(compose.indexOf(`  ${service}:`))
    assert.match(block.slice(0, 400), /image: node:20-alpine/, `${service} must be a stock node image`)
  }
})

// ═══ Runtime matrix — opt-in ═════════════════════════════════════════════════

/**
 * How to invoke Docker. Defaults to plain `docker`, which is right on a
 * developer machine.
 *
 * ⚠️ Configurable because the AEGIS server host requires otherwise: the
 *    administrative account is not in the `docker` group and `DOCKER_HOST`
 *    points at a Podman socket that does not exist, so both the privilege and
 *    the environment have to be corrected at the call site:
 *
 *      PS7_DOCKER="sudo -n env -u DOCKER_HOST docker"
 */
const DOCKER_ARGV = String(process.env.PS7_DOCKER ?? 'docker').trim().split(/\s+/).filter(Boolean)
const DOCKER_BIN = DOCKER_ARGV[0]
const DOCKER_PREFIX = DOCKER_ARGV.slice(1)

/**
 * The Compose project this run owns, and the ONLY project any teardown here
 * ever names. The `aegis-ps7-` prefix is REQUIRED, not conventional: every
 * teardown is `-p $PROJECT`-scoped, so the prefix is what makes it structurally
 * impossible to aim one at `aegis-prod`.
 */
const PROJECT = resolveProject(process.env.PS7_PROJECT)

function resolveProject(given) {
  if (given === undefined || given === '') return `aegis-ps7-${process.pid}`
  if (given.length > 64 || !/^aegis-ps7-[a-z0-9][a-z0-9_-]*$/.test(given)) {
    throw new Error(
      `PS7_PROJECT must match /^aegis-ps7-[a-z0-9][a-z0-9_-]*$/ and be at most 64 characters, got ${JSON.stringify(given)}.`,
    )
  }
  return given
}

/**
 * The four values `docker-compose.yml` interpolates, and the ONLY four this
 * file will ever write to disk. All are minted per run with `randomBytes`; no
 * Production credential is read, derived or written anywhere here.
 */
const COMPOSE_INTERPOLATION_KEYS = [
  'PS7_SUPER_USER', 'PS7_SUPER_PASSWORD', 'PS7_DRIVE_DB_PASSWORD', 'PS7_SESSION_SECRET',
]

/**
 * Where to write those four values so Compose can interpolate them.
 *
 * ⚠️ THIS IS THE PUBLIC-SHARE-6 STAGE B ATTEMPT #1 LESSON, KEPT. `PS7_DOCKER`
 *    on the AEGIS server host is `sudo -n env -u DOCKER_HOST docker`, and a
 *    process environment does not cross a `sudo` boundary — sudo deliberately
 *    drops arbitrary variables, so values generated here never reach Compose
 *    and it refuses to interpolate. The fix is `--env-file`: a PATH survives
 *    any privilege boundary an argv survives. The boundary itself is left
 *    exactly as it is — no `sudo -E`, no `env_keep`, no docker-group change.
 */
const COMPOSE_ENV_FILE = resolveComposeEnvFile(
  process.env.PS7_COMPOSE_ENV_FILE, process.env.PS7_WORKDIR,
)

function resolveComposeEnvFile(given, workdir) {
  if (given === undefined || given === '') return null
  if (!isAbsolute(given)) {
    throw new Error(`PS7_COMPOSE_ENV_FILE must be an absolute path, got ${JSON.stringify(given)}.`)
  }
  const file = resolve(given)
  if (workdir !== undefined && workdir !== '') {
    const root = resolve(workdir)
    const rel = relative(root, file)
    if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(
        `PS7_COMPOSE_ENV_FILE must be inside PS7_WORKDIR (${root}), got ${file}. ` +
        'It holds throwaway Compose credentials and is removed by the workdir cleanup trap.',
      )
    }
  }
  return file
}

/**
 * Write the four throwaway interpolation values, and nothing else, mode 0600.
 * The values are NEVER printed, logged or returned — only the path is.
 */
async function writeComposeEnvFile(file, values) {
  const lines = COMPOSE_INTERPOLATION_KEYS.map((key) => {
    const value = values[key]
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error(`${key} must be a non-empty [A-Za-z0-9_-] value before it can be written`)
    }
    return `${key}=${value}`
  })
  await writeFile(file, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'w' })
  await chmod(file, 0o600)
  const mode = (await stat(file)).mode & 0o777
  if (mode !== 0o600) throw new Error(`the Compose env file must be mode 0600, got 0${mode.toString(8)}`)
  return file
}

/**
 * A minimal HTTP client for the in-container programs.
 *
 * It speaks node:http rather than fetch on purpose: fetch normalises a request
 * target such as `/s/<token>/../api/me`, and the un-normalised target is exactly
 * what the gateway's traversal guard has to be tested against. `setHost: false`
 * so the caller owns the Host header, including the poisoned values.
 */
const PRELUDE = `
const http = require('node:http')
const crypto = require('node:crypto')

function send(opts) {
  return new Promise((resolve) => {
    const req = http.request({
      host: opts.host, port: opts.port, path: opts.path,
      method: opts.method || 'GET', headers: opts.headers || {},
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
function out(value) { if (OUT_DONE) return; OUT_DONE = true; process.stdout.write(JSON.stringify(value)) }

const REDACT = []
function redactPreview(text, max) {
  let s = String(text == null ? '' : text).slice(0, max || 200)
  for (const secret of REDACT) { if (secret) s = s.split(secret).join('<<redacted>>') }
  return s
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
    if (res.status !== 200) throw new Error('login failed: status=' + res.status + ' error=' + res.error)
    this.csrf = res.data.csrfToken
    if (res.data.user && res.data.user.mustResetPassword) {
      const reset = await this.json('/api/password/reset', {
        method: 'POST', body: { currentPassword: used, newPassword: resetPassword },
      })
      if (reset.status !== 200) throw new Error('force-reset failed: status=' + reset.status)
    }
    return res.data
  }
}

/**
 * One bounded multipart upload. PS7 measures trust, not transfer size, so the
 * whole body is small enough for a single write; PUBLIC-SHARE-6 owns the
 * streaming/backpressure evidence for a 64 MiB object.
 */
async function uploadSmall(session, bytes) {
  const payload = Buffer.alloc(bytes)
  for (let i = 0; i < bytes; i += 32) {
    crypto.createHash('sha256').update('ps7-payload:' + i).digest().copy(payload, i, 0, Math.min(32, bytes - i))
  }
  const boundary = '----ps7payload' + Date.now()
  const head = Buffer.from(
    '--' + boundary + '\\r\\n'
    + 'Content-Disposition: form-data; name="file"; filename="ps7-payload.bin"\\r\\n'
    + 'Content-Type: application/octet-stream\\r\\n\\r\\n')
  const tail = Buffer.from('\\r\\n--' + boundary + '--\\r\\n')
  const body = Buffer.concat([head, payload, tail])
  const res = await send({
    ...DRIVE, path: '/api/files/upload', method: 'POST', body, captureBytes: 65536,
    headers: {
      Host: 'localhost', cookie: session.cookie, 'X-CSRF-Token': session.csrf,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': String(body.length),
    },
  })
  return { res, sha256: crypto.createHash('sha256').update(payload).digest('hex') }
}
`

/** Run `docker <args>` with `input` written to its stdin. */
function dockerStdin(args, input, { env, timeoutMs = 600_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
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
      resolvePromise({ stdout, stderr })
    })
    child.stdin.end(input)
  })
}

/** Run a program inside a container and parse its JSON stdout. */
async function runNode(containerId, program, { timeoutMs = 600_000 } = {}) {
  const { stdout, stderr } = await dockerStdin(['exec', '-i', containerId, 'node'], program, { timeoutMs })
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`in-container program printed non-JSON: ${stdout.slice(0, 2000)} / stderr ${stderr.slice(0, 2000)}`)
  }
}

test('PS7-PRE the managed-tunnel trust adapter holds in front of the real Drive', {
  skip: ENABLED ? false : 'set PUBLIC_SHARE_MANAGED_TUNNEL_RUNTIME=1 to run the isolated Docker harness',
  timeout: 1_800_000,
}, async (t) => {
  // Throwaway credentials, generated here, never read from or written to a .env.
  const env = {
    ...process.env,
    PS7_SUPER_USER: 'ps7_admin',
    PS7_SUPER_PASSWORD: randomBytes(18).toString('base64url'),
    PS7_DRIVE_DB_PASSWORD: randomBytes(18).toString('base64url'),
    PS7_SESSION_SECRET: randomBytes(32).toString('base64url'),
  }

  const docker = (args, options = {}) => execFileAsync(DOCKER_BIN, [...DOCKER_PREFIX, ...args], {
    env, maxBuffer: 64 * 1024 * 1024, ...options,
  })
  const compose = (args, options) => docker([
    'compose',
    ...(COMPOSE_ENV_FILE ? ['--env-file', COMPOSE_ENV_FILE] : []),
    '-p', PROJECT, '-f', COMPOSE_FILE,
    ...args,
  ], options)

  if (COMPOSE_ENV_FILE) {
    await writeComposeEnvFile(COMPOSE_ENV_FILE, env)
    console.log(`[ps7] Compose interpolation is supplied by ${COMPOSE_ENV_FILE} (mode 0600, contents never printed)`)
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
  const [gatewayId, driveId, postgresId, connectorId, callerId, surfaceId] = await Promise.all(
    ['public-share-gateway', 'drive', 'postgres', 'tunnel-connector', 'direct-caller', 'private-surface'].map(idOf),
  )
  assert.ok(
    gatewayId && driveId && postgresId && connectorId && callerId && surfaceId,
    'all six containers must be running',
  )

  /** Run SQL as the bootstrap superuser. Returns trimmed stdout. */
  const psql = async (sql, { db = 'aegis_drive' } = {}) => (await docker([
    'exec', '-e', `PGPASSWORD=${env.PS7_SUPER_PASSWORD}`, postgresId,
    'psql', '-v', 'ON_ERROR_STOP=1', '-U', env.PS7_SUPER_USER, '-d', db, '-tAc', sql,
  ])).stdout.trim()

  const auditCount = async () => Number(await psql('SELECT count(*) FROM audit_log'))
  const lastRedeemSource = () => psql(
    "SELECT host(source_ip) FROM audit_log WHERE action = 'SHARE_REDEEM' AND result = 'OK' ORDER BY id DESC LIMIT 1",
  )

  /** Everything the run needs to know about the artifact under test. */
  const artifact = { token: null, privateToken: null, sha256: null, shareId: null }

  /**
   * A subtest that consumes the artifact must not masquerade as an independent
   * finding when provisioning never produced one. Returning a string makes
   * node:test SKIP it and print the reason, so the run says "blocked" where it
   * would otherwise say "failed" — the PUBLIC-SHARE-6 attempt #2 lesson.
   */
  const blockedByProvisioning = (...required) => {
    const missing = required.filter((key) => artifact[key] === null || artifact[key] === undefined)
    return missing.length === 0
      ? false
      : `BLOCKED_BY_PS7_PRE_03 — provisioning did not produce ${missing.join(', ')}, so this subtest ` +
        'would assert against a non-existent artifact. It is blocked, not failed.'
  }

  const UNPROVISIONED_TOKEN = 'ps7-unprovisioned-token'
  const routingToken = () => artifact.token ?? UNPROVISIONED_TOKEN

  /**
   * Drive the gateway from a chosen edge container.
   *
   * `as` is the whole experiment: the SAME request from the pinned connector
   * and from an untrusted caller must not be treated the same way.
   */
  const edgeRequest = async (as, spec, { timeoutMs = 300_000 } = {}) => {
    const containerId = as === 'connector' ? connectorId : callerId
    const program = `${PRELUDE}
send(${JSON.stringify({ host: GATEWAY_EDGE_IP, port: 8080, ...spec })}).then(out)
`
    return runNode(containerId, program, { timeoutMs })
  }

  /** Many requests at once from one edge container, for the burst axis. */
  const edgeRequests = async (as, specs, { timeoutMs = 300_000 } = {}) => {
    const containerId = as === 'connector' ? connectorId : callerId
    const program = `${PRELUDE}
const specs = ${JSON.stringify(specs.map((spec) => ({ host: GATEWAY_EDGE_IP, port: 8080, ...spec })))}
Promise.all(specs.map((s) => send(s).then((r) => ({ status: r.status, error: r.error })))).then(out)
`
    return runNode(containerId, program, { timeoutMs })
  }

  const formBody = (password) => `password=${encodeURIComponent(password)}`
  /** A redemption as one simulated external recipient arriving through the tunnel. */
  const redeemSpec = (token, recipient, password, extraHeaders = {}) => ({
    path: `/s/${token}`,
    method: 'POST',
    body: formBody(password),
    headers: {
      Host: HOST,
      'CF-Connecting-IP': recipient,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(Buffer.byteLength(formBody(password))),
      ...extraHeaders,
    },
  })

  /** TCP reachability from inside a container, without depending on its shell. */
  const tcpProbe = async (containerId, targets) => {
    const program = `
const net = require('node:net')
const targets = ${JSON.stringify(targets)}
const one = (t) => new Promise((resolve) => {
  const socket = net.connect({ host: t.host, port: t.port })
  const done = (result) => { socket.destroy(); resolve({ label: t.label, result }) }
  socket.setTimeout(4000)
  socket.on('connect', () => done('open'))
  socket.on('timeout', () => done('timeout'))
  socket.on('error', (e) => done(e.code || 'error'))
})
Promise.all(targets.map(one)).then((r) => process.stdout.write(JSON.stringify(r)))
`
    return runNode(containerId, program, { timeoutMs: 120_000 })
  }

  // ── PS7-PRE-01 ─────────────────────────────────────────────────────────────
  await t.test('PS7-PRE-01 managed mode is explicit, real, and fails closed on bad configuration', async () => {
    // The image is running the managed model, not the direct one.
    const [gateway] = JSON.parse((await docker(['inspect', gatewayId])).stdout)
    assert.ok(gateway.Config.Env.includes('PUBLIC_SHARE_EDGE_MODE=cloudflare'))
    assert.ok(gateway.Config.Env.includes(`PUBLIC_SHARE_EDGE_PROXY_CIDR=${CONNECTOR_IP}/32`))
    assert.equal(gateway.Config.User, '101:101')
    assert.equal(gateway.HostConfig.ReadonlyRootfs, true)
    assert.equal(
      gateway.Config.Env.some((value) => /DATABASE_URL|SESSION_SECRET|VAULT|STORAGE|PASSWORD|TOKEN/i.test(value)),
      false, 'the gateway must hold no credential',
    )

    // ⚠️ MEASURED, NOT ASSUMED. The design chose nginx realip semantics on the
    //    condition that the SHIPPED image actually has the module. This is that
    //    proof, against the real gateway container.
    const nginxV = await docker(['exec', gatewayId, 'nginx', '-V'])
    const build = `${nginxV.stdout}${nginxV.stderr}`
    assert.match(build, /--with-http_realip_module/, 'the shipped gateway image must carry ngx_http_realip_module')
    console.log('[ps7] realip module present in the shipped gateway image (nginx -V)')

    // The generated trust file is on disk, pins exactly one source, and the
    // running config is valid.
    const generated = await docker(['exec', gatewayId, 'cat', EDGE_INCLUDE])
    assert.match(generated.stdout, new RegExp(`^set_real_ip_from ${CONNECTOR_IP.replace(/\./g, '\\.')}/32;$`, 'm'))
    assert.equal((generated.stdout.match(/^set_real_ip_from /gm) ?? []).length, 1)
    const configTest = await docker(['exec', gatewayId, 'nginx', '-t', '-c', '/tmp/nginx.conf'])
    assert.match(`${configTest.stdout}${configTest.stderr}`, /test is successful/)

    // A bad managed configuration must stop the container before nginx exists.
    const image = JSON.parse((await docker(['inspect', gatewayId])).stdout)[0].Image
    const refused = {
      'managed mode with no connector': ['-e', 'PUBLIC_SHARE_EDGE_MODE=cloudflare'],
      'a connector range': ['-e', 'PUBLIC_SHARE_EDGE_MODE=cloudflare', '-e', 'PUBLIC_SHARE_EDGE_PROXY_CIDR=10.1.2.0/24'],
      'directive injection': ['-e', 'PUBLIC_SHARE_EDGE_MODE=cloudflare', '-e', 'PUBLIC_SHARE_EDGE_PROXY_CIDR=1.2.3.4;x/32'],
      'an unknown mode': ['-e', 'PUBLIC_SHARE_EDGE_MODE=tunnel'],
      'a connector without managed mode': ['-e', 'PUBLIC_SHARE_EDGE_PROXY_CIDR=10.1.2.3/32'],
    }
    for (const [label, extra] of Object.entries(refused)) {
      const probe = await docker([
        'run', '--rm', '--network', 'none', '-e', `PUBLIC_SHARE_HOST=${HOST}`, ...extra,
        '--entrypoint', '/bin/sh', image, '-c',
        '/usr/local/bin/aegis-public-share-entrypoint.sh nginx -g "daemon off;" -c /tmp/nginx.conf; '
        + 'echo "GATE_EXIT=$?"; [ -f /tmp/aegis-edge/http.conf ] && echo RENDERED || echo NOT_RENDERED',
      ])
      const output = `${probe.stdout}${probe.stderr}`
      assert.match(output, /refusing to start/, `${label} must be refused`)
      assert.match(output, /GATE_EXIT=1/, `${label} must fail startup`)
      assert.match(output, /NOT_RENDERED/, `${label} must never render a trust file`)
      assert.equal(output.includes('Configuration complete'), false, `${label} must not reach nginx start-up`)
    }

    // And the container itself exits non-zero, so no restart policy or
    // orchestrator can mistake a refusal for a healthy start.
    await assert.rejects(
      docker(['run', '--rm', '--network', 'none', '-e', `PUBLIC_SHARE_HOST=${HOST}`,
        '-e', 'PUBLIC_SHARE_EDGE_MODE=cloudflare', '-e', 'PUBLIC_SHARE_EDGE_PROXY_CIDR=10.1.2.0/24', image]),
      'a malformed connector identity must make the gateway container exit non-zero',
    )

    // Backward compatibility, on the SAME image: with neither variable set the
    // gateway still renders and validates the direct-peer model.
    // ⚠️ `--add-host drive:127.0.0.1` is not cosmetic. `nginx -t` RESOLVES every
    //    proxy_pass upstream, so on an isolated container the test fails with
    //    "host not found in upstream" — an environment artefact that would be
    //    read as a config defect. The name only has to resolve; nothing connects.
    const direct = await docker([
      'run', '--rm', '--network', 'none', '--add-host', 'drive:127.0.0.1',
      '-e', `PUBLIC_SHARE_HOST=${HOST}`,
      '--entrypoint', '/bin/sh', image, '-c',
      '/usr/local/bin/aegis-validate-public-share-host.sh && /usr/local/bin/aegis-validate-public-share-edge.sh /tmp/aegis-edge '
      + '&& /docker-entrypoint.d/20-envsubst-on-templates.sh >/dev/null 2>&1 && nginx -t -c /tmp/nginx.conf 2>&1 && cat /tmp/aegis-edge/http.conf',
    ])
    assert.match(direct.stdout, /test is successful/, 'direct mode must still produce a valid config')
    assert.match(direct.stdout, /mode: direct/)
    assert.equal(direct.stdout.includes('set_real_ip_from'), false,
      'the unconfigured default must trust no provider header')
  })

  // ── PS7-PRE-02 ─────────────────────────────────────────────────────────────
  await t.test('PS7-PRE-02 only the pinned connector may assert recipient identity', async () => {
    const before = await auditCount()

    // The untrusted caller sends EXACTLY what the connector sends.
    const forgedProvider = await edgeRequest('caller', {
      path: `/s/${routingToken()}`,
      headers: { Host: HOST, 'CF-Connecting-IP': RECIPIENT_A },
      captureBytes: 4096,
    })
    assert.equal(forgedProvider.status, 403,
      'a caller that is not the pinned connector must be refused, whatever headers it sends')

    // Every other shape of the same lie.
    for (const headers of [
      { 'True-Client-IP': RECIPIENT_A },
      { 'X-Forwarded-For': RECIPIENT_A },
      { 'X-Real-IP': RECIPIENT_A },
      { Forwarded: `for=${RECIPIENT_A}` },
      { 'CF-Connecting-IP': RECIPIENT_A, 'X-Forwarded-For': FORGED_IP },
      {},
    ]) {
      const res = await edgeRequest('caller', {
        path: `/s/${routingToken()}`, headers: { Host: HOST, ...headers }, captureBytes: 4096,
      })
      assert.equal(res.status, 403, `an untrusted caller must be refused: ${JSON.stringify(headers)}`)
    }

    // The decisive half: none of it reached Drive at all.
    assert.equal(await auditCount(), before,
      'not one request from an untrusted caller may reach the application')
  })

  // ── PS7-PRE-03 ─────────────────────────────────────────────────────────────
  await t.test('PS7-PRE-03 the private path mints a public share and two recipients keep their own identity', async () => {
    const provision = `${PRELUDE}${PRIVATE_SESSION}
;(async () => {
  const s = new Session('localhost')
  await s.login(${JSON.stringify(SEED_USER)}, ${JSON.stringify(SEED_PASSWORD)}, ${JSON.stringify(RESET_PASSWORD)})
  REDACT.push(s.cookie, s.csrf, ${JSON.stringify(LINK_PASSWORD)}, ${JSON.stringify(RESET_PASSWORD)}, ${JSON.stringify(SEED_PASSWORD)})

  const up = await uploadSmall(s, ${FILE_BYTES})
  if (up.res.status !== 201) { out({ stage: 'upload', status: up.res.status, error: up.res.error, preview: redactPreview(up.res.text, 300) }); return }
  const uploaded = JSON.parse(up.res.text)

  // Created through a request carrying a POISONED Host header: the public URL
  // must come from PUBLIC_SHARE_BASE_URL alone.
  const poisoned = new Session('evil.attacker.invalid')
  poisoned.cookie = s.cookie; poisoned.csrf = s.csrf
  const share = await poisoned.json('/api/shares', { method: 'POST', body: {
    fileId: uploaded.file.id, expiry: '1h', authType: 'password', scope: 'public', password: ${JSON.stringify(LINK_PASSWORD)},
  } })

  // A second, NON-public share for the ingress-split subtest.
  const priv = await s.json('/api/shares', { method: 'POST', body: {
    fileId: uploaded.file.id, expiry: '1h', authType: 'none', scope: 'any',
  } })

  out({
    stage: 'ok', uploadStatus: up.res.status, sha256: up.sha256, serverSha256: uploaded.file.sha256,
    shareStatus: share.status, publicUrl: share.data && share.data.publicUrl,
    path: share.data && share.data.path, shareId: share.data && share.data.share && share.data.share.id,
    scope: share.data && share.data.share && share.data.share.scope,
    privateStatus: priv.status, privatePath: priv.data && priv.data.path,
  })
})().catch((e) => { out({ stage: 'exception', error: redactPreview(String((e && e.stack) || e), 1200) }) })
`
    const r = await runNode(driveId, provision, { timeoutMs: 600_000 })
    assert.equal(r.stage, 'ok', `provisioning failed: ${JSON.stringify(r)}`)
    assert.equal(r.uploadStatus, 201)
    assert.equal(r.serverSha256, r.sha256, 'the server must store exactly the bytes that were sent')
    assert.equal(r.shareStatus, 201, 'a public share must be creatable')
    assert.equal(r.scope, 'public')
    assert.equal(r.publicUrl, `${BASE_URL}${r.path}`)
    assert.doesNotMatch(String(r.publicUrl), /evil\.attacker\.invalid/,
      'T-09: a poisoned Host must contribute nothing to the public URL')
    assert.equal(r.privateStatus, 201)

    artifact.token = r.path.replace('/s/', '')
    artifact.privateToken = r.privatePath.replace('/s/', '')
    artifact.sha256 = r.serverSha256
    artifact.shareId = r.shareId

    // ── the attribution claim itself ────────────────────────────────────────
    // Two DIFFERENT simulated recipients, arriving through the SAME connector,
    // over the same TCP peer address. Nothing but CF-Connecting-IP distinguishes
    // them, and the audit must distinguish them anyway.
    const first = await edgeRequest('connector', redeemSpec(artifact.token, RECIPIENT_A, LINK_PASSWORD))
    assert.equal(first.status, 200, 'the correct link password must deliver through the managed hop')
    assert.equal(first.length, FILE_BYTES)
    assert.equal(first.sha256, artifact.sha256, 'the delivered bytes must be byte-identical')
    assert.equal(await lastRedeemSource(), RECIPIENT_A,
      'the audit must attribute the recipient the provider asserted, not the connector')

    const second = await edgeRequest('connector', redeemSpec(artifact.token, RECIPIENT_B, LINK_PASSWORD))
    assert.equal(second.status, 200)
    assert.equal(await lastRedeemSource(), RECIPIENT_B,
      'a second recipient through the same connector must be attributed separately')

    // Neither request may be attributed to any address inside the harness.
    const sources = (await psql(
      "SELECT DISTINCT host(source_ip) FROM audit_log WHERE action = 'SHARE_REDEEM' AND result = 'OK'",
    )).split('\n').map((line) => line.trim()).filter(Boolean)
    assert.deepEqual(sources.sort(), [RECIPIENT_B, RECIPIENT_A].sort())
    for (const infrastructure of [CONNECTOR_IP, GATEWAY_EDGE_IP, GATEWAY_UPSTREAM_IP, DRIVE_UPSTREAM_IP]) {
      assert.equal(sources.includes(infrastructure), false,
        `${infrastructure} is harness infrastructure and must never be attributed as a recipient`)
    }
    console.log(`[ps7] recipients attributed through one connector: ${sources.join(', ')}`)
  })

  // ── PS7-PRE-04 ─────────────────────────────────────────────────────────────
  await t.test('PS7-PRE-04 forged forwarding and provider headers cannot move attribution',
    { skip: blockedByProvisioning('token') }, async () => {
    // A legitimate redemption from a legitimate recipient, whose request ALSO
    // carries every header an attacker would use to claim to be someone else.
    // The connector's CF-Connecting-IP is the only one that may count.
    const forged = await edgeRequest('connector', redeemSpec(artifact.token, RECIPIENT_A, LINK_PASSWORD, {
      'X-Forwarded-For': FORGED_IP,
      'X-Real-IP': FORGED_IP,
      Forwarded: `for=${FORGED_IP};proto=https;host=evil.attacker.invalid`,
      'True-Client-IP': FORGED_IP,
      'CF-Pseudo-IPv4': FORGED_IP,
      'X-Forwarded-Host': 'evil.attacker.invalid',
    }))
    assert.equal(forged.status, 200, 'the redemption is legitimate; only the extra headers are forged')

    const source = await lastRedeemSource()
    assert.equal(source, RECIPIENT_A, "attribution must follow the pinned connector's assertion alone")
    assert.notEqual(source, FORGED_IP, 'a forged forwarding header must not reach attribution')
    assert.notEqual(source, CONNECTOR_IP, 'the connector must not be attributed as the recipient')

    assert.equal(
      Number(await psql(`SELECT count(*) FROM audit_log WHERE host(source_ip) = '${FORGED_IP}'`)), 0,
      'no audit row anywhere may carry the forged address',
    )
  })

  // ── PS7-PRE-05 ─────────────────────────────────────────────────────────────
  await t.test('PS7-PRE-05 a missing or unusable provider identity fails closed',
    { skip: blockedByProvisioning('token') }, async () => {
    const before = await auditCount()

    // The connector itself, but with nothing usable to attribute the request to.
    // Every one of these would otherwise leave $remote_addr as the connector and
    // collapse every recipient in the world onto one address.
    const unusable = {
      'no provider header at all': undefined,
      'an empty provider header': '',
      'a hostname instead of an address': 'recipient.example.invalid',
      'a truncated address': '203.0.113',
      'an octet above 255': '203.0.113.999',
      'a CIDR instead of an address': '203.0.113.0/24',
      'an injected directive': '203.0.113.10;deny all',
      'a list of two addresses': `${RECIPIENT_A}, ${RECIPIENT_B}`,
    }
    for (const [label, value] of Object.entries(unusable)) {
      const headers = { Host: HOST }
      if (value !== undefined) headers['CF-Connecting-IP'] = value
      const res = await edgeRequest('connector', {
        path: `/s/${artifact.token}`, headers, captureBytes: 4096,
      })
      assert.equal(res.status, 403, `${label} must fail closed, got ${res.status}`)
    }

    // A duplicated header is the same failure by another route: nginx joins the
    // values with ", ", which cannot canonicalise.
    const duplicated = await runNode(connectorId, `${PRELUDE}
const raw = 'GET /s/${artifact.token} HTTP/1.1\\r\\nHost: ${HOST}\\r\\n'
  + 'CF-Connecting-IP: ${RECIPIENT_A}\\r\\nCF-Connecting-IP: ${FORGED_IP}\\r\\nConnection: close\\r\\n\\r\\n'
const net = require('node:net')
const socket = net.connect({ host: ${JSON.stringify(GATEWAY_EDGE_IP)}, port: 8080 }, () => socket.write(raw))
let data = ''
socket.setTimeout(20000, () => { socket.destroy(); out({ status: 0, error: 'timeout' }) })
socket.on('data', (c) => { data += c })
socket.on('close', () => out({ status: Number((/^HTTP\\/1\\.1 (\\d{3})/.exec(data) || [0, 0])[1]) }))
socket.on('error', (e) => out({ status: 0, error: e.code }))
`, { timeoutMs: 120_000 })
    assert.equal(duplicated.status, 403,
      'two CF-Connecting-IP headers must fail closed rather than letting one win')

    assert.equal(await auditCount(), before,
      'a request that cannot be attributed must never reach the application')

    // ⚠️ NOT a failure case, and measured rather than assumed. nginx's realip
    //    accepts `<address>:<port>` and canonicalises it to the address, so a
    //    provider that included a source port would still be attributed to the
    //    right recipient. That is correct behaviour, so it is asserted as such
    //    rather than refused — an earlier draft of this suite expected 403 here
    //    and was simply wrong about what nginx does.
    const ported = await edgeRequest('connector', redeemSpec(`${artifact.token}`, `${RECIPIENT_A}:443`, LINK_PASSWORD))
    assert.equal(ported.status, 200, 'an address with a source port must still be attributable')
    assert.equal(await lastRedeemSource(), RECIPIENT_A,
      'the port must be dropped and the bare address attributed')
  })

  // ── PS7-PRE-06 ─────────────────────────────────────────────────────────────
  await t.test('PS7-PRE-06 the edge rate limit is per recipient, not per connector',
    { skip: blockedByProvisioning('token') }, async () => {
    // Let the leaky bucket drain from the previous subtests.
    await sleep(3000)

    // One recipient bursts through the connector.
    const burst = await edgeRequests('connector', Array.from({ length: 40 }, () => ({
      path: `/s/${artifact.token}`, headers: { Host: HOST, 'CF-Connecting-IP': RECIPIENT_A },
    })))
    const statuses = burst.map(({ status }) => status)
    const limited = statuses.filter((status) => status === 429).length
    assert.ok(limited > 0, `a burst from one recipient must be limited: ${JSON.stringify(statuses)}`)

    // ⚠️ THE CLAIM. A DIFFERENT recipient, immediately, over the SAME connector
    //    and the SAME TCP peer address. If the limiter were keyed on the
    //    connector this would be 429 — that is the T-05 self-DoS, where one
    //    abusive recipient rate-limits every other recipient on the Internet.
    const other = await edgeRequest('connector', {
      path: `/s/${artifact.token}`, headers: { Host: HOST, 'CF-Connecting-IP': RECIPIENT_B }, captureBytes: 4096,
    })
    assert.notEqual(other.status, 429,
      'a second recipient must hold an independent bucket behind the same connector')
    assert.equal(other.status, 200, 'the second recipient must be served normally')

    // A third recipient, likewise.
    const third = await edgeRequest('connector', {
      path: `/s/${artifact.token}`, headers: { Host: HOST, 'CF-Connecting-IP': RECIPIENT_V6 }, captureBytes: 4096,
    })
    assert.notEqual(third.status, 429, 'an IPv6 recipient must also hold its own bucket')

    // And an untrusted caller cannot choose a limiter identity at all: it is
    // refused before limit_req, so it can neither escape its own bucket nor
    // consume someone else's.
    const forged = await edgeRequest('caller', {
      path: `/s/${artifact.token}`, headers: { Host: HOST, 'CF-Connecting-IP': RECIPIENT_B }, captureBytes: 4096,
    })
    assert.equal(forged.status, 403, 'a forged provider header must not select a limiter identity')

    console.log(`[ps7] burst from ${RECIPIENT_A}: 200=${statuses.filter((s) => s === 200).length} 429=${limited}; `
      + `${RECIPIENT_B} immediately after: ${other.status}; ${RECIPIENT_V6}: ${third.status}`)
  })

  // ── PS7-PRE-07 ─────────────────────────────────────────────────────────────
  await t.test('PS7-PRE-07 no AEGIS surface but /s/:token survives the managed ingress', async (sub) => {
    if (!artifact.token) sub.diagnostic(`route-map probes use the synthetic token ${UNPROVISIONED_TOKEN}`)
    await sleep(3000)
    const before = await auditCount()

    const forbidden = [
      '/', '/api', '/api/', '/api/me', '/api/shares', '/api/files', '/api/audit',
      '/drive', '/drive/', '/drive/index.html', '/monitor', '/monitor/', '/monitor/internal/',
      '/healthz', '/admin', '/admin/users', '/login', '/settings', '/internal',
      '/API/', '/Drive/', '/HEALTHZ', '/Monitor/',
      // Traversal: normalises to an API path, but the RAW target is what the
      // gateway's request-target map checks.
      `/s/${routingToken()}/../api/me`,
      `/s/${routingToken()}/../../api/me`,
      '/s/', '/s', '/s/token/extra', '/s/token=', '/s/%2e%2e/api', '/static/app.js',
    ]
    // Sent as the pinned connector with a valid recipient identity, so a 404 is
    // the ROUTE refusing and not the trust gate — the two must not be conflated.
    const results = await Promise.all(forbidden.map((path) => edgeRequest('connector', {
      path, headers: { Host: HOST, 'CF-Connecting-IP': RECIPIENT_A }, captureBytes: 4096,
    })))
    for (const [index, res] of results.entries()) {
      assert.equal(res.status, 404, `${forbidden[index]} must be refused by the gateway, got ${res.status}`)
      assert.doesNotMatch(String(res.text ?? ''), /AEGIS|csrfToken|DataLake|aegis_drive/i,
        `${forbidden[index]} must not return anything from the application`)
    }

    const malformed = await edgeRequest('connector', {
      path: '/s/%ZZ', headers: { Host: HOST, 'CF-Connecting-IP': RECIPIENT_A }, captureBytes: 4096,
    })
    assert.ok([400, 404].includes(malformed.status), `malformed encoding returned ${malformed.status}`)

    for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
      const res = await edgeRequest('connector', {
        path: `/s/${routingToken()}`, method,
        headers: { Host: HOST, 'CF-Connecting-IP': RECIPIENT_A }, captureBytes: 4096,
      })
      assert.equal(res.status, 405, `${method} must stop before Drive`)
    }

    // An unknown Host still terminates at the default server, connector or not.
    for (const host of ['evil.attacker.invalid', GATEWAY_EDGE_IP, 'localhost', `${HOST}.attacker.invalid`]) {
      const res = await edgeRequest('connector', {
        path: `/s/${routingToken()}`, headers: { Host: host, 'CF-Connecting-IP': RECIPIENT_A }, captureBytes: 4096,
      })
      assert.equal(res.status, 404, `Host ${host} must fall to the default server, got ${res.status}`)
    }

    assert.equal(await auditCount(), before, 'not one refused request may reach the application')
  })

  // ── PS7-PRE-08 ─────────────────────────────────────────────────────────────
  await t.test('PS7-PRE-08 a non-public share is still out of scope on the managed ingress',
    { skip: blockedByProvisioning('privateToken', 'sha256') }, async () => {
    await sleep(3000)
    const viaTunnel = await edgeRequest('connector', {
      path: `/s/${artifact.privateToken}`,
      headers: { Host: HOST, 'CF-Connecting-IP': RECIPIENT_A },
      captureBytes: 4096,
    })
    assert.equal(viaTunnel.status, 403,
      'a scope=any share must be out of scope when it arrives through the public gateway')
    assert.notEqual(viaTunnel.length, FILE_BYTES)
    assert.equal(
      await psql("SELECT result FROM audit_log WHERE action = 'SHARE_REDEEM_OUT_OF_SCOPE' ORDER BY id DESC LIMIT 1"),
      'BLOCKED', 'the refusal must be recorded as BLOCKED')

    // ⚠️ The ingress classification still names the GATEWAY, not the connector
    //    and not the recipient. If realip had leaked into Drive's view of the
    //    peer, this share would have been treated as private and delivered.
    const program = `${PRELUDE}
send({ host: '127.0.0.1', port: 8001, path: ${JSON.stringify(`/s/${artifact.privateToken}`)}, headers: { Host: 'localhost' } }).then(out)
`
    const viaPrivate = await runNode(driveId, program, { timeoutMs: 300_000 })
    assert.equal(viaPrivate.status, 200, 'the same share must still redeem on the private path')
    assert.equal(viaPrivate.length, FILE_BYTES)
    assert.equal(viaPrivate.sha256, artifact.sha256)
  })

  // ── PS7-PRE-09 ─────────────────────────────────────────────────────────────
  await t.test('PS7-PRE-09 audit attribution survives the managed hop, including IPv6',
    { skip: blockedByProvisioning('token') }, async () => {
    await sleep(3000)

    // IPv6 recipients are attributable end to end: nginx canonicalises the
    // address, the gateway authors it into X-Forwarded-For, Express resolves
    // req.ip to it, and `audit_log.source_ip` is INET, which holds it.
    const v6 = await edgeRequest('connector', redeemSpec(artifact.token, RECIPIENT_V6, LINK_PASSWORD))
    assert.equal(v6.status, 200, 'an IPv6 recipient must be able to redeem')
    assert.equal(v6.length, FILE_BYTES)
    assert.equal(await lastRedeemSource(), RECIPIENT_V6,
      'an IPv6 recipient must be attributed as itself, not as the connector')

    // Nothing secret reached the audit, from real end-to-end redemptions.
    const leaked = await psql(
      `SELECT count(*) FROM audit_log WHERE actor_label LIKE '%${artifact.token}%' OR target_hash LIKE '%${artifact.token}%'`,
    )
    assert.equal(Number(leaked), 0, 'the raw share token must never reach the audit')
    assert.equal(
      Number(await psql(`SELECT count(*) FROM audit_log WHERE target_hash LIKE '%${LINK_PASSWORD}%'`)), 0,
      'the link password must never reach the audit',
    )

    // A wrong link password is still refused through the tunnel, and is still
    // attributed to the recipient rather than to the connector.
    const wrong = await edgeRequest('connector', redeemSpec(artifact.token, RECIPIENT_B, 'ps7-link-wrong-000'))
    assert.notEqual(wrong.status, 200, 'a wrong link password must not deliver')
    assert.notEqual(wrong.length, FILE_BYTES)
    const denied = await psql(
      "SELECT host(source_ip) FROM audit_log WHERE action LIKE 'SHARE_REDEEM%' AND result <> 'OK' ORDER BY id DESC LIMIT 1",
    )
    assert.equal(denied, RECIPIENT_B, 'a refusal must be attributed to the recipient that caused it')
  })

  // ── PS7-PRE-10 ─────────────────────────────────────────────────────────────
  await t.test('PS7-PRE-10 no token, password, recipient or provider identity reaches the gateway log',
    { skip: blockedByProvisioning('token') }, async () => {
    await sleep(3000)
    const sentinelToken = `TOKEN_MUST_NOT_APPEAR_${randomBytes(8).toString('hex')}`
    const sentinelPassword = `PASSWORD_MUST_NOT_APPEAR_${randomBytes(8).toString('hex')}`
    const sentinelRecipient = '203.0.113.222'

    await edgeRequests('connector', [
      { path: `/s/${sentinelToken}`, headers: { Host: HOST, 'CF-Connecting-IP': sentinelRecipient } },
      { path: `/api/${sentinelToken}`, headers: { Host: HOST, 'CF-Connecting-IP': sentinelRecipient } },
      {
        path: `/s/${sentinelToken}`, method: 'POST',
        body: `password=${sentinelPassword}`,
        headers: {
          Host: HOST, 'CF-Connecting-IP': sentinelRecipient,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': String(`password=${sentinelPassword}`.length),
        },
      },
      // Also through the refusal paths, which are a different code path in nginx.
      { path: `/s/${sentinelToken}`, headers: { Host: HOST } },
      ...Array.from({ length: 20 }, () => ({
        path: `/s/${sentinelToken}`, headers: { Host: HOST, 'CF-Connecting-IP': sentinelRecipient },
      })),
    ])

    // The REAL nginx container's own access and error logs, not a model of them.
    const captured = await docker(['logs', gatewayId])
    const logs = `${captured.stdout}${captured.stderr}`
    assert.ok(logs.length > 0, 'the gateway must have produced access logs to inspect')
    assert.equal(logs.includes(sentinelToken), false, 'a raw bearer token leaked into the gateway log')
    assert.equal(logs.includes(sentinelPassword), false, 'a link password leaked into the gateway log')
    assert.equal(logs.includes(sentinelRecipient), false, 'a recipient address leaked into the gateway log')
    assert.equal(logs.includes(artifact.token), false, 'the real share token leaked into the gateway log')
    assert.equal(logs.includes(LINK_PASSWORD), false, 'the real link password leaked into the gateway log')
    // The provider identity headers must not be persisted either — the whole
    // point of a log format that carries no header, URI or address at all.
    for (const value of [RECIPIENT_A, RECIPIENT_B, RECIPIENT_V6, CONNECTOR_IP]) {
      assert.equal(logs.includes(value), false, `${value} must not be persisted in the gateway log`)
    }
    console.log(`[ps7] token, password, recipient and connector identities absent from ${logs.length} bytes of real gateway log`)
  })

  // ── PS7-PRE-11 ─────────────────────────────────────────────────────────────
  await t.test('PS7-PRE-11 B5 holds: the gateway reaches its upstream and nothing else', async () => {
    const routes = (await docker(['exec', gatewayId, 'ip', 'route'])).stdout
    assert.doesNotMatch(routes, /^default /m, 'the gateway must have no default route')

    const probe = async (target, port) => {
      const out = await docker(['exec', gatewayId, 'sh', '-c',
        `nc -w 3 -z ${target} ${port} >/dev/null 2>&1 && echo open || echo closed`]).catch(() => ({ stdout: 'closed' }))
      return out.stdout.trim()
    }

    // The one permitted path.
    assert.equal(await probe('drive', 8001), 'open', 'the gateway must reach its one upstream')

    // PS7-23 and PS7-24: neither the database nor a private-side surface.
    assert.equal(await probe(POSTGRES_IP, 5432), 'closed', 'the gateway must not reach PostgreSQL')
    assert.equal(await probe(PRIVATE_SURFACE_IP, 8080), 'closed',
      'the gateway must not reach a private-side service')

    // No Docker host path, on either of its two networks.
    for (const bridge of ['172.31.240.1', '172.31.241.1']) {
      assert.equal(await probe(bridge, 8080), 'closed', `the gateway must not reach ${bridge}`)
    }
    // ⚠️ HOW unreachability presents is engine- and host-dependent, and this
    //    assertion must not encode one platform's wording. PUBLIC-SHARE-3
    //    measured "Host is unreachable" on Docker Desktop 28.3.2; on native
    //    Linux Docker 29.7.1 with `gateway_mode_ipv4: isolated` the packet is
    //    dropped with no ICMP reply at all, so the client times out instead.
    //    Both mean nothing answered, and an earlier draft of this suite failed
    //    on the wording rather than on the property.
    //
    //    "Connection refused" is the DISCRIMINATOR this check exists for: it
    //    proves the bridge address is LIVE and that isolated mode is not in
    //    force. A timeout is the opposite of that, so it is asserted first.
    const hostHttp = await docker(['exec', gatewayId, 'sh', '-c',
      'wget -qO- -T 3 http://172.31.240.1/ 2>&1 || true'])
    assert.doesNotMatch(hostHttp.stdout, /Connection refused/i,
      'Connection refused means the host address is live; isolated mode is not in force')
    assert.match(hostHttp.stdout, /unreachable|timed out|timeout/i,
      `172.31.240.1 answered at L3: ${hostHttp.stdout}`)
    assert.doesNotMatch(hostHttp.stdout, /HTTP\/|<html|<!doctype/i,
      `a host service served a response at 172.31.240.1: ${hostHttp.stdout}`)

    // Corroboration that nothing holds the address at all, independent of how
    // the HTTP client words its failure: an ARP entry with an all-zero MAC is
    // an incomplete resolution. No entry at all is equally fine — what must
    // never appear is a COMPLETED one, which would mean something answered.
    const arp = await docker(['exec', gatewayId, 'sh', '-c', 'cat /proc/net/arp'])
    const bridgeEntry = arp.stdout.split('\n').find((line) => line.startsWith('172.31.240.1'))
    if (bridgeEntry) {
      assert.match(bridgeEntry, /00:00:00:00:00:00/,
        `something answered ARP for the bridge address: ${bridgeEntry}`)
    }

    // No egress. Decided locally by the absence of a route, so this never
    // depends on real Internet availability.
    for (const address of ['1.1.1.1', '8.8.8.8']) {
      const egress = await docker(['exec', gatewayId, 'sh', '-c',
        `wget -qO- -T 4 http://${address}/ 2>&1 || true`])
      assert.match(egress.stdout, /Network unreachable/i, `gateway reached ${address}: ${egress.stdout}`)
    }

    // Names the gateway must not even be able to resolve.
    for (const name of ['postgres', 'private-surface', 'monitor', 'host.docker.internal']) {
      const lookup = await docker(['exec', gatewayId, 'sh', '-c', `nslookup ${name} 2>&1 || true`])
      assert.doesNotMatch(lookup.stdout, /^Address:\s*(?!127\.0\.0\.11)\d/m,
        `${name} resolved to a usable address from the gateway: ${lookup.stdout}`)
    }

    // No host port, and the topology is the one the file declares.
    const ps = (await compose(['ps', '--format', 'json'])).stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    assert.equal(ps.length, 6, 'exactly six services')
    for (const service of ps) {
      assert.equal(
        String(service.Publishers ? service.Publishers.filter((p) => p.PublishedPort).length : 0), '0',
        `${service.Service} must publish no host port`,
      )
    }
    const membersOf = async (name) => {
      const net = JSON.parse((await docker(['network', 'inspect', name])).stdout)[0]
      assert.equal(net.Internal, true, `${name} must be internal`)
      assert.equal(net.Options?.['com.docker.network.bridge.gateway_mode_ipv4'], 'isolated',
        `${name} must also drop the Docker-host bridge address`)
      return new Set(Object.keys(net.Containers ?? {}))
    }
    assert.deepEqual([...(await membersOf(EDGE_NETWORK))].sort(), [connectorId, callerId, gatewayId].sort(),
      'the edge network must hold exactly the connector, the untrusted caller and the gateway')
    assert.deepEqual([...(await membersOf(UPSTREAM_NETWORK))].sort(), [gatewayId, driveId].sort())
    assert.deepEqual([...(await membersOf(DATA_NETWORK))].sort(), [driveId, postgresId, surfaceId].sort())
  })

  // ── PS7-PRE-12 ─────────────────────────────────────────────────────────────
  await t.test('PS7-PRE-12 the tunnel connector cannot bypass the gateway', async () => {
    // ⚠️ The positive control first. `private-surface` genuinely listens and is
    //    genuinely reachable from the private side, so the negatives below are
    //    measured refusals rather than probes against a dead address.
    const fromDrive = await tcpProbe(driveId, [
      { label: 'private-surface', host: PRIVATE_SURFACE_IP, port: 8080 },
      { label: 'postgres', host: POSTGRES_IP, port: 5432 },
    ])
    assert.deepEqual(fromDrive.map((r) => [r.label, r.result]).sort(), [
      ['postgres', 'open'], ['private-surface', 'open'],
    ], `the private side must actually reach both: ${JSON.stringify(fromDrive)}`)

    // Now the claim: the public-side components can reach the gateway listener
    // and nothing else.
    for (const [label, id] of [['tunnel-connector', connectorId], ['direct-caller', callerId]]) {
      const results = await tcpProbe(id, [
        { label: 'gateway', host: GATEWAY_EDGE_IP, port: 8080 },
        { label: 'drive-upstream', host: DRIVE_UPSTREAM_IP, port: 8001 },
        { label: 'gateway-upstream', host: GATEWAY_UPSTREAM_IP, port: 8001 },
        { label: 'postgres', host: POSTGRES_IP, port: 5432 },
        { label: 'private-surface', host: PRIVATE_SURFACE_IP, port: 8080 },
        { label: 'edge-bridge', host: '172.31.240.1', port: 8080 },
      ])
      const byLabel = Object.fromEntries(results.map((r) => [r.label, r.result]))
      assert.equal(byLabel.gateway, 'open', `${label} must reach the gateway listener`)
      for (const forbidden of ['drive-upstream', 'gateway-upstream', 'postgres', 'private-surface', 'edge-bridge']) {
        assert.notEqual(byLabel[forbidden], 'open',
          `${label} reached ${forbidden}: ${JSON.stringify(byLabel)}`)
      }
    }

    // And by name, not only by address: Drive is not even resolvable from the
    // edge network, so a connector that was compromised has no target to find.
    const lookup = await runNode(connectorId, `
require('node:dns').promises.lookup('drive').then(
  (r) => process.stdout.write(JSON.stringify({ resolved: r.address })),
  (e) => process.stdout.write(JSON.stringify({ error: e.code })),
)
`, { timeoutMs: 60_000 })
    assert.equal(lookup.resolved, undefined, `drive resolved from the connector: ${JSON.stringify(lookup)}`)
  })

  // ── PS7-PRE-13 ─────────────────────────────────────────────────────────────
  await t.test('PS7-PRE-13 revocation propagates through the managed path immediately',
    { skip: blockedByProvisioning('token', 'shareId') }, async () => {
    await sleep(3000)
    const hitsOf = async () => Number(await psql(`SELECT hits FROM shares WHERE id = ${Number(artifact.shareId)}`))

    const program = `${PRELUDE}${PRIVATE_SESSION}
;(async () => {
  const s = new Session('localhost')
  await s.login(${JSON.stringify(SEED_USER)}, ${JSON.stringify(SEED_PASSWORD)}, ${JSON.stringify(RESET_PASSWORD)})
  const res = await s.json('/api/shares/' + ${JSON.stringify(String(artifact.shareId))}, { method: 'DELETE' })
  out({ status: res.status, error: res.error })
})().catch((e) => { out({ status: 0, error: redactPreview(String((e && e.stack) || e), 600) }) })
`
    const revoked = await runNode(driveId, program, { timeoutMs: 300_000 })
    assert.equal(revoked.status, 200, `the owner must be able to revoke (error: ${revoked.error ?? 'none'})`)

    const before = await hitsOf()
    const after = await edgeRequest('connector', redeemSpec(artifact.token, RECIPIENT_A, LINK_PASSWORD))
    assert.equal(after.status, 404, 'a revoked link must be indistinguishable from an unknown one')
    assert.notEqual(after.length, FILE_BYTES, 'a revoked link must deliver no bytes')
    assert.equal(await hitsOf(), before, 'a revoked attempt must count no hit')
  })

  // ── PS7-PRE-14 ─────────────────────────────────────────────────────────────
  await t.test('PS7-PRE-14 the harness removes everything it created', async () => {
    await compose(['down', '--volumes', '--remove-orphans', '--timeout', '10'])
    started = false

    for (const name of NETWORKS) {
      await assert.rejects(docker(['network', 'inspect', name]), `${name} must be gone`)
    }
    for (const id of [gatewayId, driveId, postgresId, connectorId, callerId, surfaceId]) {
      await assert.rejects(docker(['container', 'inspect', id]), 'every harness container must be gone')
    }
    assert.equal(
      (await docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${PROJECT}`])).stdout.trim(), '',
      'no container may survive the teardown',
    )
    assert.equal(
      (await docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`])).stdout.trim(), '',
      'no volume may survive the teardown',
    )

    // The teardown is project-scoped, so it must NOT have reached the shared
    // base images. The cheap negative that catches a future `--rmi all`.
    for (const image of ['postgres:15-alpine', 'node:20-alpine']) {
      await docker(['image', 'inspect', image])
    }
  })
})
