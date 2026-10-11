import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { MjpegPartFramer, PassiveLiveRegistry } from '../server/passiveLiveRegistry.js'

const contentType = 'multipart/x-mixed-replace; boundary=frame'
const part = jpeg => Buffer.concat([
  Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`),
  Buffer.from(jpeg), Buffer.from('\r\n'),
])
const source = (registry, overrides = {}) => registry.register({
  logicalCameraId: 'CAM-01', nodeId: 'machine-a', physicalCameraId: 1,
  producerGeneration: '9007199254740993', contentType, ...overrides,
})

class ResponseSink extends EventEmitter {
  constructor({ slow = false } = {}) {
    super()
    this.parts = []
    this.slow = slow
    this.destroyed = false
    this.writableEnded = false
  }
  write(bytes) { this.parts.push(Buffer.from(bytes)); return !this.slow }
  end() { this.writableEnded = true; this.emit('close') }
  destroy() { this.destroyed = true; this.emit('close') }
}

test('arbitrary upstream chunks yield only complete MJPEG parts, including a split boundary', () => {
  const framer = new MjpegPartFramer(contentType)
  const first = part(Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9]))
  const second = part(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  const bytes = Buffer.concat([first, second])
  const observed = []
  for (const byte of bytes) framer.push(Buffer.from([byte]), complete => observed.push(Buffer.from(complete)))
  assert.deepEqual(observed, [first, second])
})

test('one upstream chunk may contain multiple individually bounded large parts', () => {
  const framer = new MjpegPartFramer(contentType)
  const first = part(Buffer.alloc(1200 * 1024, 0x31))
  const second = part(Buffer.alloc(1200 * 1024, 0x32))
  const observed = []
  framer.push(Buffer.concat([first, second]), complete => observed.push(Buffer.from(complete)))
  assert.deepEqual(observed, [first, second])
})

test('SOC joining mid-part waits for the next complete boundary; no JPEG suffix leaks', () => {
  const registry = new PassiveLiveRegistry()
  const upstream = source(registry)
  const first = part(Buffer.from('first'))
  upstream.publish(first.subarray(0, first.length - 2))
  const soc = new ResponseSink()
  assert.equal(upstream.subscribe(soc), true)
  assert.equal(soc.parts.length, 0)
  upstream.publish(Buffer.concat([first.subarray(first.length - 2), part(Buffer.from('second'))]))
  assert.deepEqual(soc.parts, [first, part(Buffer.from('second'))])
  upstream.close()
})

test('same alias on two Nodes has distinct opaque views; two aliases may share one physical generation', () => {
  const registry = new PassiveLiveRegistry()
  const a = source(registry)
  const b = source(registry, { nodeId: 'machine-b', physicalCameraId: 2 })
  const alias = source(registry, { logicalCameraId: 'CAM-02' })
  const views = registry.list()
  assert.equal(views.length, 3)
  assert.equal(new Set(views.map(view => view.viewId)).size, 3)
  assert.deepEqual(views.map(view => [view.cameraId, view.nodeId]), [
    ['CAM-01', 'machine-a'], ['CAM-01', 'machine-b'], ['CAM-02', 'machine-a'],
  ])
  for (const view of views) {
    assert.equal('physicalCameraId' in view, false)
    assert.equal('producerGeneration' in view, false)
  }
  assert.equal(registry.get('forged'), null)
  const aViewer = new ResponseSink()
  const bViewer = new ResponseSink()
  const aliasViewer = new ResponseSink()
  assert.equal(a.subscribe(aViewer), true)
  assert.equal(b.subscribe(bViewer), true)
  assert.equal(alias.subscribe(aliasViewer), true)
  a.publish(part(Buffer.from('node-a-cam-01')))
  b.publish(part(Buffer.from('node-b-cam-01')))
  alias.publish(part(Buffer.from('node-a-cam-02')))
  assert.deepEqual(aViewer.parts, [part(Buffer.from('node-a-cam-01'))])
  assert.deepEqual(bViewer.parts, [part(Buffer.from('node-b-cam-01'))])
  assert.deepEqual(aliasViewer.parts, [part(Buffer.from('node-a-cam-02'))])
  a.close()
  assert.equal(registry.get(a.viewId), null)
  assert.equal(registry.get(b.viewId), b)
  alias.close(); b.close()
})

test('bounded slow SOC skips frames while backpressured, then disconnects without closing Operator', async () => {
  const registry = new PassiveLiveRegistry({ drainTimeoutMs: 20 })
  const upstream = source(registry)
  const slow = new ResponseSink({ slow: true })
  const fast = new ResponseSink()
  upstream.subscribe(slow)
  upstream.subscribe(fast)
  upstream.publish(part(Buffer.from('one')))
  upstream.publish(part(Buffer.from('two')))
  assert.equal(slow.writableEnded, false, 'a transient backpressure signal must not disconnect a fast-draining viewer')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(slow.destroyed, true, 'a blocked socket must be force-closed, not queued behind buffered bytes')
  assert.equal(fast.writableEnded, false)
  assert.equal(fast.parts.length, 2)
  assert.equal(upstream.active, true)
  assert.equal(registry.viewerCount, 1)
  upstream.close()
  assert.equal(registry.viewerCount, 0)
})

test('final Operator source close hard-disconnects a blocked SOC socket immediately', () => {
  const registry = new PassiveLiveRegistry({ drainTimeoutMs: 2000 })
  const upstream = source(registry)
  const blocked = new ResponseSink({ slow: true })
  upstream.subscribe(blocked)
  upstream.publish(part(Buffer.from('frame')))
  upstream.close()
  assert.equal(blocked.destroyed, true)
  assert.equal(registry.viewerCount, 0)
})
