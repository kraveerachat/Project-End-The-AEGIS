import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import pg from 'pg'
import { createProducerLifecycle } from '../server/db/producerLifecycle.js'

const databaseUrl = process.env.AEGIS_MONITOR_TEST_DATABASE_URL
const secret = 'fixture-session-secret-32-bytes-long!!!'
const sessionBinding = 'ERERERERERERERERERERERERERERERERERERERERERE'
const access = (machine = 'a', userId = 1) => ({
  userId, nodeId: `node-${machine}`, physicalCameraId: { a: 1, b: 2, c: 3 }[machine],
  logicalCameraId: userId === 1 ? 'CAM-01' : 'CAM-02', keyVersion: 1,
})
const acquire = (service, identity = access()) => service.acquire({ access: identity, sessionBinding })
const renew = (service, handle, identity = access()) => service.renew({ handle, access: identity, sessionBinding })
const denied = (error) => error.status === 403

async function fixture(run) {
  const schema = `aegis_lifecycle_${randomBytes(12).toString('hex')}`
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 })
  const admin = await pool.connect()
  const clients = new Set()
  async function connect() {
    const client = await pool.connect()
    clients.add(client)
    await client.query(`SET search_path TO "${schema}"`)
    await client.query("SET statement_timeout = '8s'")
    return client
  }
  async function transact(fn, barrier) {
    const client = await connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const result = await fn({ query: async (...args) => {
        // Pause immediately before the first lifecycle write, after authority locks.
        if (barrier && /^(?:\s*)(?:INSERT|UPDATE)\s/i.test(args[0])) {
          const pause = barrier
          barrier = null
          await pause(client)
        }
        return client.query(...args)
      } })
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { clients.delete(client); client.release() }
  }
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.query(`SET search_path TO "${schema}"`)
    await admin.query(await readFile(new URL('../server/db/schema.sql', import.meta.url), 'utf8'))
    await admin.query(`
      INSERT INTO users (id, username, password_hash, display_name) VALUES
        (1, 'operator', 'test-only', 'One'), (2, 'operator2', 'test-only', 'Two');
      INSERT INTO cameras (id, name, zone) VALUES ('CAM-01', 'One', 'lab'), ('CAM-02', 'Two', 'lab');
      INSERT INTO camera_assignment (camera_id, user_id) VALUES ('CAM-01', 1), ('CAM-02', 2);
      INSERT INTO detection_nodes (node_id, public_key, public_key_fingerprint, key_version) VALUES
        ('node-a', 'test-a', 'a', 1), ('node-b', 'test-b', 'b', 1), ('node-c', 'test-c', 'c', 1);
      INSERT INTO physical_cameras (node_id) VALUES ('node-a'), ('node-b'), ('node-c');
      INSERT INTO node_camera_alias_policy (node_id, mode) VALUES ('node-a', 'account'), ('node-b', 'account'), ('node-c', 'account');
      INSERT INTO node_account_camera_alias (node_id, user_id, logical_camera_id)
        SELECT node_id, id, CASE id WHEN 1 THEN 'CAM-01' ELSE 'CAM-02' END FROM detection_nodes CROSS JOIN users;
    `)
    await run({ db: admin, connect, transact, service: createProducerLifecycle({ secret, transact }) })
  } finally {
    for (const client of clients) { await client.query('ROLLBACK'); client.release() }
    await admin.query('ROLLBACK')
    await admin.query('SET search_path TO public')
    // Only the exact random schema this fixture created is ever dropped.
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    admin.release()
    await pool.end()
  }
}

function dbTest(name, fn) {
  test(name, { skip: !databaseUrl && 'requires explicit disposable AEGIS_MONITOR_TEST_DATABASE_URL' }, () => fixture(fn))
}

