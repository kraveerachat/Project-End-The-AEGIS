import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createInternalRouter } from '../server/routes/internal.js'
import * as store from '../server/db/store.js'

const monitorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('all four ingest handlers pass server-derived authentication context to storage', async () => {
  const source = fs.readFileSync(path.join(monitorRoot, 'server/routes/internal.js'), 'utf8')
  for (const method of ['recordHeartbeat', 'insertDetection', 'insertAlert', 'insertClip']) {
    assert.match(source, new RegExp(`storeAdapter\\.${method}\\(req\\.body \\?\\? \\{\\}, req\\.ingestAuth\\)`))
  }
  assert.equal(typeof createInternalRouter, 'function')
})

test('trusted stores use verified physical provenance and legacy calls remain nullable', () => {
  const source = fs.readFileSync(path.join(monitorRoot, 'server/db/store.js'), 'utf8')
  assert.match(source, /physical_camera_heartbeat/)
  for (const table of ['detections', 'alerts', 'clips']) {
    assert.match(source, new RegExp(`INSERT INTO ${table}[^]*physical_camera_id`))
  }
  assert.match(source, /ingestAuth\?\.kind === 'ed25519'/)
  assert.doesNotMatch(source, /physicalCameraId\s*=\s*input\?\.physicalCameraId/)
})

test('real PostgreSQL writes physical provenance only from verified Agent context', {
  skip: !process.env.AEGIS_MONITOR_TEST_DATABASE_URL || !process.env.DATABASE_URL,
}, async () => {
  const suffix = randomBytes(6).toString('hex')
  const nodeId = `agent-${suffix}`
  const fingerprint = `SHA256:agent-${suffix}`
  const frameId = `frame-${suffix}`
  const legacyFrameId = `legacy-${suffix}`
  const title = `alert-${suffix}`
  const filePath = `/verified/${suffix}.mp4`
  const client = new pg.Client({ connectionString: process.env.AEGIS_MONITOR_TEST_DATABASE_URL })
  await client.connect()
  let physicalCameraId = null
  try {
    await client.query(
      `INSERT INTO detection_nodes
         (node_id, camera_id, public_key, public_key_fingerprint, key_version, ingest_auth_mode, active)
       VALUES ($1, NULL, 'PUBLIC KEY ONLY', $2, 1, 'ed25519_required', TRUE)`,
      [nodeId, fingerprint],
    )
    const inserted = await client.query(
      'INSERT INTO physical_cameras (node_id) VALUES ($1) RETURNING physical_camera_id',
      [nodeId],
    )
    physicalCameraId = Number(inserted.rows[0].physical_camera_id)
    const auth = {
      kind: 'ed25519',
      verifiedNode: { nodeId, keyVersion: 1, physicalCameraId, agentSessionId: 'not-persisted' },
    }

    await store.recordHeartbeat({
      nodeId: 'forged', physicalCameraId: 999,
      cameraConnected: false, streamUrl: 'http://127.0.0.1:8077/stream.mjpg',
    }, auth)
    await store.insertDetection({
      cameraId: 'CAM-01', frameId, physicalCameraId: 999,
      entities: [{ status: 'Unknown', confidence: 88 }],
    }, auth)
    await store.insertAlert({
      cameraId: 'CAM-01', title, severity: 'amber', physicalCameraId: 999,
    }, auth)
    await store.insertClip({
      cameraId: 'CAM-01', filePath, startedAt: new Date().toISOString(),
      durationSec: 1, storedOnNas: true, physicalCameraId: 999,
    }, auth)
    await store.insertDetection({
      cameraId: 'CAM-01', frameId: legacyFrameId, physicalCameraId,
      entities: [{ status: 'Unknown', confidence: 50 }],
    }, { kind: 'legacy_unverified', verifiedNode: null })

    const heartbeat = await client.query(
      'SELECT node_id, physical_camera_id FROM physical_camera_heartbeat WHERE physical_camera_id = $1',
      [physicalCameraId],
    )
    assert.deepEqual(heartbeat.rows, [{ node_id: nodeId, physical_camera_id: String(physicalCameraId) }])
    const evidence = await client.query(
      `SELECT
         (SELECT physical_camera_id FROM detections WHERE frame_id = $1 LIMIT 1) AS detection_physical,
         (SELECT physical_camera_id FROM alerts WHERE title = $2 LIMIT 1) AS alert_physical,
         (SELECT physical_camera_id FROM clips WHERE file_path = $3 LIMIT 1) AS clip_physical,
         (SELECT physical_camera_id FROM detections WHERE frame_id = $4 LIMIT 1) AS legacy_physical`,
      [frameId, title, filePath, legacyFrameId],
    )
    assert.equal(Number(evidence.rows[0].detection_physical), physicalCameraId)
    assert.equal(Number(evidence.rows[0].alert_physical), physicalCameraId)
    assert.equal(Number(evidence.rows[0].clip_physical), physicalCameraId)
    assert.equal(evidence.rows[0].legacy_physical, null)
  } finally {
    await client.query('DELETE FROM detections WHERE frame_id = ANY($1)', [[frameId, legacyFrameId]])
    await client.query('DELETE FROM alerts WHERE title = $1', [title])
    await client.query('DELETE FROM clips WHERE file_path = $1', [filePath])
    if (physicalCameraId) {
      await client.query('DELETE FROM physical_camera_heartbeat WHERE physical_camera_id = $1', [physicalCameraId])
    }
    await client.query('DELETE FROM physical_cameras WHERE node_id = $1', [nodeId])
    await client.query('DELETE FROM detection_nodes WHERE node_id = $1', [nodeId])
    await client.end()
  }
})
