import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test, { before, beforeEach, after } from 'node:test'
import pg from 'pg'

const databaseUrl = process.env.AEGIS_MONITOR_TEST_DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.DATABASE_URL)
const schema = `aegis_clip_${randomBytes(12).toString('hex')}`
let db, store, connection, service
const origin = Date.now() - 600_000
const iso = ms => new Date(ms).toISOString()
const binding = Buffer.alloc(32, 17).toString('base64url')
const access = (machine = 'a', userId = 1) => ({ userId, nodeId: `node-${machine}`,
  physicalCameraId: { a: 1, b: 2, c: 3 }[machine], logicalCameraId: userId === 1 ? 'CAM-01' : 'CAM-02', keyVersion: 1 })
const auth = (machine = 'a') => ({ kind: 'ed25519', verifiedNode: {
  nodeId: `node-${machine}`, physicalCameraId: { a: 1, b: 2, c: 3 }[machine], keyVersion: 1 } })
const clip = (handle, overrides = {}) => ({ cameraId: handle.logicalCameraId,
  producerGeneration: handle.producerGeneration, startedAt: iso(origin), endedAt: iso(origin + 1000),
  durationSec: 1, filePath: `/verified/${randomBytes(12).toString('hex')}.mp4`, storedOnNas: true, ...overrides })
async function acquire(machine = 'a', userId = 1) {
  const handle = await service.acquire({ access: access(machine, userId), sessionBinding: binding })
  await db.query('UPDATE camera_producer_epochs SET acquired_at = $2 WHERE producer_generation = $1',
    [handle.producerGeneration, iso(origin - 60_000)])
  return handle
}
async function publish(input, provenance = auth()) {
  return store.insertClip(input, provenance)
}
async function denied(input, provenance = auth()) {
  const result = await publish(input, provenance)
  assert.ok(result.error, `expected rejection, got ${JSON.stringify(result)}`)
  assert.equal((await db.query('SELECT id FROM clips WHERE file_path = $1', [input.filePath])).rowCount, 0)
}
const dbTest = (name, fn) => test(name, { skip: !enabled && 'requires explicit disposable database variables' }, fn)

before(async () => {
  if (!enabled) return
  assert.equal(process.env.DATABASE_URL, databaseUrl, 'fixture and store must target the same disposable DB')
  const target = new URL(databaseUrl)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'disposable DB must be local')
  assert.match(target.pathname, /(?:test|disposable)/i, 'explicit disposable database name required')
  db = new pg.Client({ connectionString: databaseUrl })
  await db.connect()
  await db.query(`CREATE SCHEMA "${schema}"`)
  await db.query(`SET search_path TO "${schema}"`)
  await db.query(await readFile(new URL('../server/db/schema.sql', import.meta.url), 'utf8'))
  target.searchParams.set('options', `-c search_path=${schema} -c statement_timeout=8000`)
  process.env.DATABASE_URL = target.toString()
  store = await import('../server/db/store.js')
  connection = await import('../server/db/connection.js')
  const { createProducerLifecycle } = await import('../server/db/producerLifecycle.js')
  service = createProducerLifecycle({ secret: 'clip-fixture-session-secret-32-bytes!!!' })
})
beforeEach(async () => {
  if (!enabled) return
  delete process.env.AEGIS_CLIP_TIMESTAMP_TOLERANCE_S
  await db.query('TRUNCATE users, cameras, detection_nodes RESTART IDENTITY CASCADE')
  await db.query(`
    INSERT INTO users (id, username, password_hash, display_name) VALUES
      (1, 'operator', 'test-only', 'One'), (2, 'operator2', 'test-only', 'Two');
    INSERT INTO cameras (id, name, zone) VALUES ('CAM-01', 'One', 'lab'), ('CAM-02', 'Two', 'lab'), ('CAM-03', 'Three', 'lab');
    INSERT INTO camera_assignment (camera_id, user_id) VALUES ('CAM-01', 1), ('CAM-02', 2);
    INSERT INTO detection_nodes (node_id, public_key, public_key_fingerprint, key_version, ingest_auth_mode) VALUES
      ('node-a', 'test-a', 'a', 1, 'ed25519_required'), ('node-b', 'test-b', 'b', 1, 'ed25519_required'), ('node-c', 'test-c', 'c', 1, 'ed25519_required');
    INSERT INTO physical_cameras (node_id) VALUES ('node-a'), ('node-b'), ('node-c');
    INSERT INTO node_camera_alias_policy (node_id, mode) VALUES ('node-a', 'account'), ('node-b', 'account'), ('node-c', 'account');
    INSERT INTO node_account_camera_alias (node_id, user_id, logical_camera_id)
      SELECT node_id, id, CASE id WHEN 1 THEN 'CAM-01' ELSE 'CAM-02' END FROM detection_nodes CROSS JOIN users;
  `)
})
after(async () => {
  if (!enabled || !db) return
  delete process.env.AEGIS_CLIP_TIMESTAMP_TOLERANCE_S
  if (connection) await connection.closePool()
  await db.query('SET search_path TO public')
  await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await db.end()
})

