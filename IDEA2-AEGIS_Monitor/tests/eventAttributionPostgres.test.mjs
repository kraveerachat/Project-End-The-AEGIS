import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const monitorRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

const databaseUrl = process.env.AEGIS_MONITOR_TEST_DATABASE_URL

test('strict detection and alert attribution is bound to a live server generation', {
  skip: !databaseUrl && 'requires explicit disposable AEGIS_MONITOR_TEST_DATABASE_URL',
}, async () => {
  assert.equal(
    process.env.DATABASE_URL,
    databaseUrl,
    'store and fixture must use the same explicit disposable database',
  )

  const target = new URL(databaseUrl)

  assert.ok(
    ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname),
    'event-attribution DB test is loopback-only',
  )

  assert.match(
    target.pathname,
    /(?:test|disposable)/i,
    'event-attribution DB must be explicitly disposable',
  )

  const suffix = randomBytes(8).toString('hex')
  const schema = `aegis_event_${suffix}`
  const nodeId = `event-node-${suffix}`
  const fingerprint = `SHA256:event-${suffix}`

  const fixture = new pg.Client({
    connectionString: databaseUrl,
  })

  await fixture.connect()

  let connection

  try {
    await fixture.query(`CREATE SCHEMA "${schema}"`)
    await fixture.query(`SET search_path TO "${schema}"`)
    await fixture.query(
      fs.readFileSync(
        path.join(monitorRoot, 'server', 'db', 'schema.sql'),
        'utf8',
      ),
    )

    await fixture.query(`
      INSERT INTO users
        (id, username, password_hash, display_name, role, active, must_reset_password)
      VALUES
        (1, 'operator', 'test-only', 'Operator',
         'CCTV-Operator', TRUE, FALSE),
        (2, 'operator2', 'test-only', 'Operator Two',
         'CCTV-Operator', TRUE, FALSE);

      INSERT INTO cameras (id, name, zone)
      VALUES
        ('CAM-01', 'One', 'lab'),
        ('CAM-02', 'Two', 'lab');

      INSERT INTO camera_assignment (camera_id, user_id)
      VALUES
        ('CAM-01', 1),
        ('CAM-02', 2);
    `)

    await fixture.query(
      `INSERT INTO detection_nodes
         (node_id, camera_id, public_key, public_key_fingerprint,
          key_version, ingest_auth_mode, active)
       VALUES
         ($1, NULL, 'PUBLIC KEY ONLY', $2, 1,
          'ed25519_required', TRUE)`,
      [nodeId, fingerprint],
    )

    const physical = await fixture.query(
      `INSERT INTO physical_cameras (node_id, active)
       VALUES ($1, TRUE)
       RETURNING physical_camera_id`,
      [nodeId],
    )

    const physicalCameraId =
      Number(physical.rows[0].physical_camera_id)

    await fixture.query(
      `INSERT INTO node_camera_alias_policy
         (node_id, mode, fixed_camera_id)
       VALUES ($1, 'fixed', 'CAM-01')`,
      [nodeId],
    )

    target.searchParams.set(
      'options',
      `-c search_path=${schema} -c statement_timeout=8000`,
    )

    process.env.DATABASE_URL = target.toString()

    const store = await import('../server/db/store.js')
    connection = await import('../server/db/connection.js')
    const { createProducerLifecycle } =
      await import('../server/db/producerLifecycle.js')

    const lifecycle = createProducerLifecycle({
      secret: 'event-attribution-test-secret-32bytes!!!',
    })

    const sessionBinding =
      Buffer.alloc(32, 21).toString('base64url')

    const access = {
      userId: 1,
      nodeId,
      physicalCameraId,
      logicalCameraId: 'CAM-01',
      keyVersion: 1,
    }

    const handle = await lifecycle.acquire({
      access,
      sessionBinding,
    })

    const auth = {
      kind: 'ed25519',
      verifiedNode: {
        nodeId,
        keyVersion: 1,
        physicalCameraId,
        agentSessionId: 'test-only-session',
      },
    }

    const detection = await store.insertDetection({
      cameraId: 'CAM-01',
      frameId: `frame-${suffix}`,
      producerGeneration: handle.producerGeneration,
      entities: [
        {
          status: 'Unknown',
          confidence: 91,
        },
      ],
    }, auth)

    assert.equal(detection.rows, 1)

    const alert = await store.insertAlert({
      cameraId: 'CAM-01',
      severity: 'amber',
      alertType: 'unknown_face',
      title: `alert-${suffix}`,
      snapshotPath: null,
      telegramSent: false,
      producerGeneration: handle.producerGeneration,
    }, auth)

    assert.ok(alert.id)

    const persisted = await fixture.query(
      `SELECT
         (SELECT camera_id
            FROM detections
           WHERE frame_id = $1) AS detection_camera,
         (SELECT physical_camera_id
            FROM detections
           WHERE frame_id = $1) AS detection_physical,
         (SELECT producer_generation::text
            FROM detections
           WHERE frame_id = $1) AS detection_generation,
         (SELECT camera_id
            FROM alerts
           WHERE title = $2) AS alert_camera,
         (SELECT physical_camera_id
            FROM alerts
           WHERE title = $2) AS alert_physical,
         (SELECT producer_generation::text
            FROM alerts
           WHERE title = $2) AS alert_generation`,
      [`frame-${suffix}`, `alert-${suffix}`],
    )

    assert.equal(
      persisted.rows[0].detection_camera,
      'CAM-01',
    )
    assert.equal(
      Number(persisted.rows[0].detection_physical),
      physicalCameraId,
    )
    assert.equal(
      persisted.rows[0].detection_generation,
      handle.producerGeneration,
    )

    assert.equal(
      persisted.rows[0].alert_camera,
      'CAM-01',
    )
    assert.equal(
      Number(persisted.rows[0].alert_physical),
      physicalCameraId,
    )
    assert.equal(
      persisted.rows[0].alert_generation,
      handle.producerGeneration,
    )

    // Same physical producer, wrong logical alias: no matching live demand.
    const wrongAlias = await store.insertDetection({
      cameraId: 'CAM-02',
      frameId: `wrong-alias-${suffix}`,
      producerGeneration: handle.producerGeneration,
      entities: [
        {
          status: 'Unknown',
          confidence: 80,
        },
      ],
    }, auth)

    assert.deepEqual(
      wrongAlias,
      {
        error: 'EVENT_ATTRIBUTION_DENIED',
        status: 403,
      },
    )

    // Wrong generation cannot borrow the valid alias.
    const wrongGeneration = await store.insertAlert({
      cameraId: 'CAM-01',
      severity: 'amber',
      alertType: 'unknown_face',
      title: `wrong-generation-${suffix}`,
      snapshotPath: null,
      telegramSent: false,
      producerGeneration: '9223372036854775807',
    }, auth)

    assert.deepEqual(
      wrongGeneration,
      {
        error: 'EVENT_ATTRIBUTION_DENIED',
        status: 403,
      },
    )

    // Verified physical provenance cannot be replaced by caller context.
    const wrongPhysical = await store.insertDetection({
      cameraId: 'CAM-01',
      frameId: `wrong-physical-${suffix}`,
      producerGeneration: handle.producerGeneration,
      entities: [
        {
          status: 'Unknown',
          confidence: 80,
        },
      ],
    }, {
      kind: 'ed25519',
      verifiedNode: {
        nodeId,
        keyVersion: 1,
        physicalCameraId: physicalCameraId + 999,
        agentSessionId: 'test-only-session',
      },
    })

    assert.deepEqual(
      wrongPhysical,
      {
        error: 'EVENT_ATTRIBUTION_DENIED',
        status: 403,
      },
    )

    // Once demand is released, the old generation cannot authorize
    // a newly arriving Detection/Alert event.
    await lifecycle.release(handle)

    const released = await store.insertDetection({
      cameraId: 'CAM-01',
      frameId: `released-${suffix}`,
      producerGeneration: handle.producerGeneration,
      entities: [
        {
          status: 'Unknown',
          confidence: 80,
        },
      ],
    }, auth)

    assert.deepEqual(
      released,
      {
        error: 'EVENT_ATTRIBUTION_DENIED',
        status: 403,
      },
    )

    const forbiddenRows = await fixture.query(
      `SELECT count(*)::int AS total
         FROM detections
        WHERE frame_id IN ($1, $2, $3)`,
      [
        `wrong-alias-${suffix}`,
        `wrong-physical-${suffix}`,
        `released-${suffix}`,
      ],
    )

    assert.equal(forbiddenRows.rows[0].total, 0)
  } finally {
    if (connection) {
      await connection.closePool()
    }

    await fixture.query('SET search_path TO public')
    await fixture.query(
      `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
    )
    await fixture.end()
  }
})
