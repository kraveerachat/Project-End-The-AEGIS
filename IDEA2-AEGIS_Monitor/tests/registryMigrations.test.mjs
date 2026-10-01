import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import pg from 'pg'

const monitorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(relativePath) {
  return fs.readFileSync(path.join(monitorRoot, relativePath), 'utf8')
}

function normalizedSql(relativePath) {
  return read(relativePath).replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

const migrationPaths = [
  'server/db/migrations/001_device_owned_local_runtime.sql',
  'server/db/migrations/002_physical_camera_logical_alias.sql',
  'server/db/migrations/003_deprecate_node_camera_identity.sql',
  'server/db/migrations/004_detection_node_ingest_auth_mode.sql',
]

const ownershipMigrationPath = 'server/db/migrations/005_physical_producer_ownership.sql'

test('migration 005 statically preserves history and changes only producer ownership', () => {
  const sql = normalizedSql(ownershipMigrationPath)
  assert.match(sql, /^begin;/)
  assert.match(sql, /commit;$/)
  assert.match(sql, /add column if not exists logical_camera_id text references cameras\s*\(id\) on delete restrict/)
  assert.match(sql, /add column if not exists viewer_user_id bigint references users\s*\(id\) on delete restrict/)
  assert.match(sql, /alter column logical_camera_id set not null/)
  assert.match(sql, /drop index if exists camera_producer_epochs_active_logical_idx/)
  assert.match(sql, /alter table camera_producer_epochs alter column logical_camera_id drop not null/)
  assert.doesNotMatch(sql, /drop\s+(?:table|column)\b|truncate\b|delete\s+from\b|drop index[^;]*active_physical/)
})

// These tests only mutate randomly named schemas in an explicitly supplied
// disposable database. Never point this URL at Production or the H1 live lab.
async function withDisposableSchema(run) {
  const schemaName = `aegis_ownership_${randomBytes(8).toString('hex')}`
  const client = new pg.Client({ connectionString: process.env.AEGIS_MONITOR_TEST_DATABASE_URL })
  await client.connect()
  try {
    await client.query(`CREATE SCHEMA "${schemaName}"`)
    await client.query(`SET search_path TO "${schemaName}"`)
    return await run(client, schemaName)
  } finally {
    // A failed transactional migration leaves the connection aborted; rollback
    // before inspecting/cleaning only this test's exact disposable schema.
    await client.query('ROLLBACK')
    await client.query('SET search_path TO public')
    await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await client.end()
  }
}

async function applyLegacyChain(client) {
  await client.query(`
    CREATE TABLE users (id BIGSERIAL PRIMARY KEY);
    CREATE TABLE cameras (id TEXT PRIMARY KEY);
    CREATE TABLE camera_heartbeat (
      camera_id TEXT PRIMARY KEY REFERENCES cameras(id), node_id TEXT,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      camera_connected BOOLEAN NOT NULL DEFAULT FALSE,
      camera_reconnects INTEGER NOT NULL DEFAULT 0,
      capture_fps NUMERIC(6,2), detect_fps NUMERIC(6,2),
      latency_ms NUMERIC(8,2), latency_ms_avg NUMERIC(8,2),
      uptime_s NUMERIC(12,1), frames_captured BIGINT, segments_written INTEGER,
      nas_last_status TEXT, nas_pending INTEGER, stream_url TEXT
    );
    CREATE TABLE detections (id BIGSERIAL PRIMARY KEY, camera_id TEXT REFERENCES cameras(id));
    CREATE TABLE alerts (id BIGSERIAL PRIMARY KEY, camera_id TEXT REFERENCES cameras(id));
    CREATE TABLE clips (id BIGSERIAL PRIMARY KEY, camera_id TEXT REFERENCES cameras(id));
  `)
  for (const relativePath of migrationPaths) await client.query(read(relativePath))
}

async function ownershipShape(client, schemaName) {
  const columns = await client.query(`
    SELECT table_name, column_name, data_type, is_nullable, column_default, is_identity
      FROM information_schema.columns
     WHERE table_schema = $1
       AND table_name IN ('camera_producer_epochs', 'camera_producer_demands')
     ORDER BY table_name, column_name
  `, [schemaName])
  const constraints = await client.query(`
    SELECT t.relname AS table_name, c.conname, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = $1 AND t.relname IN ('camera_producer_epochs', 'camera_producer_demands')
     ORDER BY t.relname, c.conname
  `, [schemaName])
  const indexes = await client.query(`
    SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname = $1 AND tablename IN ('camera_producer_epochs', 'camera_producer_demands')
     ORDER BY indexname
  `, [schemaName])
  return {
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows.map((row) => ({
      ...row, indexdef: row.indexdef.replaceAll(`${schemaName}.`, '<schema>.'),
    })),
  }
}

async function seedHistoricalProducers(client) {
  await client.query(`
    INSERT INTO users (id) VALUES (1), (2);
    INSERT INTO cameras (id) VALUES ('CAM-01'), ('CAM-02');
    INSERT INTO detection_nodes (node_id, public_key, public_key_fingerprint, key_version)
      VALUES ('node-a', 'public-a', 'fingerprint-a', 1), ('node-b', 'public-b', 'fingerprint-b', 1);
    INSERT INTO physical_cameras (node_id) VALUES ('node-a'), ('node-b');
    INSERT INTO camera_producer_epochs
      (logical_camera_id, physical_camera_id, node_id, acquired_at, lease_expires_at, released_at)
      VALUES
      ('CAM-01', 1, 'node-a', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', NULL),
      ('CAM-02', 2, 'node-b', '2026-01-02T00:00:00Z', '2026-01-02T00:01:00Z', '2026-01-02T00:00:30Z');
    INSERT INTO camera_producer_demands
      (producer_generation, demand_owner_id, session_binding_hash, lease_expires_at, released_at)
      VALUES
      (1, 'historical-a', 'hash-a', '2026-01-01T00:01:00Z', NULL),
      (2, 'historical-b', 'hash-b', '2026-01-02T00:01:00Z', '2026-01-02T00:00:30Z');
    INSERT INTO detections (camera_id, physical_camera_id, producer_generation) VALUES ('CAM-01', 1, 1);
    INSERT INTO alerts (camera_id, physical_camera_id, producer_generation) VALUES ('CAM-01', 1, 1);
    INSERT INTO clips (camera_id, physical_camera_id, producer_generation) VALUES ('CAM-01', 1, 1);
  `)
}

async function historicalSnapshot(client) {
  return {
    epochs: (await client.query('SELECT * FROM camera_producer_epochs ORDER BY producer_generation')).rows,
    demands: (await client.query(`
      SELECT producer_generation, demand_owner_id, session_binding_hash, lease_expires_at, released_at
        FROM camera_producer_demands ORDER BY producer_generation, demand_owner_id
    `)).rows,
    events: (await client.query(`
      SELECT 'detections' AS kind, id, camera_id, physical_camera_id, producer_generation FROM detections
      UNION ALL SELECT 'alerts', id, camera_id, physical_camera_id, producer_generation FROM alerts
      UNION ALL SELECT 'clips', id, camera_id, physical_camera_id, producer_generation FROM clips
      ORDER BY kind, id
    `)).rows,
  }
}

async function assertPhysicalOwnership(client, schemaName) {
  const shape = await ownershipShape(client, schemaName)
  const physicalIndex = shape.indexes.find((row) => row.indexname === 'camera_producer_epochs_active_physical_idx')
  assert.match(physicalIndex?.indexdef ?? '', /CREATE UNIQUE INDEX.*\(physical_camera_id\).*WHERE \(released_at IS NULL\)/)
  assert.ok(!shape.indexes.some((row) => row.indexname === 'camera_producer_epochs_active_logical_idx'))
  assert.equal(shape.columns.find((row) => row.table_name === 'camera_producer_epochs' && row.column_name === 'logical_camera_id')?.is_nullable, 'YES')
  assert.equal(shape.columns.find((row) => row.table_name === 'camera_producer_demands' && row.column_name === 'logical_camera_id')?.is_nullable, 'NO')
  assert.equal(shape.columns.find((row) => row.table_name === 'camera_producer_demands' && row.column_name === 'viewer_user_id')?.is_nullable, 'YES')
  await client.query(`
    INSERT INTO users (id) VALUES (1), (2);
    INSERT INTO cameras (id) VALUES ('CAM-01'), ('CAM-02');
    INSERT INTO detection_nodes (node_id, public_key, public_key_fingerprint, key_version)
      VALUES ('node-a', 'public-a', 'fingerprint-a', 1), ('node-b', 'public-b', 'fingerprint-b', 1);
    INSERT INTO physical_cameras (node_id) VALUES ('node-a'), ('node-b');
    INSERT INTO camera_producer_epochs (physical_camera_id, node_id, lease_expires_at)
      VALUES (1, 'node-a', now() + interval '1 minute');
    INSERT INTO camera_producer_demands
      (producer_generation, demand_owner_id, session_binding_hash, logical_camera_id, viewer_user_id, lease_expires_at)
      VALUES (1, 'viewer-a', 'hash-a', 'CAM-01', 1, now() + interval '1 minute'),
             (1, 'viewer-b', 'hash-b', 'CAM-02', 2, now() + interval '1 minute');
    UPDATE camera_producer_epochs SET logical_camera_id = 'CAM-01' WHERE producer_generation = 1;
    INSERT INTO camera_producer_epochs (logical_camera_id, physical_camera_id, node_id, lease_expires_at)
      VALUES ('CAM-01', 2, 'node-b', now() + interval '1 minute');
  `)
  assert.deepEqual((await client.query('SELECT logical_camera_id, viewer_user_id FROM camera_producer_demands ORDER BY demand_owner_id')).rows, [
    { logical_camera_id: 'CAM-01', viewer_user_id: '1' },
    { logical_camera_id: 'CAM-02', viewer_user_id: '2' },
  ])
  assert.equal((await client.query("SELECT count(*)::int AS count FROM camera_producer_epochs WHERE logical_camera_id = 'CAM-01' AND released_at IS NULL")).rows[0].count, 2)
  await assert.rejects(client.query(`
    INSERT INTO camera_producer_epochs (physical_camera_id, node_id, lease_expires_at)
      VALUES (1, 'node-a', now() + interval '1 minute')
  `), { code: '23505', constraint: 'camera_producer_epochs_active_physical_idx' })
  await assert.rejects(client.query(`
    INSERT INTO camera_producer_demands (producer_generation, demand_owner_id, session_binding_hash, lease_expires_at)
      VALUES (1, 'missing-alias', 'hash', now() + interval '1 minute')
  `), { code: '23502', column: 'logical_camera_id' })
  await assert.rejects(client.query(`
    INSERT INTO camera_producer_demands
      (producer_generation, demand_owner_id, session_binding_hash, logical_camera_id, viewer_user_id, lease_expires_at)
      VALUES (1, 'unknown-user', 'hash', 'CAM-01', 999, now() + interval '1 minute')
  `), { code: '23503' })
  return shape
}

const disposablePostgres = { skip: !process.env.AEGIS_MONITOR_TEST_DATABASE_URL }

// Catches fresh-schema/upgrade divergence, lingering logical uniqueness, and
// accidentally weakened physical uniqueness or missing demand context FKs.
test('migration_005_fresh_chain_matches_schema', disposablePostgres, async () => {
  const chainShape = await withDisposableSchema(async (client, schemaName) => {
    await applyLegacyChain(client)
    await client.query(read(ownershipMigrationPath))
    return assertPhysicalOwnership(client, schemaName)
  })
  const freshShape = await withDisposableSchema(async (client, schemaName) => {
    await client.query(read('server/db/schema.sql'))
    // Fresh-schema fixture needs the required non-registry metadata only.
    await client.query("ALTER TABLE users ALTER COLUMN username SET DEFAULT 'test-' || nextval('users_id_seq'); ALTER TABLE users ALTER COLUMN password_hash SET DEFAULT 'unused'; ALTER TABLE users ALTER COLUMN display_name SET DEFAULT 'Test'; ALTER TABLE cameras ALTER COLUMN name SET DEFAULT 'Test'; ALTER TABLE cameras ALTER COLUMN zone SET DEFAULT 'Test'")
    return assertPhysicalOwnership(client, schemaName)
  })
  assert.deepEqual(chainShape, freshShape)
})

// Catches guessed aliases, fabricated historical users, and lost row/event provenance.
test('migration_005_upgrades_existing_001_004_rows', disposablePostgres, async () => {
  await withDisposableSchema(async (client) => {
    await applyLegacyChain(client)
    await seedHistoricalProducers(client)
    const before = await historicalSnapshot(client)
    await client.query(read(ownershipMigrationPath))
    assert.deepEqual(await historicalSnapshot(client), before)
    assert.deepEqual((await client.query('SELECT producer_generation, demand_owner_id, logical_camera_id, viewer_user_id FROM camera_producer_demands ORDER BY producer_generation')).rows, [
      { producer_generation: '1', demand_owner_id: 'historical-a', logical_camera_id: 'CAM-01', viewer_user_id: null },
      { producer_generation: '2', demand_owner_id: 'historical-b', logical_camera_id: 'CAM-02', viewer_user_id: null },
    ])
  })
})

// Catches a rerun that overwrites account aliases/users with the epoch's old alias.
test('migration_005_rerun_is_idempotent', disposablePostgres, async () => {
  await withDisposableSchema(async (client, schemaName) => {
    await applyLegacyChain(client)
    await seedHistoricalProducers(client)
    await client.query(read(ownershipMigrationPath))
    await client.query("UPDATE camera_producer_demands SET logical_camera_id = 'CAM-02', viewer_user_id = 2 WHERE demand_owner_id = 'historical-a'")
    const before = await historicalSnapshot(client)
    const context = (await client.query('SELECT * FROM camera_producer_demands ORDER BY producer_generation, demand_owner_id')).rows
    const shape = await ownershipShape(client, schemaName)
    await client.query(read(ownershipMigrationPath))
    assert.deepEqual(await historicalSnapshot(client), before)
    assert.deepEqual((await client.query('SELECT * FROM camera_producer_demands ORDER BY producer_generation, demand_owner_id')).rows, context)
    assert.deepEqual(await ownershipShape(client, schemaName), shape)
  })
})

// Catches a non-transactional migration leaving new columns/index changes after
// an unsafe historical alias. This deliberately drifted fixture is disposable.
test('migration_005_unbackfillable_alias_rolls_back', disposablePostgres, async () => {
  await withDisposableSchema(async (client, schemaName) => {
    await applyLegacyChain(client)
    await seedHistoricalProducers(client)
    await client.query('ALTER TABLE camera_producer_epochs ALTER COLUMN logical_camera_id DROP NOT NULL; UPDATE camera_producer_epochs SET logical_camera_id = NULL WHERE producer_generation = 1')
    const before = await historicalSnapshot(client)
    const shape = await ownershipShape(client, schemaName)
    await assert.rejects(client.query(read(ownershipMigrationPath)), /cannot backfill|contains null values/i)
    await client.query('ROLLBACK')
    assert.deepEqual(await historicalSnapshot(client), before)
    assert.deepEqual(await ownershipShape(client, schemaName), shape)
  })
})

test('migration 001 adds the node registry without seeding authority', () => {
  const sql = normalizedSql(migrationPaths[0])
  assert.match(sql, /create table if not exists detection_nodes/)
  assert.match(sql, /node_id text primary key/)
  assert.match(sql, /camera_id text not null unique references cameras\s*\(id\) on delete restrict/)
  assert.match(sql, /public_key text not null/)
  assert.match(sql, /public_key_fingerprint text not null unique/)
  assert.match(sql, /key_version integer not null check\s*\(key_version > 0\)/)
  assert.match(sql, /create table if not exists node_request_nonces/)
  assert.doesNotMatch(sql, /\binsert\s+into\b|\bupdate\b|\bdelete\s+from\b|\btruncate\b/)
})

test('migration 002 adds physical identity alias policy and provenance without destructive SQL', () => {
  const sql = normalizedSql(migrationPaths[1])
  assert.match(sql, /create table if not exists physical_cameras/)
  assert.match(sql, /physical_camera_id bigint generated always as identity primary key/)
  assert.match(sql, /node_id text not null unique references detection_nodes\s*\(node_id\)/)
  assert.match(sql, /create table if not exists node_camera_alias_policy/)
  assert.match(sql, /create table if not exists node_account_camera_alias/)
  assert.match(sql, /create table if not exists physical_camera_heartbeat/)
  assert.match(sql, /create table if not exists camera_producer_epochs/)
  assert.match(sql, /create table if not exists camera_producer_demands/)
  assert.match(sql, /add column if not exists physical_camera_id bigint references physical_cameras/)
  assert.match(sql, /add column if not exists producer_generation bigint references camera_producer_epochs/)
  assert.doesNotMatch(sql, /\btruncate\b|\bdrop\s+(?:table|column)\b|\bdelete\s+from\b/)
})

test('migration 003 removes only obsolete logical-as-physical constraints', () => {
  const sql = normalizedSql(migrationPaths[2])
  assert.match(sql, /alter table detection_nodes alter column camera_id drop not null/)
  assert.match(sql, /alter table detection_nodes drop constraint if exists detection_nodes_camera_id_key/)
  assert.doesNotMatch(sql, /drop\s+(?:table|column)\b|truncate\b|delete\s+from\b|update\s+detection_nodes/)
})

test('migration 004 adds only the explicit compatibility-safe per-node ingest mode', () => {
  const sql = normalizedSql(migrationPaths[3])
  assert.match(sql, /alter table detection_nodes add column if not exists ingest_auth_mode text/)
  assert.match(sql, /default 'legacy_shared_key'/)
  assert.match(sql, /check\s*\(ingest_auth_mode in\s*\('legacy_shared_key',\s*'ed25519_required'\)\)/)
  assert.doesNotMatch(sql, /\btruncate\b|\bdrop\s+(?:table|column)\b|\bdelete\s+from\b|\bupdate\s+detection_nodes/)
})

test('fresh schema contains the final registry model while retaining logical camera tables', () => {
  const sql = normalizedSql('server/db/schema.sql')
  for (const table of [
    'cameras',
    'camera_assignment',
    'camera_heartbeat',
    'detection_nodes',
    'node_request_nonces',
    'physical_cameras',
    'node_camera_alias_policy',
    'node_account_camera_alias',
    'physical_camera_heartbeat',
    'camera_producer_epochs',
    'camera_producer_demands',
  ]) {
    assert.match(sql, new RegExp(`create table if not exists ${table}`), `${table} missing`)
  }
  assert.match(sql, /camera_id text references cameras\s*\(id\) on delete restrict/)
  assert.match(sql, /ingest_auth_mode text not null default 'legacy_shared_key'/)
  assert.match(sql, /check\s*\(ingest_auth_mode in\s*\('legacy_shared_key',\s*'ed25519_required'\)\)/)
  assert.doesNotMatch(sql, /camera_id text not null unique references cameras\s*\(id\) on delete restrict/)
})

test('migrations rerun and preserve representative current-main rows in real PostgreSQL', {
  skip: !process.env.AEGIS_MONITOR_TEST_DATABASE_URL,
}, async () => {
  const schemaName = `aegis_registry_${randomBytes(8).toString('hex')}`
  const client = new pg.Client({ connectionString: process.env.AEGIS_MONITOR_TEST_DATABASE_URL })
  await client.connect()
  try {
    await client.query(`CREATE SCHEMA "${schemaName}"`)
    await client.query(`SET search_path TO "${schemaName}"`)
    await client.query(`
      CREATE TABLE users (id BIGSERIAL PRIMARY KEY);
      CREATE TABLE cameras (id TEXT PRIMARY KEY);
      CREATE TABLE camera_assignment (
        camera_id TEXT PRIMARY KEY REFERENCES cameras(id),
        user_id BIGINT REFERENCES users(id)
      );
      CREATE TABLE camera_heartbeat (
        camera_id TEXT PRIMARY KEY REFERENCES cameras(id),
        node_id TEXT,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        camera_connected BOOLEAN NOT NULL DEFAULT FALSE,
        camera_reconnects INTEGER NOT NULL DEFAULT 0,
        capture_fps NUMERIC(6,2), detect_fps NUMERIC(6,2),
        latency_ms NUMERIC(8,2), latency_ms_avg NUMERIC(8,2),
        uptime_s NUMERIC(12,1), frames_captured BIGINT,
        segments_written INTEGER, nas_last_status TEXT, nas_pending INTEGER,
        stream_url TEXT
      );
      CREATE TABLE detections (id BIGSERIAL PRIMARY KEY, camera_id TEXT NOT NULL REFERENCES cameras(id));
      CREATE TABLE alerts (id BIGSERIAL PRIMARY KEY, camera_id TEXT NOT NULL REFERENCES cameras(id));
      CREATE TABLE clips (id BIGSERIAL PRIMARY KEY, camera_id TEXT NOT NULL REFERENCES cameras(id));
      INSERT INTO users DEFAULT VALUES;
      INSERT INTO cameras (id) VALUES ('LEGACY-ONE'), ('LEGACY-TWO');
      INSERT INTO camera_assignment (camera_id, user_id) VALUES ('LEGACY-ONE', 1);
      INSERT INTO camera_heartbeat (camera_id, node_id, camera_connected, stream_url)
      VALUES ('LEGACY-ONE', 'legacy-a', TRUE, 'http://127.0.0.1:8077/stream.mjpg');
      INSERT INTO detections (camera_id) VALUES ('LEGACY-ONE');
      INSERT INTO alerts (camera_id) VALUES ('LEGACY-ONE');
      INSERT INTO clips (camera_id) VALUES ('LEGACY-ONE');
    `)

    for (const relativePath of migrationPaths) await client.query(read(relativePath))
    await client.query(`
      INSERT INTO detection_nodes
        (node_id, camera_id, public_key, public_key_fingerprint, key_version)
      VALUES
        ('legacy-a', 'LEGACY-ONE', 'public-a', 'fingerprint-a', 1),
        ('legacy-b', 'LEGACY-TWO', 'public-b', 'fingerprint-b', 1)
    `)
    await client.query(read(migrationPaths[1]))
    await client.query(read(migrationPaths[2]))
    for (const relativePath of migrationPaths) await client.query(read(relativePath))

    const legacyCounts = await client.query(`
      SELECT
        (SELECT count(*)::int FROM cameras) AS cameras,
        (SELECT count(*)::int FROM camera_assignment) AS assignments,
        (SELECT count(*)::int FROM camera_heartbeat) AS heartbeats,
        (SELECT count(*)::int FROM detections) AS detections,
        (SELECT count(*)::int FROM alerts) AS alerts,
        (SELECT count(*)::int FROM clips) AS clips
    `)
    assert.deepEqual(legacyCounts.rows, [{
      cameras: 2, assignments: 1, heartbeats: 1, detections: 1, alerts: 1, clips: 1,
    }])

    const physical = await client.query('SELECT node_id, physical_camera_id FROM physical_cameras ORDER BY node_id')
    assert.equal(physical.rows.length, 2)
    assert.equal(new Set(physical.rows.map((row) => row.physical_camera_id)).size, 2)
    const policies = await client.query('SELECT node_id, mode, fixed_camera_id FROM node_camera_alias_policy ORDER BY node_id')
    assert.deepEqual(policies.rows, [
      { node_id: 'legacy-a', mode: 'fixed', fixed_camera_id: 'LEGACY-ONE' },
      { node_id: 'legacy-b', mode: 'fixed', fixed_camera_id: 'LEGACY-TWO' },
    ])

    await client.query(`
      INSERT INTO cameras (id) VALUES ('LEGACY-SHARED');
      INSERT INTO detection_nodes
        (node_id, camera_id, public_key, public_key_fingerprint, key_version)
      VALUES
        ('legacy-c', 'LEGACY-SHARED', 'public-c', 'fingerprint-c', 1),
        ('legacy-d', 'LEGACY-SHARED', 'public-d', 'fingerprint-d', 1);
      INSERT INTO camera_heartbeat (camera_id, node_id)
      VALUES ('LEGACY-SHARED', NULL);
      INSERT INTO detections (camera_id) VALUES ('LEGACY-SHARED');
      INSERT INTO alerts (camera_id) VALUES ('LEGACY-SHARED');
      INSERT INTO clips (camera_id) VALUES ('LEGACY-SHARED');
    `)
    await client.query(read(migrationPaths[1]))

    const ambiguousBackfill = await client.query(`
      SELECT
        (SELECT count(*)::int
           FROM physical_camera_heartbeat ph
           JOIN physical_cameras pc USING (physical_camera_id)
          WHERE pc.node_id IN ('legacy-c', 'legacy-d')) AS heartbeats,
        (SELECT count(*)::int FROM detections
          WHERE camera_id = 'LEGACY-SHARED' AND physical_camera_id IS NOT NULL) AS detections,
        (SELECT count(*)::int FROM alerts
          WHERE camera_id = 'LEGACY-SHARED' AND physical_camera_id IS NOT NULL) AS alerts,
        (SELECT count(*)::int FROM clips
          WHERE camera_id = 'LEGACY-SHARED' AND physical_camera_id IS NOT NULL) AS clips
    `)
    assert.deepEqual(ambiguousBackfill.rows, [{
      heartbeats: 0, detections: 0, alerts: 0, clips: 0,
    }], 'shared logical aliases must never fabricate physical provenance')

    const nullable = await client.query(`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'detection_nodes' AND column_name = 'camera_id'
    `, [schemaName])
    assert.deepEqual(nullable.rows, [{ is_nullable: 'YES' }])
    const authModes = await client.query(
      'SELECT node_id, ingest_auth_mode FROM detection_nodes ORDER BY node_id',
    )
    assert.ok(authModes.rows.length >= 4)
    assert.ok(authModes.rows.every((row) => row.ingest_auth_mode === 'legacy_shared_key'))
  } finally {
    await client.query('SET search_path TO public')
    await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await client.end()
  }
})
