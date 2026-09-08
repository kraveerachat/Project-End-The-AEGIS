// server/config/publicShare.js — AEGIS Drive (IDEA1) · Public Share backend contract
//
// PUBLIC-SHARE-2 implements the backend half of the contract in
// Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md.
// Nothing here exposes anything: there is no gateway, no ingress, and no UI
// option. This module only decides, once at boot, whether this deployment is
// ALLOWED to mint `scope=public` shares and which single peer counts as the
// public ingress.
//
// Two variables, both optional, both non-secret:
//
//   PUBLIC_SHARE_BASE_URL      the public origin a public share URL is built
//                              from. Absent ⇒ public shares cannot be created.
//   PUBLIC_SHARE_GATEWAY_CIDR  the ONE pinned peer that counts as the Public
//                              Share Gateway. Absent ⇒ legacy/private mode, and
//                              no request can ever be classified as arriving
//                              through a public gateway.
//   PUBLIC_SHARE_UI_ENABLED    may the Shares screen OFFER `public` as a
//                              selectable scope? Absent ⇒ false. This is a
//                              deployment activation signal for UI truthfulness
//                              only — it is NOT authorization, and turning it on
//                              does not widen what POST /api/shares accepts.
//
// ⚠️ Parsed and validated ONCE, then frozen onto the app. A route must never
//    read process.env per request: tests inject `env` through createApp({ env }),
//    and a per-request global read would make behaviour depend on whatever the
//    surrounding process last set.
//
// ⚠️ Malformed input throws at boot rather than being coerced. Silently
//    "fixing" a public origin is how a deployment ends up publishing links to a
//    host nobody chose. Same policy as TRUSTED_PROXY_CIDRS and
//    MAX_SUPPORTED_LOGICAL_FILE_BYTES: refuse to start.

const BASE_URL_NAME = 'PUBLIC_SHARE_BASE_URL'
const GATEWAY_NAME = 'PUBLIC_SHARE_GATEWAY_CIDR'
const UI_ENABLED_NAME = 'PUBLIC_SHARE_UI_ENABLED'

/**
 * Networks the gateway identity may never sit INSIDE. Kept in step with
 * config/trustedProxy.js: the shared `aegis_internal` bridge carries PostgreSQL
 * and Monitor, so a gateway identity on it would let any container there be
 * mistaken for the public ingress.
 *
 * ⚠️ Containment, not string equality (PR #99 review). The gateway value is
 *    constrained to a single /32, so an exact-match list only ever rejects the
 *    one address someone happened to write down: `172.18.0.1/32` was refused
 *    while `172.18.0.2/32`, `172.18.10.20/32` and `172.18.255.254/32` sailed
 *    through, all of them still on the shared bridge. The rule is about the
 *    network, so the check has to be about the network.
 */
const FORBIDDEN_GATEWAY_NETWORKS = Object.freeze([
  { cidr: '172.18.0.0/16', label: 'the shared aegis_internal bridge' },
])

/** Dotted-quad → 32-bit integer, or null when it is not a valid IPv4 address. */
function ipv4ToInt(address) {
  const parts = String(address).split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

/** Is this IPv4 host address inside `<network>/<prefix>`? */
function ipv4InNetwork(address, cidr) {
  const [network, prefixText] = String(cidr).split('/')
  const prefix = Number(prefixText)
  const host = ipv4ToInt(address)
  const base = ipv4ToInt(network)
  if (host === null || base === null) return false
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false
  if (prefix === 0) return true
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0
  return ((host & mask) >>> 0) === ((base & mask) >>> 0)
}

/**
 * The forbidden network this host belongs to, or null.
 *
 * Exported so the trusted-proxy boundary and the tests can reason about the one
 * authoritative rule rather than restating it.
 */
export function forbiddenGatewayNetworkFor(address) {
  return FORBIDDEN_GATEWAY_NETWORKS.find(({ cidr }) => ipv4InNetwork(address, cidr)) ?? null
}

/** Strict IPv4 host CIDR. Only /32 — a prefix is a range, and a range is not an identity. */
const HOST_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/32$/

/** '::ffff:172.19.254.2' → '172.19.254.2'; anything else is returned unchanged. */
export function normalizeIpv4Mapped(value) {
  const text = String(value ?? '')
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(text)
  return mapped ? mapped[1] : text
}

/**
 * Validate and normalise the public origin.
 *
 * Returns the origin with no trailing slash, e.g. `https://share.example.invalid`.
 * The architecture contract forbids deriving this from a request Host header, so
 * the only input is configuration.
 *
 * ⚠️ A trailing slash is REJECTED, not silently trimmed (PR #99 review). The
 *    merged G1 contract states the configured origin carries no trailing slash;
 *    accepting one and normalising it would have quietly widened an already
 *    accepted contract, and this task has no authority to reopen G1. Rejecting
 *    it also keeps the configured string and the emitted URL literally the same
 *    text, so an operator reading `.env` sees exactly what recipients receive.
 */
export function parsePublicShareBaseUrl(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return null

  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${BASE_URL_NAME} must be an absolute https:// URL`)
  }

  // Checked on the RAW text: `new URL()` normalises both `https://host` and
  // `https://host/` to pathname '/', so the distinction only survives here.
  if (value.endsWith('/')) {
    throw new Error(`${BASE_URL_NAME} must not end with a trailing slash`)
  }

  // https only: the token is in the path, so a public share URL that could be
  // served over plaintext would put the credential on the wire in the clear.
  if (url.protocol !== 'https:') throw new Error(`${BASE_URL_NAME} must use https://`)
  if (!url.hostname) throw new Error(`${BASE_URL_NAME} must contain a host`)
  // Credentials in a published URL would be handed to every recipient.
  if (url.username || url.password) throw new Error(`${BASE_URL_NAME} must not contain credentials`)
  if (url.search) throw new Error(`${BASE_URL_NAME} must not contain a query string`)
  if (url.hash) throw new Error(`${BASE_URL_NAME} must not contain a fragment`)
  // A non-root path would silently produce `https://host/base/s/<token>`, which
  // is not the route the gateway contract allowlists (`/s/:token`).
  if (url.pathname !== '/') throw new Error(`${BASE_URL_NAME} must not contain a path`)

  // url.host keeps a non-default port and drops :443, which is exactly the
  // normalisation the contract asks for. No trailing slash.
  return `${url.protocol}//${url.host}`
}

