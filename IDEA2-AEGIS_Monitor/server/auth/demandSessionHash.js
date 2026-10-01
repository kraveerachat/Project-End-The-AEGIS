import { createHmac } from 'node:crypto'
import { parseCanonicalBase64Url } from '../nodeIdentity/agentProtocol.js'

export function hashProducerSessionBinding(binding, secret) {
  if (typeof secret !== 'string' || secret.length === 0) throw new TypeError('producer session secret is required')
  const canonical = parseCanonicalBase64Url(binding, 32, 'session binding')
  return `v1:${createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update('AEGIS/producer-demand/session/v1:', 'utf8')
    .update(Buffer.from(canonical, 'base64url')).digest('hex')}`
}
