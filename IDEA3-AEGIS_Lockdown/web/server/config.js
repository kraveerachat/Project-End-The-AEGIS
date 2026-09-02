const MINIMUM_SESSION_SECRET_LENGTH = 32

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

  if (production && sessionSecret.length < MINIMUM_SESSION_SECRET_LENGTH) {
    throw new Error('SESSION_SECRET must contain at least 32 characters in production')
  }

  if (production && !passwordHash) {
    throw new Error('AEGIS_IDEA3_ADMIN_PASSWORD_HASH is required in production')
  }

  if (allowDevelopmentLogin && !developmentPassword) {
    throw new Error('AEGIS_IDEA3_DEV_PASSWORD is required when development login is enabled')
  }

  return Object.freeze({
    nodeEnv,
    production,
    port: positiveInteger(env.PORT, 8003),
    sessionSecret: sessionSecret || 'development-only-session-secret-change-me',
    sessionIdleMs: positiveInteger(env.AEGIS_SESSION_IDLE_MS, 30 * 60 * 1_000),
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
    }),
  })
}
