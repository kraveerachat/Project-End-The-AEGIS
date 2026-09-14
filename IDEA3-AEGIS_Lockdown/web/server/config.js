import { readFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const MINIMUM_SESSION_SECRET_LENGTH = 32
const DEVELOPMENT_SESSION_SECRET = 'development-only-session-secret-change-me'
const BCRYPT_HASH = /^\$2([aby])\$(\d{2})\$[./A-Za-z0-9]{53}$/

function validateProductionSessionSecret(sessionSecret) {
  const characterClasses = [
    /[a-z]/.test(sessionSecret),
    /[A-Z]/.test(sessionSecret),
    /[0-9]/.test(sessionSecret),
    /[^A-Za-z0-9]/.test(sessionSecret),
  ].filter(Boolean).length
  const repeatedCharacter = /^(.)\1+$/.test(sessionSecret)

  if (
    sessionSecret.length < MINIMUM_SESSION_SECRET_LENGTH
    || sessionSecret === DEVELOPMENT_SESSION_SECRET
    || repeatedCharacter
    || characterClasses < 3
  ) {
    throw new Error('SESSION_SECRET does not satisfy the production secret policy')
  }
}

function validateProductionPasswordHash(passwordHash) {
  const match = typeof passwordHash === 'string' ? BCRYPT_HASH.exec(passwordHash) : null
  const cost = match ? Number.parseInt(match[2], 10) : 0
  if (!match || cost < 12 || cost > 31) {
    throw new Error('AEGIS_IDEA3_ADMIN_PASSWORD_HASH does not satisfy the production bcrypt policy')
  }
}

// PR11 Phase 2 (design §4.6). A container receives its secrets as read-only
// files, so they never appear in a rendered Compose model or `docker inspect`.
// Errors name the variable only and never contain the file content.
function secretValue(env, name) {
  const fileName = `${name}_FILE`
  const direct = env[name]
  const file = env[fileName]
  const hasDirect = typeof direct === 'string' && direct !== ''
  if (typeof file !== 'string' || file === '') return hasDirect ? direct : null

  if (hasDirect) throw new Error(`Set only one of ${name} and ${fileName}`)
  if (!path.isAbsolute(file)) throw new Error(`${fileName} must be an absolute path`)
  let content
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`${fileName} could not be read`)
  }
  return content.replace(/\r?\n$/, '')
}

