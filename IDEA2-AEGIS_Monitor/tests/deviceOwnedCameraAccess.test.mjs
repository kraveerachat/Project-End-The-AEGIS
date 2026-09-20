import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CameraAccessError,
  createCameraAccessResolver,
} from '../server/auth/cameraAccess.js'

const operators = Object.freeze({
  operator: { id: 2, username: 'operator', role: 'CCTV-Operator', active: true, mustResetPassword: false },
  operator2: { id: 3, username: 'operator2', role: 'CCTV-Operator', active: true, mustResetPassword: false },
})

const machines = Object.freeze({
  A: { nodeId: 'machine-a-node', physicalCameraId: 41 },
  B: { nodeId: 'machine-b-node', physicalCameraId: 42 },
  C: { nodeId: 'machine-c-node', physicalCameraId: 43 },
})

const expectedAlias = Object.freeze({ operator: 'CAM-01', operator2: 'CAM-02' })

function fixture({ machine = 'A', account = 'operator' } = {}) {
  const selectedMachine = machines[machine]
  const selectedUser = operators[account]
  const state = {
    user: { ...selectedUser },
    node: {
      nodeId: selectedMachine.nodeId,
      keyVersion: 7,
      active: true,
    },
    physical: {
      physicalCameraId: selectedMachine.physicalCameraId,
      nodeId: selectedMachine.nodeId,
      active: true,
    },
    policy: { nodeId: selectedMachine.nodeId, mode: 'account', fixedCameraId: null },
    alias: {
      nodeId: selectedMachine.nodeId,
      userId: selectedUser.id,
      logicalCameraId: expectedAlias[account],
    },
    registryError: null,
  }
  const req = {
    session: {
      user: { ...selectedUser },
      createdAt: Date.now(),
      destroy(callback) { callback?.() },
      nodeSessionBinding: Buffer.alloc(32, selectedMachine.physicalCameraId).toString('base64url'),
      localNode: {
        nodeId: selectedMachine.nodeId,
        physicalCameraId: selectedMachine.physicalCameraId,
        keyVersion: 7,
        verifiedAt: 1_000,
        expiresAt: 301_000,
      },
    },
    body: { nodeId: 'forged-node', physicalCameraId: 999, cameraId: 'CAM-99' },
    query: { nodeId: 'forged-node', physicalCameraId: '999', cameraId: 'CAM-99' },
    headers: {
      'x-aegis-node-id': 'forged-node',
      'x-aegis-physical-camera-id': '999',
      'x-aegis-camera-id': 'CAM-99',
    },
  }
  const maybeThrow = () => {
    if (state.registryError) throw state.registryError
  }
  const resolver = createCameraAccessResolver({
    getUserById: async (id) => { maybeThrow(); return id === state.user?.id ? state.user : null },
    getDetectionNode: async (nodeId) => { maybeThrow(); return nodeId === state.node?.nodeId ? state.node : null },
    getPhysicalCameraForNode: async (nodeId) => { maybeThrow(); return nodeId === state.physical?.nodeId ? state.physical : null },
    getNodeAliasPolicy: async (nodeId) => { maybeThrow(); return nodeId === state.policy?.nodeId ? state.policy : null },
    getNodeAccountAlias: async (nodeId, userId) => {
      maybeThrow()
      return nodeId === state.alias?.nodeId && userId === state.alias?.userId ? state.alias : null
    },
  })
  return { req, resolver, state, machine: selectedMachine, user: selectedUser }
}

async function expectDenied(promise, status, code) {
  await assert.rejects(
    promise,
    (error) => error instanceof CameraAccessError && error.status === status && error.code === code,
  )
}

test('A/B/C x operator/operator2 keeps physical identity machine-based and alias account-based', async () => {
  for (const machine of Object.keys(machines)) {
    for (const account of Object.keys(operators)) {
      const ctx = fixture({ machine, account })
      assert.deepEqual(
        await ctx.resolver.resolveOperatorAccess(ctx.req, expectedAlias[account], 10_000),
        {
          kind: 'verified-node',
          viewerMode: 'demanding',
          userId: ctx.user.id,
          nodeId: ctx.machine.nodeId,
          physicalCameraId: ctx.machine.physicalCameraId,
          logicalCameraId: expectedAlias[account],
        },
      )
    }
  }
})

test('account switching changes only the logical alias while machine authority stays fixed', async () => {
  const first = fixture({ machine: 'C', account: 'operator' })
  const second = fixture({ machine: 'C', account: 'operator2' })
  const operator = await first.resolver.resolveOperatorAccess(first.req, 'CAM-01', 10_000)
  const operator2 = await second.resolver.resolveOperatorAccess(second.req, 'CAM-02', 10_000)
  assert.equal(operator.physicalCameraId, machines.C.physicalCameraId)
  assert.equal(operator2.physicalCameraId, machines.C.physicalCameraId)
  assert.notEqual(operator.logicalCameraId, operator2.logicalCameraId)
})