dbTest('six account/Node mappings persist independent aliases on physical generations', async () => {
  for (const machine of ['a', 'b', 'c']) {
    const one = await acquire(machine, 1), two = await acquire(machine, 2)
    assert.equal(one.producerGeneration, two.producerGeneration)
    await Promise.all([publish(clip(one), auth(machine)), publish(clip(two), auth(machine))])
  }
  const rows = (await db.query('SELECT camera_id, physical_camera_id::text, producer_generation::text FROM clips ORDER BY physical_camera_id, camera_id')).rows
  assert.deepEqual(rows.map(r => [r.camera_id, r.physical_camera_id]), [
    ['CAM-01', '1'], ['CAM-02', '1'], ['CAM-01', '2'], ['CAM-02', '2'], ['CAM-01', '3'], ['CAM-02', '3']])
  for (const row of rows) assert.match(row.producer_generation, /^[1-9][0-9]*$/)
})
dbTest('strict Archive result classification requires exact alias, physical camera and generation', async () => {
  const a = await acquire('a', 1), b = await acquire('b', 1), cHandle = await acquire('c', 1)
  const aRow = await publish(clip(a), auth('a'))
  const bRow = await publish(clip(b), auth('b'))
  const cRow = await publish(clip(cHandle), auth('c'))
  assert.ok(aRow.id && bRow.id && cRow.id)

  await db.query(`INSERT INTO detections
    (frame_id, at, camera_id, physical_camera_id, producer_generation, result)
    VALUES
      ('a-auth', $1, 'CAM-01', 1, $2, 'Authorized'),
      ('b-unknown', $1, 'CAM-01', 2, $3, 'Unknown')`,
  [iso(origin + 500), a.producerGeneration, b.producerGeneration])

  const rows = await store.listClips(new Set(['CAM-01']))
  const byId = new Map(rows.map(row => [row.id, row]))

  assert.equal(byId.get(aRow.id)?.kind, 'auth')
  assert.equal(byId.get(bRow.id)?.kind, 'unknown')
  assert.equal(byId.get(cRow.id)?.kind, 'unavailable')
  assert.equal(byId.get(aRow.id)?.nodeId, 'node-a')
  assert.equal(byId.get(bRow.id)?.nodeId, 'node-b')
  assert.equal(byId.get(cRow.id)?.nodeId, 'node-c')
  assert.equal(byId.get(aRow.id)?.hasAuthorized, true)
  assert.equal(byId.get(aRow.id)?.hasUnknown, false)
  assert.equal(byId.get(bRow.id)?.hasUnknown, true)

  // Same logical alias and timestamp on another physical generation must not
  // turn Machine A's Authorized-only clip into Unknown.
  assert.equal(byId.get(aRow.id)?.kind, 'auth')
})
dbTest('CAM-02 strict Archive classification uses the same exact provenance rule', async () => {
  const handle = await acquire('a', 2)
  const row = await publish(clip(handle), auth('a'))
  assert.ok(row.id)
  await db.query(`INSERT INTO detections
    (frame_id, at, camera_id, physical_camera_id, producer_generation, result)
    VALUES ('cam02-unknown', $1, 'CAM-02', 1, $2, 'Unknown')`,
  [iso(origin + 500), handle.producerGeneration])
  const rows = await store.listClips(new Set(['CAM-02']))
  const archive = rows.find(item => item.id === row.id)
  assert.equal(archive?.kind, 'unknown')
  assert.equal(archive?.hasUnknown, true)
  assert.equal(archive?.nodeId, 'node-a')
})

