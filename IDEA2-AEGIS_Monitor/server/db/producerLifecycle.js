import { randomBytes as cryptoRandomBytes } from 'node:crypto'
import { withTransaction } from './connection.js'
import { hashProducerSessionBinding } from '../auth/demandSessionHash.js'
import { CameraAccessError } from '../auth/cameraAccess.js'
import { parseCanonicalBase64Url, parseUint } from '../nodeIdentity/agentProtocol.js'

const deny = () => new CameraAccessError(403, 'PRODUCER_AUTHORITY_DENIED')
const unavailable = () => new CameraAccessError(503, 'PRODUCER_AUTHORITY_UNAVAILABLE')
const MAX_BIGINT = 9223372036854775807n

export const PRODUCER_LEASE_MS = 30_000
export const DEMAND_LEASE_MS = 30_000
export const STREAM_REVALIDATE_MS = 10_000
export const RENEW_BEFORE_MS = 20_000

function identity(value) {
  try {
    if (!value || typeof value.nodeId !== 'string' || !value.nodeId
      || typeof value.logicalCameraId !== 'string' || !value.logicalCameraId) throw deny()
    return {
      userId: parseUint(value.userId, { positive: true, max: MAX_BIGINT }).toString(),
      nodeId: value.nodeId,
      physicalCameraId: parseUint(value.physicalCameraId, { positive: true, max: MAX_BIGINT }).toString(),
      logicalCameraId: value.logicalCameraId,
      keyVersion: parseUint(value.keyVersion, { positive: true, max: 2147483647n }).toString(),
    }
  } catch { throw deny() }
}

function exactHandle(handle) {
  try {
    const access = identity(handle)
    if (typeof handle.producerGeneration !== 'string' || !/^v1:[0-9a-f]{64}$/.test(handle.sessionBindingHash)) throw deny()
    return {
      ...access,
      producerGeneration: parseUint(handle.producerGeneration, { positive: true, max: MAX_BIGINT }).toString(),
      demandOwnerId: parseCanonicalBase64Url(handle.demandOwnerId, 32),
      sessionBindingHash: handle.sessionBindingHash,
    }
  } catch { throw deny() }
}

async function lockAuthority(client, access) {
  // This order is shared by acquire/renew. SHARE conflicts with non-key UPDATE
  // and DELETE; KEY SHARE would not protect activity, key version or aliases.
  const user = (await client.query('SELECT id, active, role, must_reset_password FROM users WHERE id = $1 FOR SHARE', [access.userId])).rows[0]
  const node = (await client.query('SELECT node_id, active, key_version FROM detection_nodes WHERE node_id = $1 FOR SHARE', [access.nodeId])).rows[0]
  const physical = (await client.query('SELECT physical_camera_id, node_id, active FROM physical_cameras WHERE physical_camera_id = $1 FOR UPDATE', [access.physicalCameraId])).rows[0]
  const policy = (await client.query('SELECT mode, fixed_camera_id FROM node_camera_alias_policy WHERE node_id = $1 FOR SHARE', [access.nodeId])).rows[0]
  const alias = policy?.mode === 'account'
    ? (await client.query('SELECT logical_camera_id FROM node_account_camera_alias WHERE node_id = $1 AND user_id = $2 FOR SHARE', [access.nodeId, access.userId])).rows[0]
    : null
  const assignment = (await client.query('SELECT user_id FROM camera_assignment WHERE camera_id = $1 FOR SHARE', [access.logicalCameraId])).rows[0]

  // Rows returned by locking SELECTs are the live, post-wait versions at READ
  // COMMITTED. Validate only after all applicable authority locks are held.
  if (!user?.active || user.role !== 'CCTV-Operator' || user.must_reset_password
    || !node?.active || String(node.key_version) !== access.keyVersion
    || !physical?.active || physical.node_id !== access.nodeId
    || String(assignment?.user_id) !== access.userId
    || !((policy?.mode === 'account' && policy.fixed_camera_id === null && alias?.logical_camera_id === access.logicalCameraId)
      || (policy?.mode === 'fixed' && policy.fixed_camera_id === access.logicalCameraId))) throw deny()
}

