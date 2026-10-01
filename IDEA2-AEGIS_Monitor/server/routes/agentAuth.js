import express from 'express'

import { getDetectionNode, getPhysicalCameraForNode } from '../db/connection.js'
import { AgentSessionStore } from '../nodeIdentity/agentSessionStore.js'
import { ChallengeStore, IdentityCapacityError } from '../nodeIdentity/challengeStore.js'
import { verifyEd25519Signature } from '../nodeIdentity/ed25519.js'
import {
  canonicalAuthPayload,
  parseCanonicalBase64Url,
  parseCanonicalToken,
  parseStrictJsonBytes,
} from '../nodeIdentity/agentProtocol.js'

const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SUPPORTED_AUTH_MODES = new Set(['legacy_shared_key', 'ed25519_required'])

const defaultChallengeStore = new ChallengeStore()
const defaultSessionStore = new AgentSessionStore()

function send(res, status, error) {
  res.status(status).json({ error })
}

function parseBody(req, expectedFields) {
  const body = parseStrictJsonBytes(req.body ?? Buffer.alloc(0))
  const keys = Object.keys(body).sort()
  const expected = [...expectedFields].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError('request field set is not canonical')
  }
  return body
}

function registrationIsUsable(node, physical) {
  return Boolean(
    node?.active
    && typeof node.publicKey === 'string'
    && node.publicKey.length > 0
    && Number.isInteger(node.keyVersion)
    && node.keyVersion > 0
    && SUPPORTED_AUTH_MODES.has(node.ingestAuthMode)
    && physical?.active
    && physical.nodeId === node.nodeId
    && Number.isSafeInteger(Number(physical.physicalCameraId))
    && Number(physical.physicalCameraId) > 0
  )
}

function authPayloadFromChallenge(challenge) {
  return {
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    issuedAtMs: challenge.issuedAtMs,
    expiresAtMs: challenge.expiresAtMs,
    audience: challenge.audience,
    purpose: challenge.purpose,
    nodeId: challenge.nodeId,
    keyVersion: challenge.keyVersion,
  }
}

export function createAgentAuthRouter({
  audience,
  challengeStore = defaultChallengeStore,
  sessionStore = defaultSessionStore,
  getDetectionNode: loadNode = getDetectionNode,
  getPhysicalCameraForNode: loadPhysicalCamera = getPhysicalCameraForNode,
} = {}) {
  const router = express.Router()
  router.use(express.raw({ type: ['application/json', 'application/*+json'], limit: '16kb' }))

  router.post('/challenge', async (req, res) => {
    let body
    try {
      body = parseBody(req, ['nodeId'])
      if (typeof body.nodeId !== 'string' || !NODE_ID_RE.test(body.nodeId)) throw new TypeError('invalid node id')
    } catch {
      return send(res, 400, 'INVALID_REQUEST')
    }
    if (typeof audience !== 'string' || audience.length === 0) {
      return send(res, 503, 'IDENTITY_SERVICE_UNAVAILABLE')
    }
    try {
      const [node, physical] = await Promise.all([
        loadNode(body.nodeId),
        loadPhysicalCamera(body.nodeId),
      ])
      if (!registrationIsUsable(node, physical)) return send(res, 401, 'AUTHENTICATION_FAILED')
      const challenge = challengeStore.issue({
        nodeId: node.nodeId,
        audience,
        keyVersion: node.keyVersion,
        physicalCameraId: Number(physical.physicalCameraId),
      })
      return res.status(200).json(challenge)
    } catch (error) {
      if (error instanceof IdentityCapacityError) return send(res, 503, 'IDENTITY_SERVICE_UNAVAILABLE')
      return send(res, 503, 'IDENTITY_SERVICE_UNAVAILABLE')
    }
  })

  router.post('/verify', async (req, res) => {
    let body
    try {
      body = parseBody(req, ['challengeId', 'signature'])
      parseCanonicalToken(body.challengeId, 32, 'challenge id')
      parseCanonicalBase64Url(body.signature, 64, 'signature')
    } catch {
      return send(res, 400, 'INVALID_REQUEST')
    }
    const challenge = challengeStore.get(body.challengeId)
    if (!challenge) return send(res, 401, 'AUTHENTICATION_FAILED')
    try {
      const [node, physical] = await Promise.all([
        loadNode(challenge.nodeId),
        loadPhysicalCamera(challenge.nodeId),
      ])
      if (
        !registrationIsUsable(node, physical)
        || node.keyVersion !== challenge.keyVersion
        || Number(physical.physicalCameraId) !== Number(challenge.physicalCameraId)
        || challenge.audience !== audience
        || challenge.purpose !== 'agent-authenticate'
        || !verifyEd25519Signature({
          publicKeyPem: node.publicKey,
          message: canonicalAuthPayload(authPayloadFromChallenge(challenge)),
          signature: body.signature,
        })
      ) {
        return send(res, 401, 'AUTHENTICATION_FAILED')
      }
      if (!challengeStore.consume(body.challengeId, challenge)) {
        return send(res, 401, 'AUTHENTICATION_FAILED')
      }
      const session = sessionStore.create({
        nodeId: node.nodeId,
        keyVersion: node.keyVersion,
        physicalCameraId: Number(physical.physicalCameraId),
      })
      return res.status(200).json(session)
    } catch (error) {
      if (error instanceof IdentityCapacityError) return send(res, 503, 'IDENTITY_SERVICE_UNAVAILABLE')
      return send(res, 503, 'IDENTITY_SERVICE_UNAVAILABLE')
    }
  })

  router.use((error, _req, res, _next) => {
    if (error?.type === 'entity.too.large' || error instanceof SyntaxError) {
      return send(res, 400, 'INVALID_REQUEST')
    }
    return send(res, 503, 'IDENTITY_SERVICE_UNAVAILABLE')
  })
  return router
}

export const agentAuthRouter = createAgentAuthRouter({
  audience: process.env.AGENT_AUTH_AUDIENCE,
})

export { defaultSessionStore as agentSessionStore }
