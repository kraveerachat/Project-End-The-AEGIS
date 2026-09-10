// server/request/ingress.js — AEGIS Drive (IDEA1) · how a request reached us
//
// The sibling of request/sourceIp.js, and deliberately NOT a replacement for it.
// The two answer different questions and must never be substituted:
//
//   requestSourceIp(req)    WHO sent this?   → req.ip, after Express walks
//                                              X-Forwarded-For across trusted
//                                              peers. Used for `zones` CIDR
//                                              enforcement, the rate-limit IP
//                                              axis, and the audit source.
//
//   requestIngressKind(req) HOW did it get here? → the immediate TCP peer.
//                                              Used ONLY to decide whether a
//                                              request arrived through the
//                                              dedicated Public Share Gateway.
//
// ⚠️ Why this cannot be req.ip (PR #97 review correction, measured not assumed):
//    once the gateway is a trusted proxy and correctly overwrites
//    X-Forwarded-For with the real recipient, Express resolves req.ip TO THE
//    RECIPIENT. With one trusted /32 peer sending
//    `X-Forwarded-For: 203.0.113.50`:
//
//        req.socket.remoteAddress = <the gateway>
//        req.ip                   = 203.0.113.50
//
//    So `req.ip === <gateway identity>` is false on every correct public
//    request. Writing the ingress rule against req.ip would either fail to block
//    non-public shares on the public ingress, or force the gateway to stop
//    forwarding the real client address — which breaks audit and rate-limit
//    attribution and re-creates the T-05 self-DoS.
//
//    The same peer sending NO X-Forwarded-For makes req.ip fall back to the peer
//    address. The socket peer is correct in both cases; req.ip is not.
//
// ⚠️ Ingress provenance is a property of the CONNECTION. It is never read from
//    X-Forwarded-For, Forwarded, X-Real-IP, or Host — a direct caller can set
//    all of those and must never be able to forge public-gateway provenance.
import { normalizeIpv4Mapped } from '../config/publicShare.js'

/** Requests that did not arrive through the configured public gateway. */
export const INGRESS_PRIVATE = 'private'
/** Requests whose immediate peer is the configured Public Share Gateway. */
export const INGRESS_PUBLIC_GATEWAY = 'public-gateway'
/**
 * A gateway is configured but the peer could not be read.
 *
 * Treated as NOT private by every caller, so an unreadable peer can never be
 * used to smuggle a `zones`/`any` share through the public ingress. It is a
 * separate value from `public-gateway` because it is not evidence of the
 * gateway either — it is absence of evidence, resolved in the safe direction.
 */
export const INGRESS_UNKNOWN = 'unknown'

/**
 * The immediate TCP peer address, normalised. `null` when unreadable.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
export function requestIngressPeerIp(req) {
  const peer = req?.socket?.remoteAddress
  if (typeof peer !== 'string' || !peer) return null
  return normalizeIpv4Mapped(peer)
}

/**
 * Classify how this request reached the application.
 *
 * @param {import('express').Request} req
 * @returns {'private'|'public-gateway'|'unknown'}
 */
export function requestIngressKind(req) {
  // The configuration is frozen onto the app at boot by createApp, so this
  // honours an injected test env and cannot drift per request.
  const config = req?.app?.get?.('publicShareConfig')

  // No gateway configured ⇒ there is no public ingress in this deployment, so
  // every request is private and the scope rule below is inert. This is what
  // keeps PUBLIC-SHARE-2 a no-op for the currently deployed configuration.
  if (!config?.gatewayAddress) return INGRESS_PRIVATE

  const peer = requestIngressPeerIp(req)
  if (peer === null) return INGRESS_UNKNOWN
  return peer === config.gatewayAddress ? INGRESS_PUBLIC_GATEWAY : INGRESS_PRIVATE
}

/**
 * Did this request arrive through anything other than the private path?
 *
 * `unknown` answers true, so a scope check written as "private only" fails
 * closed rather than open.
 */
export const isPrivateIngress = (req) => requestIngressKind(req) === INGRESS_PRIVATE
