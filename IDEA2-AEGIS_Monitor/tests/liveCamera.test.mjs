import test from 'node:test'
import assert from 'node:assert/strict'
import { selectedCamera, cameraDetections, cameraHeartbeat, cameraStatus } from '../src/lib/liveCamera.js'

const cameras = [{ id: 'entry-z', name: 'Entry' }, { id: 'CAM-02', name: 'Parking' }]
test('selection follows server order, preserves valid choice, rejects unknown/revoked choice', () => {
  assert.equal(selectedCamera(cameras, null), cameras[0])
  assert.equal(selectedCamera(cameras, 'CAM-02'), cameras[1])
  assert.equal(selectedCamera(cameras, 'unassigned'), cameras[0])
  assert.equal(selectedCamera(cameras.slice(1), 'entry-z'), cameras[1])
  assert.equal(selectedCamera([], 'entry-z'), null)
  assert.equal(selectedCamera(null, null), null)
})
test('camera context filters and orders detections without mutating the shared feed', () => {
  const events = [{ cam: 'entry-z', at: 1 }, { cam: 'CAM-02', at: 3 }, { cam: 'entry-z', at: 2 }]
  assert.deepEqual(cameraDetections(events, 'entry-z').map(e => e.at), [2, 1])
  assert.equal(events[0].at, 1)
  assert.deepEqual(cameraDetections(events, 'other'), [])
})
test('availability uses the selected server heartbeat, not another camera or static online flags', () => {
  const beat = { cam: 'entry-z', hasStream: true, cameraConnected: false, status: 'lost' }
  assert.equal(cameraHeartbeat({ cameras: [beat] }, 'entry-z'), beat)
  assert.equal(cameraHeartbeat({ cameras: [beat] }, 'other'), null)
  // A viewer-demand backend can offer a stream while capture is idle.
  assert.equal(cameraStatus(beat), 'Online')
  assert.equal(cameraStatus(beat, 'connecting'), 'Connecting')
  assert.equal(cameraStatus(beat, 'live'), 'Live')
  assert.equal(cameraStatus(beat, 'error'), 'Reconnecting')
  assert.equal(cameraStatus({ hasStream: false }, 'live'), 'Offline')
  assert.equal(cameraStatus(null), 'Offline')
})
