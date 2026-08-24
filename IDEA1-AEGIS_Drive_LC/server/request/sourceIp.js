/**
 * The sole application-level request-source accessor.
 *
 * Express derives req.ip from the socket peer plus the configured trusted
 * proxy function. Routes must never parse forwarding headers independently.
 */
export function requestSourceIp(req) {
  return typeof req.ip === 'string' && req.ip ? req.ip : 'unknown'
}
