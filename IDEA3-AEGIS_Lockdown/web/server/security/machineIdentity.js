import net from 'node:net'

/**
 * PR10 S2 machine identity (IDEA3 side of D5 and K9, spec §4.5).
 *
 * The HUB's machine SNI block verifies the Core's mTLS client certificate and
 * overwrites these headers. IDEA3 trusts them only from the pinned HUB peer.
 * Forwarded headers are never consulted.
 */
export const MACHINE_VERIFY_HEADER = 'x-aegis-client-verify'
export const MACHINE_DN_HEADER = 'x-aegis-client-dn'

function peerMatcher(trustedProxy) {
  const allowed = new net.BlockList()
  allowed.addAddress(trustedProxy, net.isIP(trustedProxy) === 6 ? 'ipv6' : 'ipv4')
  return (address) => {
    if (typeof address !== 'string') return false
    const peer = address.startsWith('::ffff:') && net.isIP(address.slice(7)) === 4 ? address.slice(7) : address
    const family = net.isIP(peer)
    return family !== 0 && allowed.check(peer, family === 6 ? 'ipv6' : 'ipv4')
  }
}

/**
 * Return the single CN of an RFC 2253 subject, or null. Escaped values,
 * multi-valued RDNs, quoted values, and a missing or repeated CN are refused
 * rather than interpreted.
 */
export function subjectCommonName(dn) {
  if (typeof dn !== 'string' || dn.length === 0 || dn.length > 512 || /[\\+"]/.test(dn)) return null
  const names = []
  for (const part of dn.split(',')) {
    const separator = part.indexOf('=')
    if (separator <= 0) return null
    if (part.slice(0, separator).trim().toUpperCase() === 'CN') names.push(part.slice(separator + 1).trim())
  }
  return names.length === 1 ? names[0] : null
}

export function createMachineContactTracker({ clock = () => new Date() } = {}) {
  let lastContact = null
  return {
    record() {
      lastContact = clock()
    },
    lastContactAt() {
      return lastContact
    },
  }
}

/**
 * Accept a request only when all hold: no browser cookie or Origin, the socket
 * peer is the pinned HUB address, the verify header is exactly SUCCESS, and the
 * subject has exactly one CN equal to the expected subject. A rejection writes
 * no durable state.
 */
export function createMachineIdentityGuard({ trustedProxy, expectedSubject, contact }) {
  const isTrustedPeer = peerMatcher(trustedProxy)
  return function requireMachineIdentity(req, res, next) {
    if (
      req.headers.cookie !== undefined
      || req.headers.origin !== undefined
      || !isTrustedPeer(req.socket.remoteAddress)
      || req.get(MACHINE_VERIFY_HEADER) !== 'SUCCESS'
      || subjectCommonName(req.get(MACHINE_DN_HEADER)) !== expectedSubject
    ) {
      return res.status(403).json({ error: { code: 'MACHINE_IDENTITY_INVALID' } })
    }
    req.machineSubject = expectedSubject
    contact.record()
    return next()
  }
}