dbTest('concurrent_aliases_share_one_physical_generation', async ({ service, db }) => {
  const [one, two] = await Promise.all([acquire(service), acquire(service, access('a', 2))])
  assert.equal(one.producerGeneration, two.producerGeneration)
  assert.notEqual(one.demandOwnerId, two.demandOwnerId)
  assert.equal(Buffer.from(one.demandOwnerId, 'base64url').length, 32)
  const epochs = (await db.query('SELECT * FROM camera_producer_epochs')).rows
  assert.equal(epochs.length, 1)
  assert.equal(epochs[0].logical_camera_id, null)
  const demands = (await db.query('SELECT *, lease_expires_at - clock_timestamp() AS remaining FROM camera_producer_demands ORDER BY viewer_user_id')).rows
  assert.deepEqual(demands.map(d => [d.logical_camera_id, d.viewer_user_id]), [['CAM-01', '1'], ['CAM-02', '2']])
  for (const demand of demands) {
    assert.match(demand.session_binding_hash, /^v1:[a-f0-9]{64}$/)
    assert.ok(demand.remaining.seconds >= 28 && demand.remaining.seconds <= 30)
  }
  assert.ok(!JSON.stringify(demands).includes(sessionBinding))
})

dbTest('same_alias_on_distinct_physical_producers_does_not_conflict', async ({ service }) => {
  const [one, two] = await Promise.all([acquire(service), acquire(service, access('b'))])
  assert.notEqual(one.producerGeneration, two.producerGeneration)
})

dbTest('six_account_machine_combinations_keep_physical_owner', async ({ service, db }) => {
  await Promise.all(['a', 'b', 'c'].flatMap(machine => [1, 2].map(user => acquire(service, access(machine, user)))))
  const rows = (await db.query(`SELECT e.node_id, e.physical_camera_id, d.viewer_user_id, d.logical_camera_id
    FROM camera_producer_epochs e JOIN camera_producer_demands d USING (producer_generation)
    ORDER BY e.node_id, d.viewer_user_id`)).rows
  assert.deepEqual(rows.map(r => Object.values(r)), [
    ['node-a', '1', '1', 'CAM-01'], ['node-a', '1', '2', 'CAM-02'],
    ['node-b', '2', '1', 'CAM-01'], ['node-b', '2', '2', 'CAM-02'],
    ['node-c', '3', '1', 'CAM-01'], ['node-c', '3', '2', 'CAM-02'],
  ])
})

dbTest('fixed_policy_requires_matching_alias_and_live_assignment', async ({ service, db }) => {
  await db.query("UPDATE node_camera_alias_policy SET mode = 'fixed', fixed_camera_id = 'CAM-01' WHERE node_id = 'node-a'")
  await db.query("DELETE FROM node_account_camera_alias WHERE node_id = 'node-a'")
  const handle = await acquire(service)
  await renew(service, handle)
  await assert.rejects(acquire(service, access('a', 2)), denied)
  await db.query("DELETE FROM camera_assignment WHERE camera_id = 'CAM-01'")
  await assert.rejects(renew(service, handle), denied)
})

dbTest('transactional_revocation_prevents_acquire', async ({ service, db }) => {
  for (const identity of [{ ...access(), keyVersion: 2 }, { ...access(), physicalCameraId: 2 }, { ...access(), logicalCameraId: 'CAM-02' }]) {
    await assert.rejects(acquire(service, identity), denied)
  }
  await db.query("DELETE FROM camera_assignment WHERE camera_id = 'CAM-01'")
  await assert.rejects(acquire(service), denied)
  assert.equal((await db.query('SELECT * FROM camera_producer_epochs')).rowCount, 0)
  assert.equal((await db.query('SELECT * FROM camera_producer_demands')).rowCount, 0)
})

dbTest('expired_demand_never_revives_generation', async ({ service, db }) => {
  const old = await acquire(service)
  await db.query('UPDATE camera_producer_demands SET lease_expires_at = clock_timestamp()')
  await assert.rejects(renew(service, old), denied)
  const fresh = await acquire(service)
  assert.notEqual(fresh.producerGeneration, old.producerGeneration)
  await assert.rejects(renew(service, old), denied)
})

dbTest('expired_epoch_never_revives_even_with_unexpired_demand', async ({ service, db }) => {
  const old = await acquire(service)
  await db.query('UPDATE camera_producer_epochs SET lease_expires_at = clock_timestamp()')
  await assert.rejects(renew(service, old), denied)
  assert.notEqual((await acquire(service)).producerGeneration, old.producerGeneration)
})

dbTest('nonfinal_release_keeps_epoch', async ({ service, db }) => {
  const first = await acquire(service)
  const second = await acquire(service, access('a', 2))
  await service.release(first)
  await renew(service, second, access('a', 2))
  assert.equal((await db.query('SELECT released_at FROM camera_producer_epochs')).rows[0].released_at, null)
  assert.equal((await acquire(service)).producerGeneration, first.producerGeneration)
})

