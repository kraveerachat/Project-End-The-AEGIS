import { parseUint } from '../nodeIdentity/agentProtocol.js'

const MAX_BIGINT = 9223372036854775807n
const deny = () => Object.assign(new Error('CLIP_ATTRIBUTION_DENIED'), { status: 403 })

function timestamp(value) {
  if (typeof value !== 'string' || !value || !Number.isFinite(Date.parse(value))) throw deny()
  return Date.parse(value)
}

function toleranceMilliseconds() {
  // Clock sanity only, never permission. Limit configuration to one hour and
  // exact millisecond precision; avoid float conversion of fractional seconds.
  const value = process.env.AEGIS_CLIP_TIMESTAMP_TOLERANCE_S ?? '30'
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,3})?$/.test(value)) throw deny()
  const [seconds, fraction = ''] = value.split('.')
  const ms = BigInt(seconds) * 1000n + BigInt(fraction.padEnd(3, '0'))
  if (ms > 3_600_000n) throw deny()
  return Number(ms)
}

/** Internal only. The caller must validate and INSERT in this same transaction.
 * Historical demand insertion proves the user/alias association. Current
 * assignment/policy is deliberately NOT an ingest prerequisite. Demands have
 * no acquisition timestamp: this does not prove per-frame authorization.
 */
export async function validateClipAttribution(client, input, verifiedNode) {
  let producerGeneration, physicalCameraId, keyVersion
  try {
    if (typeof input?.producerGeneration !== 'string') throw deny()
    producerGeneration = parseUint(input.producerGeneration, { positive: true, max: MAX_BIGINT }).toString()
    physicalCameraId = parseUint(verifiedNode?.physicalCameraId, { positive: true, max: MAX_BIGINT }).toString()
    keyVersion = parseUint(verifiedNode?.keyVersion, { positive: true, max: 2147483647n }).toString()
  } catch { throw deny() }
  const nodeId = verifiedNode?.nodeId, cameraId = input?.cameraId, filePath = input?.filePath
  if (typeof nodeId !== 'string' || !nodeId || nodeId.length > 64
    || typeof cameraId !== 'string' || !/^CAM-[0-9]+$/.test(cameraId) || cameraId.length > 64
    || typeof filePath !== 'string' || !filePath || filePath.trim() !== filePath
    || filePath.length > 1024 || filePath.includes('\0') || input?.storedOnNas !== true) throw deny()
  const startedAtMs = timestamp(input?.startedAt), endedAtMs = timestamp(input?.endedAt)
  const durationSec = input?.durationSec, toleranceMs = toleranceMilliseconds()
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0
    || durationSec > 300 + toleranceMs / 1000 || startedAtMs > endedAtMs
    || Math.abs((endedAtMs - startedAtMs) - durationSec * 1000) > toleranceMs) throw deny()

  // Discovery is not authority. Lock historical users in numeric order first,
  // then Node -> physical -> epoch -> demand, matching lifecycle lock order.
  const candidates = (await client.query(`SELECT demand_owner_id, viewer_user_id::text FROM camera_producer_demands
    WHERE producer_generation = $1 AND logical_camera_id = $2 AND viewer_user_id IS NOT NULL`,
  [producerGeneration, cameraId])).rows
  if (!candidates.length) throw deny()
  const userIds = [...new Set(candidates.map(row => row.viewer_user_id))]
    .sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)
  for (const userId of userIds) {
    if ((await client.query('SELECT id FROM users WHERE id = $1 FOR SHARE', [userId])).rowCount !== 1) throw deny()
  }
  const node = (await client.query('SELECT node_id, key_version, active FROM detection_nodes WHERE node_id = $1 FOR SHARE', [nodeId])).rows[0]
  const physical = (await client.query('SELECT node_id, active FROM physical_cameras WHERE physical_camera_id = $1 FOR UPDATE', [physicalCameraId])).rows[0]
  if (!node?.active || String(node.key_version) !== keyVersion || !physical?.active || physical.node_id !== nodeId) throw deny()
  if ((await client.query('SELECT producer_generation FROM camera_producer_epochs WHERE producer_generation = $1 FOR UPDATE', [producerGeneration])).rowCount !== 1) throw deny()
  const owners = candidates.map(row => row.demand_owner_id)
  await client.query(`SELECT demand_owner_id FROM camera_producer_demands
    WHERE producer_generation = $1 AND demand_owner_id = ANY($2::text[]) ORDER BY demand_owner_id FOR UPDATE`,
  [producerGeneration, owners])
  // Recheck the exact relationship after every lock. Released/expired history
  // remains usable; neither current assignment nor live lease is required.
  const historical = (await client.query(`SELECT e.acquired_at, e.released_at AS epoch_released_at,
      d.released_at AS demand_released_at, clock_timestamp() AS server_now
    FROM camera_producer_epochs e
    JOIN camera_producer_demands d ON d.producer_generation = e.producer_generation
    JOIN users u ON u.id = d.viewer_user_id
    JOIN detection_nodes n ON n.node_id = e.node_id
    JOIN physical_cameras p ON p.physical_camera_id = e.physical_camera_id AND p.node_id = n.node_id
    WHERE e.producer_generation = $1 AND e.node_id = $2 AND e.physical_camera_id = $3
      AND d.logical_camera_id = $4 AND d.demand_owner_id = ANY($5::text[])
      AND d.viewer_user_id = ANY($6::bigint[]) AND n.active AND p.active AND n.key_version = $7`,
  [producerGeneration, nodeId, physicalCameraId, cameraId, owners, userIds, keyVersion])).rows
  const authorized = historical.some(row => endedAtMs <= row.server_now.getTime() + toleranceMs
    && startedAtMs >= row.acquired_at.getTime() - toleranceMs
    && (!row.epoch_released_at || endedAtMs <= row.epoch_released_at.getTime() + toleranceMs)
    && (!row.demand_released_at || endedAtMs <= row.demand_released_at.getTime() + toleranceMs))
  if (!authorized) throw deny()

  // Epoch locking alone cannot serialize the same storage object across two
  // physical producers. A domain-separated transaction advisory lock covers
  // every attributed insert without changing schema; hash collisions only
  // serialize unrelated paths, never authorize or lose a clip.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('aegis-clip-path-v1:' || $1::text, 0))", [filePath])
  if ((await client.query('SELECT id FROM clips WHERE file_path = $1 LIMIT 1', [filePath])).rowCount) throw deny()
  return { cameraId, physicalCameraId, producerGeneration, startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(), durationSec: Math.max(1, Math.round(durationSec)), filePath }
}
