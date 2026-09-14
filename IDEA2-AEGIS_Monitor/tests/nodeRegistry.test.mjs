import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import pg from 'pg'

import * as connection from '../server/db/connection.js'
import * as store from '../server/db/store.js'

const monitorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(relativePath) {
  return fs.readFileSync(path.join(monitorRoot, relativePath), 'utf8')
}

test('maps authoritative detection-node registrations without heartbeat authority', () => {
  assert.equal(typeof connection.detectionNodeFromRow, 'function')
  assert.deepEqual(connection.detectionNodeFromRow({
    node_id: 'edge-a',
    camera_id: 'CAM-01',
    public_key: 'PUBLIC KEY ONLY',
    public_key_fingerprint: 'SHA256:fixture',
    key_version: 2,
    active: true,
  }), {
    nodeId: 'edge-a',
    cameraId: 'CAM-01',
    publicKey: 'PUBLIC KEY ONLY',
    publicKeyFingerprint: 'SHA256:fixture',
    keyVersion: 2,
    active: true,
  })
  assert.equal(connection.detectionNodeFromRow(null), null)
})

test('legacy logical-camera lookup fails closed when an alias maps to multiple nodes', () => {
  assert.equal(typeof connection.uniqueDetectionNodeFromRows, 'function')
  const nodeA = {
    node_id: 'edge-a',
    camera_id: 'CAM-01',
    public_key: 'PUBLIC KEY A',
    public_key_fingerprint: 'SHA256:a',
    key_version: 1,
    active: true,
  }
  const nodeC = {
    ...nodeA,
    node_id: 'edge-c',
    public_key: 'PUBLIC KEY C',
    public_key_fingerprint: 'SHA256:c',
  }

  assert.deepEqual(connection.uniqueDetectionNodeFromRows([nodeA]), connection.detectionNodeFromRow(nodeA))
  assert.equal(connection.uniqueDetectionNodeFromRows([nodeA, nodeC]), null)
  assert.equal(connection.uniqueDetectionNodeFromRows([]), null)
})

test('maps globally unique physical-camera registrations and fails closed on invalid IDs', () => {
  assert.equal(typeof connection.physicalCameraFromRow, 'function')
  assert.deepEqual(connection.physicalCameraFromRow({
    physical_camera_id: '41',
    node_id: 'edge-a',
    active: true,
  }), {
    physicalCameraId: 41,
    nodeId: 'edge-a',
    active: true,
  })
  assert.equal(connection.physicalCameraFromRow({ physical_camera_id: '0', node_id: 'edge-a' }), null)
  assert.equal(connection.physicalCameraFromRow({ physical_camera_id: 'not-an-id', node_id: 'edge-a' }), null)
})

test('keeps account aliases independent from physical-camera authority', () => {
  assert.equal(typeof connection.aliasPolicyFromRow, 'function')
  assert.equal(typeof connection.accountAliasFromRow, 'function')

  const physical = connection.physicalCameraFromRow({
    physical_camera_id: 77,
    node_id: 'edge-c',
    active: true,
  })
  const operator = connection.accountAliasFromRow({
    node_id: 'edge-c',
    user_id: 11,
    logical_camera_id: 'CAM-01',
  })
  const operator2 = connection.accountAliasFromRow({
    node_id: 'edge-c',
    user_id: 22,
    logical_camera_id: 'CAM-02',
  })

  assert.equal(physical.physicalCameraId, 77)
  assert.equal(operator.logicalCameraId, 'CAM-01')
  assert.equal(operator2.logicalCameraId, 'CAM-02')
  assert.equal(physical.physicalCameraId, 77, 'logical alias changes must not move physical authority')
})

