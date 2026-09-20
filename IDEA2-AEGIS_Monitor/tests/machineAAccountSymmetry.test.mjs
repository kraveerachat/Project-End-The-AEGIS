import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import * as api from '../server/routes/api.js'

const physicalSource = {
  nodeId: 'machine-a-node',
  url: 'http://127.0.0.1:8077/stream.mjpg',
  ageMs: 1_000,
  cameraConnected: false,
}

test('one physical heartbeat advertises both account aliases without logical heartbeat rows', async () => {
  assert.equal(typeof api.resolveOperatorPhysicalLinkStatus, 'function')

  const physicalLookups = []
  const resolveOperatorCameraAccess = async (req) => ({
    kind: 'verified-node',
    viewerMode: 'demanding',
    userId: req.userId,
    nodeId: 'machine-a-node',
    physicalCameraId: 41,
    logicalCameraId: req.userId === 2 ? 'CAM-01' : 'CAM-02',
  })
  const streamSourceForPhysicalCamera = async (physicalCameraId) => {
    physicalLookups.push(physicalCameraId)
    return physicalSource
  }

  const operator = await api.resolveOperatorPhysicalLinkStatus(
    { userId: 2 }, 10_000,
    { resolveOperatorCameraAccess, streamSourceForPhysicalCamera },
  )
  const operator2 = await api.resolveOperatorPhysicalLinkStatus(
    { userId: 3 }, 11_000,
    { resolveOperatorCameraAccess, streamSourceForPhysicalCamera },
  )

  assert.deepEqual(physicalLookups, [41, 41])
  assert.equal(operator.cameras[0].cam, 'CAM-01')
  assert.equal(operator2.cameras[0].cam, 'CAM-02')
  assert.equal(operator.cameras[0].hasStream, true)
  assert.equal(operator2.cameras[0].hasStream, true)
  assert.equal(operator.cameras[0].cameraConnected, false)
  assert.equal(operator2.cameras[0].cameraConnected, false)
})

test('account switching changes only logical alias and never physical heartbeat identity', async () => {
  assert.equal(typeof api.resolveOperatorPhysicalLinkStatus, 'function')

  const physicalLookups = []
  const deps = {
    resolveOperatorCameraAccess: async (req) => ({
      kind: 'verified-node', viewerMode: 'demanding', userId: 2,
      nodeId: 'machine-a-node', physicalCameraId: 41, logicalCameraId: req.logicalCameraId,
    }),
    streamSourceForPhysicalCamera: async (physicalCameraId) => {
      physicalLookups.push(physicalCameraId)
      return physicalSource
    },
  }

  for (const logicalCameraId of ['CAM-01', 'CAM-02', 'CAM-01']) {
    const link = await api.resolveOperatorPhysicalLinkStatus(
      { logicalCameraId }, 20_000, deps,
    )
    assert.equal(link.cameras[0].cam, logicalCameraId)
  }

  assert.deepEqual(physicalLookups, [41, 41, 41])
})

test('missing or stale physical availability fails closed without logical fallback', async () => {
  assert.equal(typeof api.resolveOperatorPhysicalLinkStatus, 'function')

  const logicalHeartbeat = {
    url: 'http://logical-heartbeat.invalid/stream.mjpg',
    ageMs: 0,
    cameraConnected: true,
  }
  const resolveOperatorCameraAccess = async () => ({
    kind: 'verified-node', viewerMode: 'demanding', userId: 2,
    nodeId: 'machine-a-node', physicalCameraId: 41, logicalCameraId: 'CAM-01',
  })

  for (const source of [null, { ...physicalSource, ageMs: 45_001 }]) {
    const link = await api.resolveOperatorPhysicalLinkStatus(
      { logicalHeartbeat }, 50_000,
      {
        resolveOperatorCameraAccess,
        streamSourceForPhysicalCamera: async () => source,
      },
    )
    assert.equal(link.status, 'lost')
    assert.equal(link.cameras[0].hasStream, false)
  }
})

test('fresh heartbeat left by a previous node mapping fails closed after remap', async () => {
  const link = await api.resolveOperatorPhysicalLinkStatus({}, 50_000, {
    resolveOperatorCameraAccess: async () => ({
      kind: 'verified-node', viewerMode: 'demanding', userId: 2,
      nodeId: 'machine-a-node', physicalCameraId: 41, logicalCameraId: 'CAM-01',
    }),
    streamSourceForPhysicalCamera: async () => ({
      ...physicalSource,
      nodeId: 'machine-b-node',
      ageMs: 0,
    }),
  })

  assert.equal(link.status, 'lost')
  assert.equal(link.cameras[0].hasStream, false)
  assert.equal(link.cameras[0].cameraConnected, false)
})

test('invalid verified-node provenance is denied before availability lookup', async () => {
  assert.equal(typeof api.resolveOperatorPhysicalLinkStatus, 'function')

  let physicalLookups = 0
  await assert.rejects(
    api.resolveOperatorPhysicalLinkStatus({}, 60_000, {
      resolveOperatorCameraAccess: async () => {
        const error = new Error('LOCAL_NODE_ASSOCIATION_DENIED')
        error.code = 'LOCAL_NODE_ASSOCIATION_DENIED'
        throw error
      },
      streamSourceForPhysicalCamera: async () => {
        physicalLookups += 1
        return physicalSource
      },
    }),
    (error) => error.code === 'LOCAL_NODE_ASSOCIATION_DENIED',
  )
  assert.equal(physicalLookups, 0)
})

test('strict link route advertises physical availability and keeps legacy logical status bounded', () => {
  const source = fs.readFileSync(new URL('../server/routes/api.js', import.meta.url), 'utf8')
  const start = source.indexOf("apiRouter.get('/link'")
  const end = source.indexOf("apiRouter.post('/link/outage'", start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const route = source.slice(start, end)

  assert.match(route, /REQUIRE_LOCAL_NODE_ASSOCIATION/)
  assert.match(route, /resolveLiveCameraActor\(req\)/)
  assert.match(route, /actor\.role === ROLES\.OPERATOR/)
  assert.match(route, /resolveOperatorPhysicalLinkStatus/)
  assert.match(route, /store\.linkStatus/)
  const strictBranch = route.slice(
    route.indexOf('if (actor.role === ROLES.OPERATOR)'),
    route.indexOf('res.json(await store.linkStatus'),
  )
  assert.doesNotMatch(strictBranch, /getVisibleCameras/)
})
