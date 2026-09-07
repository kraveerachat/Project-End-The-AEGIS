import proxyaddr from 'proxy-addr'

import { parsePublicShareGatewayCidr } from './publicShare.js'

const REQUIRED_NAME = 'TRUSTED_PROXY_CIDRS'
const GATEWAY_NAME = 'PUBLIC_SHARE_GATEWAY_CIDR'
/** The one approved HUB reverse-proxy identity. Unchanged by PUBLIC-SHARE-2. */
const APPROVED_HUB_PROXY_CIDR = '172.19.255.2/32'
const APPROVED_PRODUCTION_PROXY_CIDRS = new Set([
  APPROVED_HUB_PROXY_CIDR,
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
 *
 * PUBLIC-SHARE-2 (owner gate G2, approved) adds a SECOND legal production
 * state rather than relaxing the rule. Production accepts exactly these, and
 * nothing else:
 *
 *   Legacy / private mode          PUBLIC_SHARE_GATEWAY_CIDR absent
 *                                  trusted set = { HUB /32 }
 *
 *   Public-gateway-enabled mode    PUBLIC_SHARE_GATEWAY_CIDR = one approved /32
 *                                  trusted set = { HUB /32, that gateway /32 }
 *
 * Legacy mode remains the default, so the configuration currently running in
 * production still boots unchanged after this PR. The gateway identity is
 * optional until the rollout phase that actually deploys a gateway, and a
 * rollback to legacy mode needs no code change.
 *
 * ⚠️ The gateway peer must ALSO be trusted, not merely named. If it were named
 *    but untrusted, Express would stop at the gateway when walking
 *    X-Forwarded-For and req.ip would become the gateway's own address — which
 *    is exactly the attribution collapse that produces the T-05 self-DoS. A
 *    configuration that names a gateway without trusting it is refused rather
 *    than started in a half-working state.
 */
export function trustedProxyFromEnv(env = process.env) {
  // Throws on a malformed value, so a bad gateway identity fails the boot here
  // rather than silently disabling the second state.
  const gatewayCidr = parsePublicShareGatewayCidr(env[GATEWAY_NAME])

  const raw = String(env.TRUSTED_PROXY_CIDRS ?? '').trim()
  if (!raw) {
    if (env.NODE_ENV === 'production') {
      throw new Error(`${REQUIRED_NAME} is required in production`)
    }
    if (gatewayCidr) {
      throw new Error(`${REQUIRED_NAME} must trust ${GATEWAY_NAME} when a public gateway is configured`)
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
  // A repeated identity makes "exactly two" ambiguous and would hide a typo.
  if (new Set(cidrs).size !== cidrs.length) {
    throw new Error(`${REQUIRED_NAME} must not repeat a proxy identity`)
  }

  if (env.NODE_ENV === 'production') {
    if (gatewayCidr) {
      // State B. Order must not matter — this is a set of identities, not a
      // forwarding chain, so a deployment that lists them either way is the
      // same deployment.
      if (gatewayCidr === APPROVED_HUB_PROXY_CIDR) {
        throw new Error(`${GATEWAY_NAME} must not reuse the HUB proxy identity`)
      }
      const expected = new Set([APPROVED_HUB_PROXY_CIDR, gatewayCidr])
      const actual = new Set(cidrs)
      if (actual.size !== expected.size || [...expected].some((value) => !actual.has(value))) {
        throw new Error(
          `${REQUIRED_NAME} must contain exactly the approved HUB proxy identity and ${GATEWAY_NAME}`,
        )
      }
    } else if (cidrs.length !== 1 || !APPROVED_PRODUCTION_PROXY_CIDRS.has(cidrs[0])) {
      // State A, unchanged from before PUBLIC-SHARE-2.
      throw new Error(`${REQUIRED_NAME} must contain only the approved HUB proxy identity`)
    }
  } else if (gatewayCidr && !cidrs.includes(gatewayCidr)) {
    // Outside production there is no pinned HUB identity to enumerate against,
    // but the same consistency rule holds: a named gateway must be trusted.
    throw new Error(`${REQUIRED_NAME} must trust ${GATEWAY_NAME} when a public gateway is configured`)
  }

  try {
    return proxyaddr.compile(cidrs)
  } catch {
    throw new Error(`${REQUIRED_NAME} contains an invalid CIDR`)
  }
}
