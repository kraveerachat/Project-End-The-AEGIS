import proxyaddr from 'proxy-addr'

const REQUIRED_NAME = 'TRUSTED_PROXY_CIDRS'
const APPROVED_PRODUCTION_PROXY_CIDRS = new Set([
  '172.19.255.2/32',
])
const FORBIDDEN_SHARED_RANGES = new Set([
  '172.18.0.0/16',
  '172.18.0.1/32',
])

/**
 * Compile the explicitly configured proxy boundary used by Express.
 *
 * Development and tests are direct-by-default. Production refuses to start
 * without an explicit CIDR because silently falling back would make secure
 * cookies and request-source attribution deployment-dependent.
 */
export function trustedProxyFromEnv(env = process.env) {
  const raw = String(env.TRUSTED_PROXY_CIDRS ?? '').trim()
  if (!raw) {
    if (env.NODE_ENV === 'production') {
      throw new Error(`${REQUIRED_NAME} is required in production`)
    }
    return false
  }

  const cidrs = raw.split(',').map((value) => value.trim())
  if (cidrs.some((value) => !value || !/^.+\/\d+$/.test(value))) {
    throw new Error(`${REQUIRED_NAME} must contain comma-separated CIDRs`)
  }
  if (cidrs.some((value) => FORBIDDEN_SHARED_RANGES.has(value))) {
    throw new Error(`${REQUIRED_NAME} must not trust the shared aegis_internal bridge`)
  }
  if (
    env.NODE_ENV === 'production'
    && (cidrs.length !== 1 || !APPROVED_PRODUCTION_PROXY_CIDRS.has(cidrs[0]))
  ) {
    throw new Error(`${REQUIRED_NAME} must contain only the approved HUB proxy identity`)
  }

  try {
    return proxyaddr.compile(cidrs)
  } catch {
    throw new Error(`${REQUIRED_NAME} contains an invalid CIDR`)
  }
}
