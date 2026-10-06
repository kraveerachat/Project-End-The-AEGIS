import { parseUint } from '../nodeIdentity/agentProtocol.js'

const MAX_BIGINT = 9223372036854775807n
const deny = () => Object.assign(
  new Error('EVENT_ATTRIBUTION_DENIED'),
  { status: 403 },
)

export async function validateEventAttribution(client, input, verifiedNode) {
  let producerGeneration
  let physicalCameraId
  let keyVersion

  try {
    if (typeof input?.producerGeneration !== 'string') throw deny()

    producerGeneration = parseUint(
      input.producerGeneration,
      { positive: true, max: MAX_BIGINT },
    ).toString()

    physicalCameraId = parseUint(
      verifiedNode?.physicalCameraId,
      { positive: true, max: MAX_BIGINT },
    ).toString()

    keyVersion = parseUint(
      verifiedNode?.keyVersion,
      { positive: true, max: 2147483647n },
    ).toString()
  } catch {
    throw deny()
  }

  const nodeId = verifiedNode?.nodeId
  const cameraId = input?.cameraId

  if (
    typeof nodeId !== 'string'
    || !nodeId
    || nodeId.length > 64
    || typeof cameraId !== 'string'
    || !/^CAM-[0-9]+$/.test(cameraId)
    || cameraId.length > 64
  ) {
    throw deny()
  }

  // Lock in the same node -> physical -> epoch -> demand direction used by
  // producer lifecycle. A concurrent revoke/release cannot pass validation
  // and then race an attributed INSERT.
  const node = (
    await client.query(
      `SELECT node_id, key_version, active
         FROM detection_nodes
        WHERE node_id = $1
        FOR SHARE`,
      [nodeId],
    )
  ).rows[0]

  const physical = (
    await client.query(
      `SELECT physical_camera_id, node_id, active
         FROM physical_cameras
        WHERE physical_camera_id = $1
        FOR SHARE`,
      [physicalCameraId],
    )
  ).rows[0]

  if (
    !node?.active
    || String(node.key_version) !== keyVersion
    || !physical?.active
    || physical.node_id !== nodeId
  ) {
    throw deny()
  }

  const epoch = (
    await client.query(
      `SELECT producer_generation
         FROM camera_producer_epochs
        WHERE producer_generation = $1
          AND node_id = $2
          AND physical_camera_id = $3
          AND released_at IS NULL
          AND lease_expires_at > clock_timestamp()
        FOR SHARE`,
      [producerGeneration, nodeId, physicalCameraId],
    )
  ).rows[0]

  if (!epoch) throw deny()

  const demand = (
    await client.query(
      `SELECT demand_owner_id
         FROM camera_producer_demands
        WHERE producer_generation = $1
          AND logical_camera_id = $2
          AND viewer_user_id IS NOT NULL
          AND released_at IS NULL
          AND lease_expires_at > clock_timestamp()
        ORDER BY demand_owner_id
        FOR SHARE`,
      [producerGeneration, cameraId],
    )
  ).rows[0]

  if (!demand) throw deny()

  return Object.freeze({
    cameraId,
    physicalCameraId,
    producerGeneration,
  })
}