test('same account on different verified machines resolves each local physical camera', async () => {
  const resolved = []
  for (const machine of Object.keys(machines)) {
    const ctx = fixture({ machine, account: 'operator' })
    resolved.push(await ctx.resolver.resolveOperatorAccess(ctx.req, 'CAM-01', 10_000))
  }
  assert.deepEqual(resolved.map((entry) => entry.physicalCameraId), [41, 42, 43])
  assert.deepEqual(resolved.map((entry) => entry.logicalCameraId), ['CAM-01', 'CAM-01', 'CAM-01'])
})

test('live account role, not the session-cached role, selects the stream authorization path', async () => {
  const promoted = fixture({ account: 'operator' })
  promoted.req.session.user.role = 'SOC-Responder'
  assert.deepEqual(await promoted.resolver.resolveLiveCameraActor(promoted.req), {
    userId: operators.operator.id,
    username: operators.operator.username,
    role: 'CCTV-Operator',
  })

  const demoted = fixture({ account: 'operator' })
  demoted.req.session.user.role = 'CCTV-Operator'
  demoted.state.user = { ...demoted.state.user, role: 'SOC-Responder' }
  assert.deepEqual(await demoted.resolver.resolveLiveCameraActor(demoted.req), {
    userId: operators.operator.id,
    username: operators.operator.username,
    role: 'SOC-Responder',
  })
})

test('browser, heartbeat, and camera_assignment-shaped values cannot override server authority', async () => {
  const ctx = fixture({ machine: 'B', account: 'operator2' })
  ctx.req.heartbeat = { nodeId: 'forged-node', physicalCameraId: 999, cameraId: 'CAM-01' }
  ctx.req.camera_assignment = { userId: 2, cameraId: 'CAM-01' }
  const access = await ctx.resolver.resolveOperatorAccess(ctx.req, 'CAM-02', 10_000)
  assert.equal(access.nodeId, machines.B.nodeId)
  assert.equal(access.physicalCameraId, machines.B.physicalCameraId)
  assert.equal(access.logicalCameraId, 'CAM-02')
})

test('missing association and alias mismatch fail with bounded contracts', async () => {
  const ctx = fixture()
  delete ctx.req.session.localNode
  await expectDenied(
    ctx.resolver.resolveOperatorAccess(ctx.req, 'CAM-01', 10_000),
    403,
    'LOCAL_NODE_ASSOCIATION_REQUIRED',
  )

  const mismatch = fixture({ account: 'operator' })
  await expectDenied(
    mismatch.resolver.resolveOperatorAccess(mismatch.req, 'CAM-02', 10_000),
    403,
    'CAMERA_ALIAS_DENIED',
  )
})

test('live account, Node, key, physical mapping, and account policy are revalidated fail closed', async (t) => {
  const cases = [
    ['missing account', (ctx) => { ctx.state.user = null }, 'LOCAL_NODE_ASSOCIATION_DENIED'],
    ['disabled account', (ctx) => { ctx.state.user.active = false }, 'LOCAL_NODE_ASSOCIATION_DENIED'],
    ['wrong role', (ctx) => { ctx.state.user.role = 'SOC-Responder' }, 'LOCAL_NODE_ASSOCIATION_DENIED'],
    ['disabled node', (ctx) => { ctx.state.node.active = false }, 'LOCAL_NODE_ASSOCIATION_DENIED'],
    ['key rotation', (ctx) => { ctx.state.node.keyVersion = 8 }, 'LOCAL_NODE_ASSOCIATION_DENIED'],
    ['disabled physical camera', (ctx) => { ctx.state.physical.active = false }, 'LOCAL_NODE_ASSOCIATION_DENIED'],
    ['physical remap', (ctx) => { ctx.state.physical.physicalCameraId = 99 }, 'LOCAL_NODE_ASSOCIATION_DENIED'],
    ['wrong policy mode', (ctx) => { ctx.state.policy.mode = 'fixed' }, 'CAMERA_ALIAS_DENIED'],
    ['missing account alias', (ctx) => { ctx.state.alias = null }, 'CAMERA_ALIAS_DENIED'],
  ]
  for (const [name, mutate, code] of cases) {
    await t.test(name, async () => {
      const ctx = fixture()
      mutate(ctx)
      await expectDenied(ctx.resolver.resolveOperatorAccess(ctx.req, 'CAM-01', 10_000), 403, code)
    })
  }

  const unavailable = fixture()
  unavailable.state.registryError = new Error('database detail must not escape')
  await expectDenied(
    unavailable.resolver.resolveOperatorAccess(unavailable.req, 'CAM-01', 10_000),
    503,
    'LOCAL_NODE_REGISTRY_UNAVAILABLE',
  )
})
