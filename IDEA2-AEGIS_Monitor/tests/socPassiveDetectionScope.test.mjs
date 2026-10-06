import test from 'node:test'
import assert from 'node:assert/strict'
import { listDetectionsForPhysicalView } from '../server/db/store.js'

test('view-scoped detections bind alias, physical camera, exact BIGINT generation and Node server-side', async () => {
  const generation = '9007199254740993'
  const calls = []
  const result = await listDetectionsForPhysicalView({ cameraId: 'CAM-01', physicalCameraId: 41,
    producerGeneration: generation, nodeId: 'machine-a' }, {
    postgresEnabled: true,
    executeQuery: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: [{ frame_id: 'frame-a', camera_id: 'CAM-01', at_ms: 1000,
        result: 'Authorized', matched_name: 'Alice', confidence: 97.5, synced_to_nas: true }] }
    },
  })
  assert.equal(calls.length, 1)
  assert.match(calls[0].sql, /JOIN camera_producer_epochs/i)
  assert.match(calls[0].sql, /physical_camera_id/i)
  assert.match(calls[0].sql, /producer_generation/i)
  assert.match(calls[0].sql, /node_id/i)
  assert.deepEqual(calls[0].params, ['CAM-01', 41, generation, 'machine-a', 40 * 8])
  assert.deepEqual(result, [{ id: 'frame-a', at: 1000, cam: 'CAM-01',
    people: [{ k: 'auth', name: 'Alice', conf: 98 }], syncedToNas: true }])
  assert.equal('physicalCameraId' in result[0], false)
  assert.equal('producerGeneration' in result[0], false)
})