async function retire(client, physicalCameraId) {
  await client.query(`UPDATE camera_producer_demands d SET released_at = clock_timestamp()
    FROM camera_producer_epochs e WHERE e.producer_generation = d.producer_generation
      AND e.physical_camera_id = $1 AND d.released_at IS NULL
      AND (d.lease_expires_at <= clock_timestamp() OR e.lease_expires_at <= clock_timestamp() OR e.released_at IS NOT NULL)`, [physicalCameraId])
  await client.query(`UPDATE camera_producer_epochs e SET released_at = clock_timestamp()
    WHERE e.physical_camera_id = $1 AND e.released_at IS NULL
      AND (e.lease_expires_at <= clock_timestamp() OR NOT EXISTS (
        SELECT 1 FROM camera_producer_demands d WHERE d.producer_generation = e.producer_generation
          AND d.released_at IS NULL AND d.lease_expires_at > clock_timestamp()
          AND d.viewer_user_id IS NOT NULL AND d.logical_camera_id IS NOT NULL))`, [physicalCameraId])
}

async function extendEpoch(client, generation, demandOwnerId) {
  const result = await client.query(`UPDATE camera_producer_epochs e SET lease_expires_at = (
    SELECT max(d.lease_expires_at) FROM camera_producer_demands d
    WHERE d.producer_generation = e.producer_generation AND d.released_at IS NULL
      AND d.lease_expires_at > clock_timestamp() AND d.viewer_user_id IS NOT NULL
      AND d.logical_camera_id IS NOT NULL)
    WHERE e.producer_generation = $1 AND e.released_at IS NULL
      AND e.lease_expires_at > clock_timestamp()
      AND EXISTS (SELECT 1 FROM camera_producer_demands current_demand
        WHERE current_demand.producer_generation = e.producer_generation
          AND current_demand.demand_owner_id = $2 AND current_demand.released_at IS NULL
          AND current_demand.lease_expires_at > clock_timestamp()
          AND current_demand.viewer_user_id IS NOT NULL AND current_demand.logical_camera_id IS NOT NULL)`,
  [generation, demandOwnerId])
  // Time still advances while the physical row is locked. A later write must
  // reject expiry independently, rolling back any earlier demand write.
  if (result.rowCount !== 1) throw deny()
}