dbTest('final_release_retires_epoch', async ({ service, db }) => {
  const handle = await acquire(service)
  await service.release(handle)
  await service.release(handle)
  assert.ok((await db.query('SELECT released_at FROM camera_producer_epochs')).rows[0].released_at)
  await assert.rejects(renew(service, handle), denied)
  assert.notEqual((await acquire(service)).producerGeneration, handle.producerGeneration)
})

dbTest('stale_renewal_is_denied', async ({ service, db }) => {
  const handle = await acquire(service)
  for (const altered of [{ demandOwnerId: Buffer.alloc(32, 3).toString('base64url') }, { sessionBindingHash: `v1:${'0'.repeat(64)}` }, { producerGeneration: '999' }, { physicalCameraId: 2 }, { logicalCameraId: 'CAM-02' }, { userId: 2 }, { nodeId: 'node-b' }]) {
    await assert.rejects(renew(service, { ...handle, ...altered }), denied)
    await service.release({ ...handle, ...altered })
  }
  await assert.rejects(service.renew({ handle, access: access(), sessionBinding: Buffer.alloc(32, 3).toString('base64url') }), denied)
  await assert.rejects(renew(createProducerLifecycle({ secret: 'rotated-key', transact: async () => assert.fail('wrong session must fail before DB') }), handle), denied)
  assert.equal((await db.query('SELECT released_at FROM camera_producer_demands')).rows[0].released_at, null)
  await renew(service, handle)
})

dbTest('historical_null_viewer_cannot_keep_epoch_or_renew', async ({ service, db }) => {
  const old = await acquire(service)
  await db.query('UPDATE camera_producer_demands SET viewer_user_id = NULL')
  await assert.rejects(renew(service, old), denied)
  const fresh = await acquire(service)
  assert.notEqual(fresh.producerGeneration, old.producerGeneration)
  assert.equal((await db.query('SELECT * FROM camera_producer_demands WHERE viewer_user_id IS NULL')).rowCount, 1)
})

dbTest('generation_beyond_js_safe_integer_is_exact', async ({ service, db }) => {
  await db.query('ALTER TABLE camera_producer_epochs ALTER COLUMN producer_generation RESTART WITH 9007199254740993')
  const handle = await acquire(service)
  assert.equal(handle.producerGeneration, '9007199254740993')
  await renew(service, handle)
  await service.release(handle)
})

dbTest('random_owner_collision_rolls_back_without_releasing_existing_authority', async ({ transact, db }) => {
  const service = createProducerLifecycle({ secret, transact, randomBytes: () => Buffer.alloc(32, 5) })
  const handle = await acquire(service)
  await assert.rejects(acquire(service), error => error.status === 503)
  assert.equal((await db.query('SELECT * FROM camera_producer_demands')).rowCount, 1)
  await renew(service, handle)
})

// Barriers use actual PostgreSQL blocked-PID evidence, not timing as a proxy for locks.
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function waitForBarrier(promise) {
  let timer
  try {
    await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('lifecycle did not reach controlled barrier')), 5000)
    })])
  } finally { clearTimeout(timer) }
}
async function waitForBlock(db, blocked, blocker) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const { rows } = await db.query('SELECT $2::int = ANY(pg_blocking_pids($1)) AS blocked', [blocked, blocker])
    if (rows[0].blocked) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`expected transaction ${blocked} blocked by ${blocker}`)
}