test('exposes parameterized server-side registry lookups without heartbeat authority', () => {
  for (const name of [
    'getDetectionNode',
    'getActiveDetectionNode',
    'getDetectionNodeForCamera',
    'getPhysicalCameraForNode',
    'getPhysicalCamera',
    'getNodeAliasPolicy',
    'getNodeAccountAlias',
  ]) {
    assert.equal(typeof connection[name], 'function', `${name} must be exported`)
  }

  const source = read('server/db/connection.js')
  assert.match(source, /FROM detection_nodes WHERE node_id = \$1 LIMIT 1/i)
  assert.match(source, /FROM detection_nodes WHERE camera_id = \$1 LIMIT 2/i)
  assert.match(source, /FROM physical_cameras WHERE node_id = \$1 LIMIT 1/i)
  assert.match(source, /FROM node_account_camera_alias[\s\S]*WHERE node_id = \$1 AND user_id = \$2/i)
  assert.doesNotMatch(source, /FROM camera_heartbeat[\s\S]*getPhysicalCameraForNode/i)
})

test('physical stream-source lookup stays distinct from logical producer selection', async () => {
  assert.equal(typeof store.streamSourceForPhysicalCamera, 'function')
  assert.equal(await store.streamSourceForPhysicalCamera(0), null)
  assert.equal(await store.streamSourceForPhysicalCamera('CAM-01'), null)

  const source = read('server/db/store.js')
  const start = source.indexOf('export async function streamSourceForPhysicalCamera')
  const end = source.indexOf('\nexport async function ', start + 1)
  const implementation = source.slice(start, end < 0 ? undefined : end)
  assert.match(implementation, /FROM physical_camera_heartbeat/)
  assert.match(implementation, /WHERE physical_camera_id = \$1/)
  assert.doesNotMatch(implementation, /camera_producer_epochs|node_camera_alias_policy/)
})

test('real PostgreSQL registry lookup fails closed and keeps physical identity independent', {
  skip: !process.env.AEGIS_MONITOR_TEST_DATABASE_URL,
}, async () => {
  const suffix = randomBytes(6).toString('hex')
  const nodeId = `registry-${suffix}`
  const fingerprint = `SHA256:registry-${suffix}`
  const client = new pg.Client({ connectionString: process.env.AEGIS_MONITOR_TEST_DATABASE_URL })
  await client.connect()
  try {
    const user = await client.query(`SELECT id FROM users WHERE username = 'operator' LIMIT 1`)
    assert.equal(user.rows.length, 1)
    await client.query(
      `INSERT INTO detection_nodes
         (node_id, camera_id, public_key, public_key_fingerprint, key_version, active)
       VALUES ($1, NULL, 'PUBLIC KEY ONLY', $2, 1, TRUE)`,
      [nodeId, fingerprint],
    )
    const insertedPhysical = await client.query(
      'INSERT INTO physical_cameras (node_id) VALUES ($1) RETURNING physical_camera_id',
      [nodeId],
    )
    await client.query(
      `INSERT INTO node_camera_alias_policy (node_id, mode, fixed_camera_id)
       VALUES ($1, 'account', NULL)`,
      [nodeId],
    )
    await client.query(
      `INSERT INTO node_account_camera_alias (node_id, user_id, logical_camera_id)
       VALUES ($1, $2, 'CAM-01')`,
      [nodeId, user.rows[0].id],
    )

    assert.equal((await connection.getDetectionNode(nodeId)).nodeId, nodeId)
    assert.equal((await connection.getActiveDetectionNode(nodeId)).nodeId, nodeId)
    assert.equal(await connection.getDetectionNode('unknown-registry-node'), null)
    assert.deepEqual(await connection.getPhysicalCameraForNode(nodeId), {
      physicalCameraId: Number(insertedPhysical.rows[0].physical_camera_id),
      nodeId,
      active: true,
    })
    assert.equal((await connection.getNodeAccountAlias(nodeId, user.rows[0].id)).logicalCameraId, 'CAM-01')

    await client.query('UPDATE detection_nodes SET active = FALSE WHERE node_id = $1', [nodeId])
    assert.equal(await connection.getActiveDetectionNode(nodeId), null)
  } finally {
    await client.query('DELETE FROM node_account_camera_alias WHERE node_id = $1', [nodeId])
    await client.query('DELETE FROM node_camera_alias_policy WHERE node_id = $1', [nodeId])
    await client.query('DELETE FROM physical_cameras WHERE node_id = $1', [nodeId])
    await client.query('DELETE FROM detection_nodes WHERE node_id = $1', [nodeId])
    await client.end()
    await connection.closePool()
  }
})