// Internal-only handles must never be serialized into an HTTP response.
export function createProducerLifecycle({ transact = withTransaction, secret = process.env.SESSION_SECRET, randomBytes = cryptoRandomBytes } = {}) {
  async function transaction(fn) {
    try { return await transact(fn) }
    catch (error) {
      if (error instanceof CameraAccessError) throw error
      // SQL parameters/errors can contain sensitive context; do not expose or log them.
      throw unavailable()
    }
  }

  return Object.freeze({
    async acquire({ access: suppliedAccess, sessionBinding }) {
      const access = identity(suppliedAccess)
      const sessionBindingHash = hashProducerSessionBinding(sessionBinding, secret)
      return transaction(async client => {
        await lockAuthority(client, access)
        await retire(client, access.physicalCameraId)
        let epoch = (await client.query(`SELECT producer_generation::text, node_id FROM camera_producer_epochs
          WHERE physical_camera_id = $1 AND released_at IS NULL AND lease_expires_at > clock_timestamp()
          FOR UPDATE`, [access.physicalCameraId])).rows[0]
        if (epoch && epoch.node_id !== access.nodeId) throw deny()
        const newEpoch = !epoch
        if (!epoch) {
          epoch = (await client.query(`INSERT INTO camera_producer_epochs (physical_camera_id, node_id, lease_expires_at)
            VALUES ($1, $2, clock_timestamp() + $3 * interval '1 millisecond') RETURNING producer_generation::text`,
          [access.physicalCameraId, access.nodeId, PRODUCER_LEASE_MS])).rows[0]
        }
        const demandOwnerId = parseCanonicalBase64Url(randomBytes(32).toString('base64url'), 32, 'demand owner')
        const inserted = await client.query(`INSERT INTO camera_producer_demands
          (producer_generation, demand_owner_id, session_binding_hash, viewer_user_id, logical_camera_id, lease_expires_at)
          SELECT $1, $2, $3, $4, $5, clock_timestamp() + $6 * interval '1 millisecond'
          FROM camera_producer_epochs e WHERE e.producer_generation = $1
            AND e.released_at IS NULL AND e.lease_expires_at > clock_timestamp()
            AND ($7::boolean OR EXISTS (SELECT 1 FROM camera_producer_demands previous_demand
              WHERE previous_demand.producer_generation = e.producer_generation
                AND previous_demand.released_at IS NULL AND previous_demand.lease_expires_at > clock_timestamp()
                AND previous_demand.viewer_user_id IS NOT NULL AND previous_demand.logical_camera_id IS NOT NULL))`,
        [epoch.producer_generation, demandOwnerId, sessionBindingHash, access.userId, access.logicalCameraId, DEMAND_LEASE_MS, newEpoch])
        if (inserted.rowCount !== 1) throw deny()
        await extendEpoch(client, epoch.producer_generation, demandOwnerId)
        return Object.freeze({ ...access, producerGeneration: epoch.producer_generation, demandOwnerId, sessionBindingHash })
      })
    },

    async renew({ handle: suppliedHandle, access: suppliedAccess, sessionBinding }) {
      const handle = exactHandle(suppliedHandle)
      const access = identity(suppliedAccess)
      const hash = hashProducerSessionBinding(sessionBinding, secret)
      if (hash !== handle.sessionBindingHash || Object.keys(access).some(key => access[key] !== handle[key])) throw deny()
      return transaction(async client => {
        await lockAuthority(client, access)
        await retire(client, access.physicalCameraId)
        const result = await client.query(`UPDATE camera_producer_demands d
          SET lease_expires_at = clock_timestamp() + $8 * interval '1 millisecond'
          FROM camera_producer_epochs e WHERE e.producer_generation = d.producer_generation
            AND e.producer_generation = $1 AND d.demand_owner_id = $2 AND d.session_binding_hash = $3
            AND e.physical_camera_id = $4 AND e.node_id = $5
            AND d.viewer_user_id = $6 AND d.logical_camera_id = $7
            AND e.released_at IS NULL AND e.lease_expires_at > clock_timestamp()
            AND d.released_at IS NULL AND d.lease_expires_at > clock_timestamp()
          RETURNING d.producer_generation`, [handle.producerGeneration, handle.demandOwnerId, hash,
          access.physicalCameraId, access.nodeId, access.userId, access.logicalCameraId, DEMAND_LEASE_MS])
        if (result.rowCount !== 1) throw deny()
        await extendEpoch(client, handle.producerGeneration, handle.demandOwnerId)
        return Object.freeze(handle)
      })
    },

    async release(suppliedHandle) {
      const handle = exactHandle(suppliedHandle)
      return transaction(async client => {
        // Cleanup needs no live session/authority; only the server-held exact handle.
        await client.query('SELECT physical_camera_id FROM physical_cameras WHERE physical_camera_id = $1 FOR UPDATE', [handle.physicalCameraId])
        const result = await client.query(`UPDATE camera_producer_demands d SET released_at = clock_timestamp()
          FROM camera_producer_epochs e WHERE e.producer_generation = d.producer_generation
            AND e.producer_generation = $1 AND d.demand_owner_id = $2 AND d.session_binding_hash = $3
            AND e.physical_camera_id = $4 AND e.node_id = $5
            AND d.viewer_user_id = $6 AND d.logical_camera_id = $7
            AND e.released_at IS NULL AND d.released_at IS NULL`,
        [handle.producerGeneration, handle.demandOwnerId, handle.sessionBindingHash,
          handle.physicalCameraId, handle.nodeId, handle.userId, handle.logicalCameraId])
        if (result.rowCount) await retire(client, handle.physicalCameraId)
        return result.rowCount === 1
      })
    },
  })
}
