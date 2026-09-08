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

  return Object.freeze({
    nodeEnv,
    production,
    port: positiveInteger(env.PORT, 8003),
    sessionSecret: sessionSecret || DEVELOPMENT_SESSION_SECRET,
    sessionIdleMs: positiveInteger(env.AEGIS_SESSION_IDLE_MS, 30 * 60 * 1_000),
    auditDbPath: env.AEGIS_IDEA3_AUDIT_DB_PATH || (nodeEnv === 'test'
      ? ':memory:'
      : '.aegis-runtime/security-center-audit.sqlite3'),
    demoAllowed: !production && env.AEGIS_DEMO_ALLOWED !== 'false',
    maxEvidenceAgeMs: positiveInteger(env.AEGIS_MAX_EVIDENCE_AGE_MS, 120_000),
    adapterTimeoutMs: positiveInteger(env.AEGIS_ADAPTER_TIMEOUT_MS, 2_500),
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
