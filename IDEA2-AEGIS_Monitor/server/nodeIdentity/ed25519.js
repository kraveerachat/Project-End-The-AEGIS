import { createPublicKey, verify } from 'node:crypto'

import { parseCanonicalBase64Url } from './agentProtocol.js'

export function verifyEd25519Signature({ publicKeyPem, message, signature }) {
  try {
    const key = createPublicKey(publicKeyPem)
    if (key.asymmetricKeyType !== 'ed25519') return false
    const canonicalSignature = parseCanonicalBase64Url(signature, 64, 'signature')
    return verify(null, Buffer.from(message), key, Buffer.from(canonicalSignature, 'base64url'))
  } catch {
    return false
  }
}
