import {
  getDetectionNode,
  getNodeAccountAlias,
  getNodeAliasPolicy,
  getPhysicalCameraForNode,
  getUserById,
} from '../db/connection.js'
import { streamSourceForPhysicalCamera } from '../db/store.js'
import { clearLocalNode, currentLocalNode, currentUser } from './session.js'
import { ROLES } from '../rbac/permissions.js'

const STREAM_STALE_MS = 45_000

export class CameraAccessError extends Error {
  constructor(status, code) {
    super(code)
    this.name = 'CameraAccessError'
    this.status = status
    this.code = code
  }
}

const accessError = (status, code) => new CameraAccessError(status, code)

export function parseLocalNodeAssociationRequirement(value = process.env.AEGIS_REQUIRE_LOCAL_NODE_ASSOCIATION) {
  if (value === undefined) return false
  if (value === 'true') return true
  if (value === 'false') return false
  throw new TypeError('AEGIS_REQUIRE_LOCAL_NODE_ASSOCIATION must be true or false')
}

export function createCameraAccessResolver({
  getCurrentUser = currentUser,
  getCurrentLocalNode = currentLocalNode,
  clearVerifiedLocalNode = clearLocalNode,
  getUserById: loadUser = getUserById,
  getDetectionNode: loadNode = getDetectionNode,
  getPhysicalCameraForNode: loadPhysical = getPhysicalCameraForNode,
  getNodeAliasPolicy: loadPolicy = getNodeAliasPolicy,
  getNodeAccountAlias: loadAlias = getNodeAccountAlias,
} = {}) {
  function denyAssociation(req) {
    clearVerifiedLocalNode(req)
    throw accessError(403, 'LOCAL_NODE_ASSOCIATION_DENIED')
  }

  async function loadLiveCameraUser(req) {
    const cachedUser = getCurrentUser(req)
    if (!cachedUser) throw accessError(403, 'LOCAL_NODE_ASSOCIATION_DENIED')
    let user
    try {
      user = await loadUser(cachedUser.id)
    } catch {
      throw accessError(503, 'LOCAL_NODE_REGISTRY_UNAVAILABLE')
    }
    if (
      !user
      || user.active === false
      || user.id !== cachedUser.id
      || user.username !== cachedUser.username
      || !new Set([ROLES.OPERATOR, ROLES.SOC]).has(user.role)
      || user.mustResetPassword
    ) denyAssociation(req)
    return user
  }

  return Object.freeze({
    async resolveLiveCameraActor(req) {
      const user = await loadLiveCameraUser(req)
      return { userId: user.id, username: user.username, role: user.role }
    },

    async resolveOperatorAccess(req, requestedLogicalCameraId, nowMs = Date.now()) {
      const user = await loadLiveCameraUser(req)
      if (user.role !== ROLES.OPERATOR) denyAssociation(req)

      const verifiedNode = getCurrentLocalNode(req, nowMs)
      if (!verifiedNode) throw accessError(403, 'LOCAL_NODE_ASSOCIATION_REQUIRED')

      let node
      let physical
      let policy
      let alias
      try {
        ;[node, physical, policy, alias] = await Promise.all([
          loadNode(verifiedNode.nodeId),
          loadPhysical(verifiedNode.nodeId),
          loadPolicy(verifiedNode.nodeId),
          loadAlias(verifiedNode.nodeId, user.id),
        ])
      } catch {
        throw accessError(503, 'LOCAL_NODE_REGISTRY_UNAVAILABLE')
      }

      if (
        !node?.active
        || node.nodeId !== verifiedNode.nodeId
        || Number(node.keyVersion) !== verifiedNode.keyVersion
        || !physical?.active
        || physical.nodeId !== verifiedNode.nodeId
        || Number(physical.physicalCameraId) !== verifiedNode.physicalCameraId
      ) denyAssociation(req)

      if (
        policy?.nodeId !== verifiedNode.nodeId
        || policy.mode !== 'account'
        || policy.fixedCameraId !== null
        || alias?.nodeId !== verifiedNode.nodeId
        || alias.userId !== user.id
        || typeof alias.logicalCameraId !== 'string'
        || alias.logicalCameraId.length === 0
        || alias.logicalCameraId !== requestedLogicalCameraId
      ) throw accessError(403, 'CAMERA_ALIAS_DENIED')

      return {
        kind: 'verified-node',
        viewerMode: 'demanding',
        userId: user.id,
        nodeId: verifiedNode.nodeId,
        physicalCameraId: verifiedNode.physicalCameraId,
        logicalCameraId: alias.logicalCameraId,
      }
    },
  })
}

const defaultResolver = createCameraAccessResolver()

export function resolveOperatorAccess(req, requestedLogicalCameraId, nowMs = Date.now()) {
  return defaultResolver.resolveOperatorAccess(req, requestedLogicalCameraId, nowMs)
}

export function resolveLiveCameraActor(req) {
  return defaultResolver.resolveLiveCameraActor(req)
}

export async function resolvePhysicalStreamTarget(
  req,
  requestedLogicalCameraId,
  nowMs = Date.now(),
  {
    resolveOperatorAccess: resolveAccess = resolveOperatorAccess,
    streamSourceForPhysicalCamera: loadPhysicalSource = streamSourceForPhysicalCamera,
  } = {},
) {
  const access = await resolveAccess(req, requestedLogicalCameraId, nowMs)
  let source
  try {
    source = await loadPhysicalSource(access.physicalCameraId)
  } catch {
    throw accessError(503, 'PHYSICAL_STREAM_UNAVAILABLE')
  }
  if (
    !source
    || typeof source.url !== 'string'
    || source.url.length === 0
    || !Number.isFinite(Number(source.ageMs))
    || Number(source.ageMs) > STREAM_STALE_MS
  ) throw accessError(503, 'PHYSICAL_STREAM_UNAVAILABLE')
  return { access, source }
}
