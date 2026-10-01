import { createHash } from 'node:crypto'

import {
  getDetectionNode,
  getPhysicalCamera,
  getPhysicalCameraForNode,
} from '../db/connection.js'
import { detectionEngineKeyStatus } from './requireDetectionEngineKey.js'
import { agentSessionStore } from '../routes/agentAuth.js'
import { verifyEd25519Signature } from '../nodeIdentity/ed25519.js'
import {
  canonicalRequestPayload,
  parseCanonicalBase64Url,
  parseCanonicalToken,
  parseStrictJsonBytes,
  parseUint,
  REQUEST_PROOFS,
} from '../nodeIdentity/agentProtocol.js'

const PROOF_HEADERS = Object.freeze({
  sessionId: 'x-aegis-agent-session',
  requestNonce: 'x-aegis-request-nonce',
  timestampMs: 'x-aegis-request-timestamp',
  sequence: 'x-aegis-request-sequence',
  signature: 'x-aegis-request-signature',
})
const WRITE_PROOFS = new Map(Object.values(REQUEST_PROOFS).map((proof) => [proof.path, proof]))

function sendProofFailure(res) {
  return res.status(401).json({ error: 'REQUEST_PROOF_FAILED' })
}

function singleHeader(req, name) {
  let count = 0
  let value = null
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (String(req.rawHeaders[index]).toLowerCase() === name) {
      count += 1
      value = req.rawHeaders[index + 1]
    }
  }
  return count === 1 && typeof value === 'string' && value.length > 0 ? value : null
}

function proofHeaderPresence(req) {
  const names = new Set()
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    names.add(String(req.rawHeaders[index]).toLowerCase())
  }
  return Object.values(PROOF_HEADERS).map((name) => names.has(name))
}

function liveRegistrationMatches(node, physical, session) {
  return Boolean(
    node?.active
    && (node.ingestAuthMode === 'legacy_shared_key' || node.ingestAuthMode === 'ed25519_required')
    && node.nodeId === session.nodeId
    && node.keyVersion === session.keyVersion
    && physical?.active
    && physical.nodeId === node.nodeId
    && Number(physical.physicalCameraId) === Number(session.physicalCameraId)
  )
}

async function legacyClaimRequiresProof(body, { loadNode, loadPhysical }) {
  const claimedNodeId = typeof body?.nodeId === 'string' ? body.nodeId : null
  if (claimedNodeId) {
    const node = await loadNode(claimedNodeId)
    if (node?.ingestAuthMode === 'ed25519_required') return true
  }
  const claimedPhysical = Number(body?.physicalCameraId)
  if (Number.isSafeInteger(claimedPhysical) && claimedPhysical > 0) {
    const physical = await loadPhysical(claimedPhysical)
    if (physical?.nodeId) {
      const node = await loadNode(physical.nodeId)
      if (node?.ingestAuthMode === 'ed25519_required') return true
    }
  }
  return false
}

export function createAuthenticateDetectionIngest({
  now = Date.now,
  legacyKey = process.env.DETECTION_ENGINE_API_KEY,
  sessionStore = agentSessionStore,
  getDetectionNode: loadNode = getDetectionNode,
  getPhysicalCameraForNode: loadPhysicalForNode = getPhysicalCameraForNode,
  getPhysicalCamera: loadPhysical = getPhysicalCamera,
} = {}) {
  return async function authenticateDetectionIngest(req, res, next) {
    const presence = proofHeaderPresence(req)
    const hasAnyProof = presence.some(Boolean)
    if (!hasAnyProof) {
      const legacyStatus = detectionEngineKeyStatus(req, legacyKey)
      if (legacyStatus === 'disabled') return res.status(503).json({ error: 'Detection ingest disabled' })
      if (legacyStatus !== 'accepted') return res.status(401).json({ error: 'Unauthorized' })
      try {
        if (await legacyClaimRequiresProof(req.body, { loadNode, loadPhysical })) {
          return res.status(401).json({ error: 'Unauthorized' })
        }
      } catch {
        return res.status(503).json({ error: 'Identity service unavailable' })
      }
      req.ingestAuth = { kind: 'legacy_unverified', verifiedNode: null }
      return next()
    }
    if (!presence.every(Boolean)) return sendProofFailure(res)

    const path = `${req.baseUrl}${req.path}`
    const proof = WRITE_PROOFS.get(path)
    if (!proof || req.method !== proof.method || req.originalUrl.includes('?')) return sendProofFailure(res)

    let fields
    let parsedBody
    try {
      fields = Object.fromEntries(
        Object.entries(PROOF_HEADERS).map(([field, header]) => [field, singleHeader(req, header)]),
      )
      if (Object.values(fields).some((value) => value === null)) throw new TypeError('invalid proof headers')
      parseCanonicalToken(fields.sessionId, 32, 'session id')
      parseCanonicalToken(fields.requestNonce, 16, 'request nonce')
      parseCanonicalBase64Url(fields.signature, 64, 'signature')
      fields.timestampMs = parseUint(fields.timestampMs, { label: 'timestamp' })
      fields.sequence = parseUint(fields.sequence, { label: 'sequence', positive: true })
      parsedBody = parseStrictJsonBytes(req.rawBody ?? Buffer.alloc(0))
    } catch {
      return sendProofFailure(res)
    }

    const currentTime = BigInt(now())
    if (fields.timestampMs < currentTime - 30_000n || fields.timestampMs > currentTime + 10_000n) {
      return sendProofFailure(res)
    }
    const session = sessionStore.lookup(fields.sessionId)
    if (!session) return sendProofFailure(res)

    try {
      const [node, physical] = await Promise.all([
        loadNode(session.nodeId),
        loadPhysicalForNode(session.nodeId),
      ])
      if (!liveRegistrationMatches(node, physical, session)) return sendProofFailure(res)
      const bodySha256 = createHash('sha256').update(req.rawBody ?? Buffer.alloc(0)).digest('hex')
      const message = canonicalRequestPayload({
        domain: proof.domain,
        sessionId: fields.sessionId,
        requestNonce: fields.requestNonce,
        timestampMs: fields.timestampMs,
        sequence: fields.sequence,
        method: req.method,
        path,
        bodySha256,
      })
      if (!verifyEd25519Signature({ publicKeyPem: node.publicKey, message, signature: fields.signature })) {
        return sendProofFailure(res)
      }
      const nonceDigest = createHash('sha256').update(fields.requestNonce, 'ascii').digest('hex')
      if (!session.replay.acceptRequest({
        sequence: fields.sequence,
        nonceDigest,
        retainUntilMs: Number(fields.timestampMs) + 30_000,
        nowMs: Number(currentTime),
      })) return sendProofFailure(res)

      req.body = parsedBody
      req.verifiedNode = {
        nodeId: node.nodeId,
        keyVersion: node.keyVersion,
        physicalCameraId: Number(physical.physicalCameraId),
        agentSessionId: fields.sessionId,
      }
      req.ingestAuth = { kind: 'ed25519', verifiedNode: req.verifiedNode }
      return next()
    } catch {
      return res.status(503).json({ error: 'Identity service unavailable' })
    }
  }
}

export const authenticateDetectionIngest = createAuthenticateDetectionIngest()
