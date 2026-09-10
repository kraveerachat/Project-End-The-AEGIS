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

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development'
  const production = nodeEnv === 'production'
  const sessionSecret = env.SESSION_SECRET || ''
  const username = env.AEGIS_IDEA3_ADMIN_USER || 'admin'
  const passwordHash = env.AEGIS_IDEA3_ADMIN_PASSWORD_HASH || null
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

  return Object.freeze({
    nodeEnv,
    production,
    port: configuredPositiveInteger('PORT', env.PORT, 8003, production),
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
    bindHost: loopbackHost(env.AEGIS_BIND_HOST),
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