dbTest('legacy Archive detection classification remains evidence-based', async () => {
  const { rows: [unknownClip] } = await db.query(`INSERT INTO clips
    (camera_id, started_at, duration_sec, file_path, stored_on_nas)
    VALUES ('CAM-01', $1, 1, $2, TRUE) RETURNING id::text`,
  [iso(origin), `/verified/legacy-unknown-${randomBytes(8).toString('hex')}.mp4`])
  const { rows: [emptyClip] } = await db.query(`INSERT INTO clips
    (camera_id, started_at, duration_sec, file_path, stored_on_nas)
    VALUES ('CAM-01', $1, 1, $2, TRUE) RETURNING id::text`,
  [iso(origin + 2000), `/verified/legacy-empty-${randomBytes(8).toString('hex')}.mp4`])
  await db.query(`INSERT INTO detections (frame_id, at, camera_id, result)
    VALUES ('legacy-unknown', $1, 'CAM-01', 'Unknown')`, [iso(origin + 500)])
  const rows = await store.listClips(new Set(['CAM-01']))
  assert.equal(rows.find(row => row.id === unknownClip.id)?.kind, 'unknown')
  assert.equal(rows.find(row => row.id === emptyClip.id)?.kind, 'unavailable')
})
dbTest('generation beyond JavaScript safe integer remains an exact decimal string', async () => {
  await db.query('ALTER TABLE camera_producer_epochs ALTER COLUMN producer_generation RESTART WITH 9007199254740993')
  const h = await acquire()
  assert.equal(h.producerGeneration, '9007199254740993')
  assert.ok((await publish(clip(h))).id)
  assert.equal((await db.query('SELECT producer_generation::text FROM clips')).rows[0].producer_generation, '9007199254740993')
})
for (const [name, change] of [
  ['wrong alias', { cameraId: 'CAM-02' }], ['unknown alias', { cameraId: 'CAM-99' }],
  ['missing generation', { producerGeneration: undefined }], ['wrong generation', { producerGeneration: '999' }],
  ['numeric generation', { producerGeneration: 1 }], ['unsafe numeric generation', { producerGeneration: 9007199254740992 }],
  ['zero generation', { producerGeneration: '0' }], ['negative generation', { producerGeneration: '-1' }],
  ['leading-zero generation', { producerGeneration: '01' }], ['spaced generation', { producerGeneration: ' 1' }],
  ['overflow generation', { producerGeneration: '9223372036854775808' }], ['fractional generation', { producerGeneration: '1.0' }],
  ['missing end time', { endedAt: undefined }], ['invalid timestamp', { endedAt: 'invalid' }],
  ['reversed interval', { endedAt: iso(origin - 1) }], ['zero duration', { durationSec: 0 }],
  ['negative duration', { durationSec: -1 }], ['nonfinite duration', { durationSec: Infinity }],
  ['missing duration', { durationSec: undefined }], ['excessive duration', { durationSec: 331 }],
  ['duration mismatch', { endedAt: iso(origin + 32_001) }], ['unverified transfer', { storedOnNas: false }],
  ['truthy NAS string', { storedOnNas: 'true' }],
  ['path truncation', { filePath: `/verified/${'x'.repeat(1024)}.mp4` }],
]) dbTest(`${name} rejects without a clip row`, async () => { await denied(clip(await acquire(), change)) })

dbTest('future interval rejects without a clip row', async () => {
  const h = await acquire(), now = Date.now()
  await denied(clip(h, { startedAt: iso(now + 31_000), endedAt: iso(now + 32_000) }))
})

