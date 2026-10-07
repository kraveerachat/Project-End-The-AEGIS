import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const monitorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('all four ingest handlers pass server-derived authentication context to storage', async () => {
  const source = fs.readFileSync(path.join(monitorRoot, 'server/routes/internal.js'), 'utf8')
  for (const method of ['recordHeartbeat', 'insertDetection', 'insertAlert', 'insertClip']) {
    assert.match(source, new RegExp(`storeAdapter\\.${method}\\(req\\.body \\?\\? \\{\\}, req\\.ingestAuth\\)`))
  }
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
  const schema = `aegis_ingest_${suffix}`
  assert.equal(process.env.DATABASE_URL, process.env.AEGIS_MONITOR_TEST_DATABASE_URL,
    'store and fixture must use the same explicit disposable database')
  const target = new URL(process.env.AEGIS_MONITOR_TEST_DATABASE_URL)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
  assert.match(target.pathname, /(?:test|disposable)/i)
  const client = new pg.Client({ connectionString: process.env.AEGIS_MONITOR_TEST_DATABASE_URL })
  await client.connect()
  let physicalCameraId = null
  let connection
  try {
    await client.query(`CREATE SCHEMA "${schema}"`)
    await client.query(`SET search_path TO "${schema}"`)
    await client.query(fs.readFileSync(path.join(monitorRoot, 'server/db/schema.sql'), 'utf8'))
    await client.query(`INSERT INTO users (id, username, password_hash, display_name) VALUES (1, 'operator', 'test-only', 'Operator');
      INSERT INTO cameras (id, name, zone) VALUES ('CAM-01', 'One', 'lab');
      INSERT INTO camera_assignment (camera_id, user_id) VALUES ('CAM-01', 1);`)
    target.searchParams.set('options', `-c search_path=${schema} -c statement_timeout=8000`)
    process.env.DATABASE_URL = target.toString()
    const store = await import('../server/db/store.js')
    connection = await import('../server/db/connection.js')
    const { createProducerLifecycle } = await import('../server/db/producerLifecycle.js')
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
    await client.query("INSERT INTO node_camera_alias_policy (node_id, mode, fixed_camera_id) VALUES ($1, 'fixed', 'CAM-01')", [nodeId])
    const lifecycle = createProducerLifecycle({ secret: 'ingest-test-session-secret-32-bytes!!!' })
    const handle = await lifecycle.acquire({ access: { userId: 1, nodeId, physicalCameraId, logicalCameraId: 'CAM-01', keyVersion: 1 },
      sessionBinding: Buffer.alloc(32, 17).toString('base64url') })
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
      producerGeneration: handle.producerGeneration,
      entities: [{ status: 'Unknown', confidence: 88 }],
    }, auth)
    await store.insertAlert({
      cameraId: 'CAM-01', title, severity: 'amber', physicalCameraId: 999,
      producerGeneration: handle.producerGeneration,
    }, auth)
    const now = Date.now()
    const clipResult = await store.insertClip({
      cameraId: 'CAM-01', filePath,
      durationSec: 1, storedOnNas: true, physicalCameraId: 999,
      producerGeneration: handle.producerGeneration, startedAt: new Date(now - 1000).toISOString(), endedAt: new Date(now).toISOString(),
    }, auth)
    assert.ok(clipResult.id)
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
         (SELECT producer_generation::text FROM detections WHERE frame_id = $1 LIMIT 1) AS detection_generation,
         (SELECT physical_camera_id FROM alerts WHERE title = $2 LIMIT 1) AS alert_physical,
         (SELECT producer_generation::text FROM alerts WHERE title = $2 LIMIT 1) AS alert_generation,
         (SELECT physical_camera_id FROM clips WHERE file_path = $3 LIMIT 1) AS clip_physical,
         (SELECT physical_camera_id FROM detections WHERE frame_id = $4 LIMIT 1) AS legacy_physical`,
      [frameId, title, filePath, legacyFrameId],
    )
    assert.equal(Number(evidence.rows[0].detection_physical), physicalCameraId)
    assert.equal(evidence.rows[0].detection_generation, handle.producerGeneration)
    assert.equal(Number(evidence.rows[0].alert_physical), physicalCameraId)
    assert.equal(evidence.rows[0].alert_generation, handle.producerGeneration)
    assert.equal(Number(evidence.rows[0].clip_physical), physicalCameraId)
    assert.equal((await client.query('SELECT producer_generation::text FROM clips WHERE file_path = $1', [filePath])).rows[0].producer_generation, handle.producerGeneration)
    assert.equal(evidence.rows[0].legacy_physical, null)
  } finally {
    if (connection) await connection.closePool()
    await client.query('SET search_path TO public')
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await client.end()
  }
})