for (const operation of ['acquire', 'renew']) {
  dbTest(`${operation}_lock_wait_cannot_use_transaction_start_to_revive_expired_lease`, async ({ db, connect, transact, service }) => {
    const old = await acquire(service)
    // Both leases expire while the lifecycle transaction waits for authority.
    await db.query(`WITH expiry AS (SELECT clock_timestamp() + interval '1 second' AS at),
      epoch AS (UPDATE camera_producer_epochs SET lease_expires_at = (SELECT at FROM expiry))
      UPDATE camera_producer_demands SET lease_expires_at = (SELECT at FROM expiry)`)
    const blocker = await connect()
    await blocker.query('BEGIN')
    await blocker.query('SELECT * FROM physical_cameras WHERE physical_camera_id = 1 FOR UPDATE')
    const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const started = deferred()
    let lifecyclePid
    let observedClocks
    const guarded = createProducerLifecycle({ secret, transact: fn => transact(async client => {
      lifecyclePid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      started.resolve()
      return fn(client)
    }, async client => {
      observedClocks = (await client.query(`SELECT
        lease_expires_at > transaction_timestamp() AS transaction_says_live,
        lease_expires_at > clock_timestamp() AS clock_says_live
        FROM camera_producer_epochs WHERE producer_generation = $1`, [old.producerGeneration])).rows[0]
    }) })
    const running = (operation === 'acquire' ? acquire(guarded) : renew(guarded, old))
      .then(value => ({ value }), error => ({ error }))
    try {
      await waitForBarrier(started.promise)
      await waitForBlock(db, lifecyclePid, blockerPid)
      const deadline = Date.now() + 5000
      while ((await db.query('SELECT lease_expires_at > clock_timestamp() AS live FROM camera_producer_epochs')).rows[0].live) {
        assert.ok(Date.now() < deadline, 'DB lease must expire within bounded wait')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      await blocker.query('COMMIT')
      const result = await running
      assert.deepEqual(observedClocks, { transaction_says_live: true, clock_says_live: false })
      if (operation === 'renew') assert.equal(result.error?.status, 403)
      else {
        assert.ok(result.value)
        assert.notEqual(result.value.producerGeneration, old.producerGeneration)
      }
    } finally {
      await blocker.query('ROLLBACK')
      await running
    }
  })
}

for (const boundary of ['acquire_epoch', 'acquire_last_demand', 'renew_epoch']) {
  dbTest(`${boundary}_expiry_at_write_boundary_is_denied_and_rolled_back`, async ({ db, transact, service }) => {
    const old = await acquire(service)
    // Keep an existing valid demand before the new viewer joins. For the
    // last-demand case only that demand expires; the epoch itself stays live.
    await db.query(`UPDATE camera_producer_epochs SET lease_expires_at = clock_timestamp()
      + interval '${boundary === 'acquire_last_demand' ? '10 seconds' : '1500 milliseconds'}'`)
    await db.query(`UPDATE camera_producer_demands SET lease_expires_at = clock_timestamp()
      + interval '${boundary === 'acquire_last_demand' ? '1500 milliseconds' : '10 seconds'}'`)
    const epochsBefore = (await db.query('SELECT * FROM camera_producer_epochs')).rows
    const demandsBefore = (await db.query('SELECT * FROM camera_producer_demands')).rows
    const entered = deferred()
    const proceed = deferred()
    let paused = false
    let clockAtEntry
    let boundaryRows
    const target = boundary.startsWith('acquire')
      ? /^\s*INSERT INTO camera_producer_demands\b/i
      : /^\s*UPDATE camera_producer_epochs e SET lease_expires_at\b/i
    const guarded = createProducerLifecycle({ secret, transact: fn => transact(client => fn({
      query: async (...args) => {
        const atBoundary = !paused && target.test(args[0])
        if (atBoundary) {
          paused = true
          clockAtEntry = (await client.query(`SELECT
            e.lease_expires_at > clock_timestamp() AS epoch_live,
            EXISTS (SELECT 1 FROM camera_producer_demands d
              WHERE d.producer_generation = e.producer_generation AND d.released_at IS NULL
                AND d.viewer_user_id IS NOT NULL AND d.lease_expires_at > clock_timestamp()) AS demand_live
            FROM camera_producer_epochs e WHERE e.producer_generation = $1`, [old.producerGeneration])).rows[0]
          entered.resolve()
          await proceed.promise
        }
        const result = await client.query(...args)
        if (atBoundary) boundaryRows = result.rowCount
        return result
      },
    })) })
    const running = (boundary.startsWith('acquire') ? acquire(guarded, access('a', 2)) : renew(guarded, old))
      .then(value => ({ value }), error => ({ error }))
    try {
      await waitForBarrier(entered.promise)
      assert.deepEqual(clockAtEntry, { epoch_live: true, demand_live: true })
      const expiredTable = boundary === 'acquire_last_demand' ? 'camera_producer_demands' : 'camera_producer_epochs'
      const deadline = Date.now() + 5000
      while ((await db.query(`SELECT lease_expires_at > clock_timestamp() AS live FROM ${expiredTable}`)).rows[0].live) {
        assert.ok(Date.now() < deadline, 'DB write-boundary lease must expire within bounded wait')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      proceed.resolve()
      const result = await running
      assert.equal(result.error?.status, 403, 'expired authority must not return a handle')
      assert.equal(boundaryRows, 0, 'the guarded write must affect zero rows')
      assert.deepEqual((await db.query('SELECT * FROM camera_producer_epochs')).rows, epochsBefore)
      assert.deepEqual((await db.query('SELECT * FROM camera_producer_demands')).rows, demandsBefore,
        'a rejected renewal must roll back its earlier demand UPDATE')
      const fresh = await acquire(service)
      assert.notEqual(fresh.producerGeneration, old.producerGeneration)
      assert.ok((await db.query('SELECT released_at FROM camera_producer_epochs WHERE producer_generation = $1',
        [old.producerGeneration])).rows[0].released_at)
    } finally {
      proceed.resolve()
      await running
    }
  })
}

const mutations = [
  ['assignment_revocation', "DELETE FROM camera_assignment WHERE camera_id = 'CAM-01'"],
  ['assignment_update', "UPDATE camera_assignment SET user_id = 2 WHERE camera_id = 'CAM-01'"],
  ['account_alias_update', "UPDATE node_account_camera_alias SET logical_camera_id = 'CAM-02' WHERE node_id = 'node-a' AND user_id = 1"],
  ['policy_update', "UPDATE node_camera_alias_policy SET mode = 'fixed', fixed_camera_id = 'CAM-02' WHERE node_id = 'node-a'"],
  ['node_deactivation', "UPDATE detection_nodes SET active = FALSE WHERE node_id = 'node-a'"],
  ['physical_deactivation', 'UPDATE physical_cameras SET active = FALSE WHERE physical_camera_id = 1'],
  ['user_deactivation', 'UPDATE users SET active = FALSE WHERE id = 1'],
  ['key_rotation', "UPDATE detection_nodes SET key_version = 2 WHERE node_id = 'node-a'"],
]

for (const operation of ['acquire', 'renew']) {
  for (const [name, sql] of mutations) {
    for (const first of ['update', 'lifecycle']) {
      dbTest(`${operation}_${name}_${first}_locks_first`, async ({ db, connect, transact, service }) => {
        const handle = operation === 'renew' ? await acquire(service) : null
        const before = (await db.query('SELECT * FROM camera_producer_demands')).rows
        const updater = await connect()
        const updaterPid = (await updater.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        await updater.query('BEGIN')
        const locked = deferred()
        const resume = deferred()
        let lifecyclePid
        let running
        let updating
        try {
          if (first === 'update') await updater.query(sql)
          const raced = createProducerLifecycle({ secret, transact: async fn => {
            return transact(async client => {
              lifecyclePid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
              locked.resolve()
              return fn(client)
            })
          } })
          // For lifecycle-first, signal only once the write barrier is reached.
          if (first === 'lifecycle') {
            const atWrite = deferred()
            const guarded = createProducerLifecycle({ secret, transact: fn => transact(fn, async client => {
              lifecyclePid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
              atWrite.resolve(); await resume.promise
            }) })
            running = (operation === 'acquire' ? acquire(guarded) : renew(guarded, handle)).then(value => ({ value }), error => ({ error }))
            await waitForBarrier(atWrite.promise)
            updating = updater.query(sql)
            await waitForBlock(db, updaterPid, lifecyclePid)
            resume.resolve()
            assert.ok((await running).value)
            await updating
            await updater.query('COMMIT')
            const counts = (await db.query('SELECT count(*)::int AS n FROM camera_producer_demands')).rows[0].n
            assert.equal(counts, 1)
            await assert.rejects(operation === 'acquire' ? acquire(service) : renew(service, handle), denied)
          } else {
            running = (operation === 'acquire' ? acquire(raced) : renew(raced, handle)).then(value => ({ value }), error => ({ error }))
            await waitForBarrier(locked.promise)
            await waitForBlock(db, lifecyclePid, updaterPid)
            await updater.query('COMMIT')
            assert.equal((await running).error?.status, 403)
            assert.deepEqual((await db.query('SELECT * FROM camera_producer_demands')).rows, before)
            assert.equal((await db.query('SELECT * FROM camera_producer_epochs')).rowCount, operation === 'renew' ? 1 : 0)
          }
        } finally {
          resume.resolve()
          await updater.query('ROLLBACK')
          if (running) await running
          if (updating) await updating.catch(() => {})
        }
      })
    }
  }
}