/**
 * Validate and normalise the pinned Public Share Gateway peer.
 *
 * Exactly one IPv4 host CIDR. Not a range, not the shared bridge, not a list.
 */
export function parsePublicShareGatewayCidr(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return null

  if (value.includes(',')) {
    throw new Error(`${GATEWAY_NAME} must name exactly one gateway identity`)
  }
  const match = HOST_CIDR.exec(value)
  // Rejecting /31 and shorter here is the whole point: ingress provenance is an
  // identity check, and a prefix would let a neighbouring address impersonate
  // the gateway.
  if (!match) throw new Error(`${GATEWAY_NAME} must be a single IPv4 host CIDR ending in /32`)
  for (const octet of match.slice(1)) {
    if (Number(octet) > 255) throw new Error(`${GATEWAY_NAME} contains an invalid IPv4 address`)
  }
  // Containment, not equality: every host inside a forbidden network is refused,
  // not just the one address someone thought to list.
  const forbidden = forbiddenGatewayNetworkFor(match[0].slice(0, -'/32'.length))
  if (forbidden) {
    throw new Error(
      `${GATEWAY_NAME} must not be inside ${forbidden.label} (${forbidden.cidr})`,
    )
  }
  return value
}

/**
 * Parse the UI activation flag.
 *
 * Strictly `true` or `false`. Absent or empty is false, because the safe state
 * for "may the interface offer Internet sharing?" is no.
 *
 * ⚠️ Anything else FAILS THE BOOT rather than being coerced. `truthy`
 *    coercion is how `PUBLIC_SHARE_UI_ENABLED=flase` or `=0` silently becomes
 *    "on" or stays "off" against the operator's intent; the same refuse-to-start
 *    policy as PUBLIC_SHARE_BASE_URL and TRUSTED_PROXY_CIDRS applies.
 *
 * ⚠️ This flag is UI truthfulness only. It is not an authorization control,
 *    and it is not by itself evidence that owner gate G6 / PUBLIC-SHARE-7
 *    acceptance passed. It may only be turned on after that acceptance.
 */
export function parsePublicShareUiEnabled(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return false
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${UI_ENABLED_NAME} must be exactly "true" or "false"`)
}

/** The single host address a `/32` names, for peer comparison. */
export const gatewayAddressOf = (cidr) => (cidr ? cidr.slice(0, -'/32'.length) : null)

/**
 * Build the immutable public-share configuration for one app instance.
 *
 * @param {object} [env]
 * @returns {{ baseUrl: string|null, gatewayCidr: string|null, gatewayAddress: string|null,
 *             publicShareEnabled: boolean, publicIngressConfigured: boolean,
 *             publicShareUiEnabled: boolean, publicSelectable: boolean }}
 */
export function publicShareConfigFromEnv(env = process.env) {
  const baseUrl = parsePublicShareBaseUrl(env[BASE_URL_NAME])
  const gatewayCidr = parsePublicShareGatewayCidr(env[GATEWAY_NAME])
  const uiEnabled = parsePublicShareUiEnabled(env[UI_ENABLED_NAME])

  return Object.freeze({
    baseUrl,
    gatewayCidr,
    gatewayAddress: gatewayAddressOf(gatewayCidr),
    /**
     * May this deployment mint `scope=public` shares?
     *
     * Deliberately depends on the base URL ALONE, not on the gateway. A share
     * can be created before the gateway exists — it simply is not redeemable
     * from the Internet yet, which is honest and inert. The reverse (a gateway
     * with no way to express a public URL) would be useless.
     */
    publicShareEnabled: baseUrl !== null,
    /** Is there a peer that could be classified as the public ingress at all? */
    publicIngressConfigured: gatewayCidr !== null,
    /** Raw deployment activation signal for the interface. Default OFF. */
    publicShareUiEnabled: uiEnabled,
    /**
     * May the Shares screen offer `public` as a selectable scope?
     *
     * All three must hold, and the default for each is off:
     *   - a public origin exists, so a public URL can even be expressed;
     *   - a public ingress peer is pinned, so the link could be redeemed;
     *   - the deployment has explicitly activated the interface.
     *
     * ⚠️ This is the ONLY public-share fact the client is told. It is a
     *    coarse boolean on purpose: the base URL, gateway identity, Docker
     *    subnet, real public hostname and the G4 ingress choice all stay
     *    server-side. And it changes nothing about authorization — POST
     *    /api/shares still decides for itself, from publicShareEnabled alone,
     *    whether a `scope=public` share may be minted.
     */
    publicSelectable: baseUrl !== null && gatewayCidr !== null && uiEnabled,
  })
}

/**
 * Compose the absolute public URL for one created share.
 *
 * The path half is server-created (`/s/<token>`); the origin half is
 * configuration. A request header contributes nothing, which is what makes Host
 * poisoning impossible rather than merely unlikely.
 */
export function publicShareUrl(baseUrl, path) {
  if (!baseUrl) return null
  return `${baseUrl}${path}`
}
