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
]

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
  } finally {
    await client.query('SET search_path TO public')
    await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await client.end()
  }
})