dbTest('Node and registered physical-camera mismatch reject without rows', async () => {
  const input = clip(await acquire())
  await denied(input, auth('b'))
  await denied(input, { kind: 'ed25519', verifiedNode: { ...auth().verifiedNode, physicalCameraId: 2 } })
  await denied(input, { kind: 'ed25519', verifiedNode: { ...auth().verifiedNode, nodeId: 'missing' } })
})
dbTest('client physical-camera field cannot override authenticated provenance', async () => {
  const input = clip(await acquire(), { physicalCameraId: 999 })
  assert.ok((await publish(input)).id)
  assert.equal((await db.query('SELECT physical_camera_id::text FROM clips')).rows[0].physical_camera_id, '1')
})
dbTest('legacy shared-key and missing verified identity cannot authorize new attributed clips', async () => {
  const input = clip(await acquire())
  await denied(input, { kind: 'legacy_unverified', verifiedNode: null })
  await denied(input, { kind: 'ed25519', verifiedNode: null })
})
dbTest('missing historical demand and NULL historical viewer reject', async () => {
  const input = clip(await acquire())
  await db.query('UPDATE camera_producer_demands SET viewer_user_id = NULL')
  await denied(input)
  await db.query('DELETE FROM camera_producer_demands')
  await denied(input)
})
dbTest('released footage survives delayed publication and later assignment revocation', async () => {
  const h = await acquire(), input = clip(h)
  await service.release(h)
  await db.query('UPDATE camera_producer_epochs SET released_at = $1', [iso(origin + 2000)])
  await db.query('UPDATE camera_producer_demands SET released_at = $1', [iso(origin + 2000)])
  await db.query("DELETE FROM camera_assignment WHERE camera_id = 'CAM-01'")
  assert.ok((await publish(input)).id)
  await assert.rejects(service.acquire({ access: access(), sessionBinding: binding }), e => e.status === 403)
  await assert.rejects(service.renew({ handle: h, access: access(), sessionBinding: binding }), e => e.status === 403)
})
for (const tolerance of [30, 2, 0]) {
  for (const offset of [0, 1]) dbTest(`released demand tolerance ${tolerance}s boundary +${offset}ms`, async () => {
    if (tolerance !== 30) process.env.AEGIS_CLIP_TIMESTAMP_TOLERANCE_S = String(tolerance)
    const h = await acquire()
    await db.query('UPDATE camera_producer_demands SET released_at = $1', [iso(origin)])
    const end = origin + tolerance * 1000 + offset
    const input = clip(h, { startedAt: iso(end - 1000), endedAt: iso(end) })
    if (offset) await denied(input)
    else assert.ok((await publish(input)).id)
  })
}
dbTest('epoch acquisition and release boundaries are also enforced', async () => {
  const h = await acquire()
  await db.query('UPDATE camera_producer_epochs SET acquired_at = $1, released_at = $2', [iso(origin), iso(origin + 2000)])
  assert.ok((await publish(clip(h, { startedAt: iso(origin - 30_000), endedAt: iso(origin - 29_000) }))).id)
  await denied(clip(h, { startedAt: iso(origin - 30_001), endedAt: iso(origin - 29_001) }))
  assert.ok((await publish(clip(h, { startedAt: iso(origin + 31_000), endedAt: iso(origin + 32_000) }))).id)
  await denied(clip(h, { startedAt: iso(origin + 31_001), endedAt: iso(origin + 32_001) }))
})
for (const value of ['-1', 'NaN', 'Infinity', '3601', ' 30', '0.0011']) dbTest(`invalid timestamp tolerance ${value} fails closed`, async () => {
  process.env.AEGIS_CLIP_TIMESTAMP_TOLERANCE_S = value
  await denied(clip(await acquire()))
})
dbTest('duplicate storage object never creates a second row, including concurrent distinct epochs', async () => {
  const one = clip(await acquire('a')), two = clip(await acquire('b'), { filePath: one.filePath })
  const results = await Promise.all([publish(one, auth('a')), publish(two, auth('b'))])
  assert.equal(results.filter(r => r.id).length, 1)
  assert.equal(results.filter(r => r.error).length, 1)
  const again = await publish(one, auth('a'))
  assert.ok(again.error)
  assert.equal((await db.query('SELECT id FROM clips WHERE file_path = $1', [one.filePath])).rowCount, 1)
})
