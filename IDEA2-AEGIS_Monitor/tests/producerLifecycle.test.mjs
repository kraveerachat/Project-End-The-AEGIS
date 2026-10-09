import assert from 'node:assert/strict'
import test from 'node:test'
import { hashProducerSessionBinding } from '../server/auth/demandSessionHash.js'
import { createProducerLifecycle } from '../server/db/producerLifecycle.js'
import * as lifecycleContract from '../server/db/producerLifecycle.js'
import { createCameraAccessResolver } from '../server/auth/cameraAccess.js'

const secret = 'fixture-session-secret-32-bytes-long!!!'
const binding = 'ERERERERERERERERERERERERERERERERERERERERERE'

test('lease_and_route_timing_constants_match_the_fixed_server_contract', () => {
  assert.deepEqual([
    lifecycleContract.PRODUCER_LEASE_MS, lifecycleContract.DEMAND_LEASE_MS,
    lifecycleContract.STREAM_REVALIDATE_MS, lifecycleContract.RENEW_BEFORE_MS,
  ], [30_000, 30_000, 10_000, 20_000])
})

// Catches using unkeyed hashing, encoded text rather than decoded bytes, or a wrong domain.
test('hash_binding_matches_v1_vector', () => {
  assert.equal(hashProducerSessionBinding(binding, secret),
    'v1:3ea22f47d36d9f663887968c05f7f8114993867dbb408c261fae83086f295c8b')
})

test('hash_binding_rejects_noncanonical_or_missing_input', () => {
  for (const value of [undefined, '', Buffer.alloc(31).toString('base64url'), `${binding}=`, `${binding.slice(0, -1)}F`]) {
    assert.throws(() => hashProducerSessionBinding(value, secret), TypeError)
  }
  for (const key of [undefined, '', null, 42]) {
    assert.throws(() => hashProducerSessionBinding(binding, key), TypeError)
  }
})

test('hash_binding_is_keyed_and_redacted', (t) => {
  const logs = []
  for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, (...args) => logs.push(args.join(' ')))
  const hash = hashProducerSessionBinding(binding, secret)
  assert.match(hash, /^v1:[0-9a-f]{64}$/)
  assert.notEqual(hashProducerSessionBinding(binding, `${secret}!`), hash)
  assert.notEqual(hashProducerSessionBinding(Buffer.alloc(32, 0x22).toString('base64url'), secret), hash)
  try { hashProducerSessionBinding(`${binding}=`, secret) } catch (error) { logs.push(String(error)) }
  assert.ok(!logs.join('\n').includes(binding))
  assert.ok(!logs.join('\n').includes(secret))
})

const access = { userId: 1, nodeId: 'node-a', physicalCameraId: 1, logicalCameraId: 'CAM-01', keyVersion: 1 }

test('invalid_authority_and_binding_fail_before_transaction', async () => {
  const service = createProducerLifecycle({ secret, transact: () => assert.fail('must not reach DB') })
  for (const badAccess of [null, { ...access, keyVersion: undefined }, { ...access, physicalCameraId: -1 }, { ...access, userId: 1.5 }]) {
    await assert.rejects(service.acquire({ access: badAccess, sessionBinding: binding }))
  }
  await assert.rejects(service.acquire({ access, sessionBinding: 'invalid' }))
  await assert.rejects(service.renew({ handle: {}, access, sessionBinding: binding }))
})

test('database_failure_is_fail_closed_and_redacted', async () => {
  const service = createProducerLifecycle({ secret, transact: async () => { throw new Error(`${binding} ${secret}`) } })
  await assert.rejects(service.acquire({ access, sessionBinding: binding }), (error) => {
    assert.equal(error.status, 503)
    assert.ok(!String(error).includes(binding))
    assert.ok(!String(error).includes(secret))
    return true
  })
})

test('resolved_access_carries_server_verified_key_version', async () => {
  const user = { id: 1, username: 'operator', role: 'CCTV-Operator', active: true }
  const resolver = createCameraAccessResolver({
    getCurrentUser: () => user, getUserById: async () => user,
    getCurrentLocalNode: () => ({ nodeId: 'node-a', physicalCameraId: 1, keyVersion: 7 }),
    getDetectionNode: async () => ({ nodeId: 'node-a', active: true, keyVersion: 7 }),
    getPhysicalCameraForNode: async () => ({ nodeId: 'node-a', active: true, physicalCameraId: 1 }),
    getNodeAliasPolicy: async () => ({ nodeId: 'node-a', mode: 'account', fixedCameraId: null }),
    getNodeAccountAlias: async () => ({ nodeId: 'node-a', userId: 1, logicalCameraId: 'CAM-01' }),
  })
  assert.equal((await resolver.resolveOperatorAccess({}, 'CAM-01')).keyVersion, 7)
})