function integrationCredential(value) {
  const credential = typeof value === 'string' ? value.trim() : ''
  return credential.length > 0 ? credential : null
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function configuredPositiveInteger(name, value, fallback, production) {
  if (value === undefined || value === null) return fallback

  if (production && !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`)
  }

  const parsed = Number(value)
  if (production && (!Number.isSafeInteger(parsed) || parsed <= 0)) {
    throw new Error(`${name} must be a positive integer`)
  }
  return production ? parsed : positiveInteger(value, fallback)
}

function auditDatabasePath(value, nodeEnv) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (nodeEnv === 'test') return raw || ':memory:'
  if (nodeEnv === 'production') {
    if (!raw || !path.isAbsolute(raw)) {
      throw new Error('AEGIS_IDEA3_AUDIT_DB_PATH must be an absolute path in production')
    }
    return path.resolve(raw)
  }
  return raw || '.aegis-runtime/security-center-audit.sqlite3'
}

function webBasePath(value, production) {
  const raw = value ?? (production ? '/security' : '')
  if (raw === '') return ''
  const segments = raw.split('/').slice(1)
  if (
    !raw.startsWith('/')
    || raw.endsWith('/')
    || segments.length === 0
    || segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))
  ) {
    throw new Error('AEGIS_WEB_BASE_PATH must be a normalized absolute URL path')
  }
  return raw
}

function staticDirectory(value, production) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) {
    if (production) throw new Error('AEGIS_WEB_STATIC_DIR is required in production')
    return null
  }
  if (!path.isAbsolute(raw)) {
    throw new Error('AEGIS_WEB_STATIC_DIR must be an absolute path')
  }
  return path.resolve(raw)
}

function loopbackHost(value) {
  const host = value || '127.0.0.1'
  if (!['127.0.0.1', '::1'].includes(host)) {
    throw new Error('AEGIS_BIND_HOST must be a loopback address')
  }
  return host
}

// PR10 S2 machine boundary (spec §4.4, §4.9). The local default bind address is
// for local and test execution only; the Production value is selected by the
// separately authorized K4/K5/K7 work and is never hard-coded here.
const LOCAL_DISPATCH_HOST = '127.0.0.1'
const DISPATCH_SUBJECT = /^[a-z0-9][a-z0-9-]{0,62}$/
const UNSPECIFIED_ADDRESSES = new net.BlockList()
UNSPECIFIED_ADDRESSES.addAddress('0.0.0.0', 'ipv4')
UNSPECIFIED_ADDRESSES.addAddress('::', 'ipv6')
const LOOPBACK_ADDRESSES = new net.BlockList()
LOOPBACK_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK_ADDRESSES.addAddress('::1', 'ipv6')

function dispatchEnabled(value) {
  if (value === undefined || value === null || value === '' || value === 'false') return false
  if (value === 'true') return true
  throw new Error('AEGIS_IDEA3_DISPATCH_ENABLED must be true or false')
}

function ipLiteral(name, value) {
  const address = typeof value === 'string' ? value : ''
  const family = net.isIP(address)
  // IPv4-mapped and IPv4-compatible IPv6 forms are refused as ambiguous.
  if (family === 0 || (family === 6 && address.includes('.'))) {
    throw new Error(`${name} must be a single IP address literal`)
  }
  return { address, family: family === 4 ? 'ipv4' : 'ipv6' }
}

function sameAddress(left, right) {
  const family = (address) => (net.isIP(address) === 6 ? 'ipv6' : 'ipv4')
  const list = new net.BlockList()
  list.addAddress(left, family(left))
  return list.check(right, family(right))
}

function dispatchPort(value, webPort) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error('AEGIS_IDEA3_DISPATCH_PORT must be a positive integer port')
  }
  const port = Number(value)
  if (port > 65_535 || port === webPort) {
    throw new Error('AEGIS_IDEA3_DISPATCH_PORT must be a valid port different from PORT')
  }
  return port
}

function dispatchHost(value, production) {
  if (typeof value !== 'string' || value === '') {
    if (production) throw new Error('AEGIS_IDEA3_DISPATCH_HOST must be set explicitly in production')
    return LOCAL_DISPATCH_HOST
  }
  const { address, family } = ipLiteral('AEGIS_IDEA3_DISPATCH_HOST', value)
  if (UNSPECIFIED_ADDRESSES.check(address, family)) {
    throw new Error('AEGIS_IDEA3_DISPATCH_HOST must name one interface, not an unspecified address')
  }
  if (production && LOOPBACK_ADDRESSES.check(address, family)) {
    throw new Error('AEGIS_IDEA3_DISPATCH_HOST must not be loopback in production')
  }
  return address
}

function dispatchConfig(env, { production, webPort }) {
  if (!dispatchEnabled(env.AEGIS_IDEA3_DISPATCH_ENABLED)) return Object.freeze({ enabled: false })

  const expectedSubject = env.AEGIS_IDEA3_DISPATCH_EXPECTED_SUBJECT
  if (typeof expectedSubject !== 'string' || !DISPATCH_SUBJECT.test(expectedSubject)) {
    throw new Error('AEGIS_IDEA3_DISPATCH_EXPECTED_SUBJECT must be a lower-case machine name')
  }
  return Object.freeze({
    enabled: true,
    host: dispatchHost(env.AEGIS_IDEA3_DISPATCH_HOST, production),
    port: dispatchPort(env.AEGIS_IDEA3_DISPATCH_PORT, webPort),
    trustedProxy: ipLiteral('AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY', env.AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY).address,
    expectedSubject,
  })
}

// PR11 Phase 2 proxied browser listener (design §4.2, D3). Without a trusted
// proxy the browser listener stays loopback-only, unchanged. With one, the
// listener binds exactly one non-loopback interface on the dedicated HUB<->IDEA3
// network, and only the pinned HUB address is trusted for forwarded headers.
function webTrustedProxy(value) {
  if (value === undefined || value === null || value === '') return null
  const { address, family } = ipLiteral('AEGIS_WEB_TRUSTED_PROXY', value)
  if (UNSPECIFIED_ADDRESSES.check(address, family)) {
    throw new Error('AEGIS_WEB_TRUSTED_PROXY must name one proxy address, not an unspecified address')
  }
  return address
}

function proxiedBindHost(value, trustedProxy) {
  if (typeof value !== 'string' || value === '') {
    throw new Error('AEGIS_BIND_HOST must be set explicitly when AEGIS_WEB_TRUSTED_PROXY is set')
  }
  const { address, family } = ipLiteral('AEGIS_BIND_HOST', value)
  if (UNSPECIFIED_ADDRESSES.check(address, family) || LOOPBACK_ADDRESSES.check(address, family)) {
    throw new Error('AEGIS_BIND_HOST must name one non-loopback interface when AEGIS_WEB_TRUSTED_PROXY is set')
  }
  if (sameAddress(trustedProxy, address)) {
    throw new Error('AEGIS_BIND_HOST must differ from AEGIS_WEB_TRUSTED_PROXY')
  }
  return address
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development'
  const production = nodeEnv === 'production'
  const sessionSecret = secretValue(env, 'SESSION_SECRET') || ''
  const username = env.AEGIS_IDEA3_ADMIN_USER || 'admin'
  const passwordHash = secretValue(env, 'AEGIS_IDEA3_ADMIN_PASSWORD_HASH') || null
  const allowDevelopmentLogin = !production && env.AEGIS_ALLOW_DEV_LOGIN === 'true'
  const developmentPassword = allowDevelopmentLogin
    ? env.AEGIS_IDEA3_DEV_PASSWORD || null
    : null

  if (production) {
    validateProductionSessionSecret(sessionSecret)
    validateProductionPasswordHash(passwordHash)
  }

  if (allowDevelopmentLogin && !developmentPassword) {
    throw new Error('AEGIS_IDEA3_DEV_PASSWORD is required when development login is enabled')
  }

  const basePath = webBasePath(env.AEGIS_WEB_BASE_PATH, production)
  const staticDir = staticDirectory(env.AEGIS_WEB_STATIC_DIR, production)
  const port = configuredPositiveInteger('PORT', env.PORT, 8003, production)
  const trustedProxy = webTrustedProxy(env.AEGIS_WEB_TRUSTED_PROXY)
  const bindHost = trustedProxy === null
    ? loopbackHost(env.AEGIS_BIND_HOST)
    : proxiedBindHost(env.AEGIS_BIND_HOST, trustedProxy)
  const dispatch = dispatchConfig(env, { production, webPort: port })
  if (dispatch.enabled && trustedProxy !== null && !sameAddress(trustedProxy, dispatch.trustedProxy)) {
    throw new Error('AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY must equal AEGIS_WEB_TRUSTED_PROXY (one pinned proxy)')
  }

  return Object.freeze({
    nodeEnv,
    production,
    port,
    sessionSecret: sessionSecret || DEVELOPMENT_SESSION_SECRET,
    sessionIdleMs: configuredPositiveInteger(
      'AEGIS_SESSION_IDLE_MS',
      env.AEGIS_SESSION_IDLE_MS,
      30 * 60 * 1_000,
      production,
    ),
    auditDbPath: auditDatabasePath(env.AEGIS_IDEA3_AUDIT_DB_PATH, nodeEnv),
    webBasePath: basePath,
    staticDir,
    bindHost,
    webTrustedProxy: trustedProxy,
    dispatch,
    demoAllowed: !production && env.AEGIS_DEMO_ALLOWED !== 'false',
    maxEvidenceAgeMs: configuredPositiveInteger(
      'AEGIS_MAX_EVIDENCE_AGE_MS',
      env.AEGIS_MAX_EVIDENCE_AGE_MS,
      120_000,
      production,
    ),
    adapterTimeoutMs: configuredPositiveInteger(
      'AEGIS_ADAPTER_TIMEOUT_MS',
      env.AEGIS_ADAPTER_TIMEOUT_MS,
      2_500,
      production,
    ),
    auth: Object.freeze({
      username,
      passwordHash,
      developmentPassword,
      allowDevelopmentLogin,
    }),
    adapters: Object.freeze({
      idea1Url: env.AEGIS_IDEA1_STATUS_URL || null,
      idea2Url: env.AEGIS_IDEA2_STATUS_URL || null,
      runtimeUrl: env.AEGIS_IDEA3_RUNTIME_STATUS_URL || null,
      idea1Token: integrationCredential(env.AEGIS_IDEA1_INTEGRATION_TOKEN),
      idea2Token: integrationCredential(env.AEGIS_IDEA2_INTEGRATION_TOKEN),
    }),
  })
}
