// TEST ONLY. Actual App/Live/LiveFeed + controlled API responses and real HTTP
// multipart connections. No production services, authentication or webcams.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { deflateSync } from 'node:zlib'

// Keep interactive preview (15176) separate from automated-test traffic.
const port = Number(process.env.CAMERA_SELECTOR_FIXTURE_PORT || 15176)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid fixture port')

const allCameras = [
  { id: 'entry-z', name: 'Test main entrance', res: '1280×720', online: true },
  { id: 'CAM-02', name: 'Test parking', res: '1280×720', online: true },
  { id: 'offline-7', name: 'Test reception', online: false },
  { id: 'extra-8', name: 'Test side entrance', online: false },
  { id: 'restricted-9', name: 'Restricted fixture camera', online: true },
]
let scenario = 'normal'
let offline = false
let expired = false
let opened = []
let closed = []
const active = new Map()
let counter = 0
const assigned = () => scenario === 'empty' ? [] : allCameras.slice(0, scenario === 'two-cameras' ? 2 : 4)
// Moving test patterns prove the thumbnail is live, not a cached screenshot.
// These generated pixels are fixtures only; no real camera images are read.
function pngChunk(type, bytes) {
  const data = Buffer.concat([Buffer.from(type), bytes])
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length)
  const check = Buffer.alloc(4); check.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([size, data, check])
}
function testPattern(cameraIndex, phase) {
  const width = 160, height = 90
  const colors = [[36, 196, 220], [146, 116, 230], [225, 170, 55], [74, 191, 129]]
  const color = colors[cameraIndex % colors.length]
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const bar = x >= phase * 18 && x < phase * 18 + 24 && y >= 20 && y < 70
    const pixel = bar ? color : [8, 14, 24]
    const offset = y * (width * 3 + 1) + 1 + x * 3
    raw[offset] = pixel[0]; raw[offset + 1] = pixel[1]; raw[offset + 2] = pixel[2]
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4)
  header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
}
const patterns = allCameras.map((_, index) => Array.from({ length: 8 }, (_, phase) => testPattern(index, phase)))
function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}
function handler(req, res, next) {
  const url = new URL(req.url, 'http://127.0.0.1:15176')
  if (url.pathname === '/__fixture/reset') {
    for (const { response } of active.values()) response.destroy()
    opened = []; closed = []; offline = false; expired = false
    scenario = url.searchParams.get('scenario') || 'normal'
    return json(res, { ok: true })
  }
  if (url.pathname === '/__fixture/offline') { offline = true; return json(res, { ok: true }) }
  if (url.pathname === '/__fixture/expire') { expired = true; return json(res, { ok: true }) }
  if (url.pathname === '/__fixture/stats') {
    return json(res, { opened, closed, active: [...active.values()].map(x => x.id) })
  }
  if (!url.pathname.startsWith('/monitor/api/')) return next()
  const path = url.pathname.slice('/monitor'.length)
  if (expired) return json(res, { error: 'Unauthenticated' }, 401)
  if (path === '/api/me') return json(res, {
    user: { username: 'fixture-user', displayName: scenario === 'two-cameras' ? 'Test SOC' : 'Test Operator',
      role: scenario === 'two-cameras' ? 'SOC-Responder' : 'CCTV-Operator' },
    menu: [{ id: 'live', group: 'navObservation' }, { id: 'settings', group: 'navPreferences' }],
  })
  if (path === '/api/cameras') return json(res, { cameras: assigned() })
  if (path === '/api/link') return json(res, {
    status: 'online', lastFrameAt: Date.now(),
    cameras: assigned().map((camera, i) => ({
      cam: camera.id, hasStream: (i < 2 || scenario === 'all-streams') && !offline,
      status: scenario === 'idle' || i > 1 || offline ? 'lost' : 'online',
      cameraConnected: scenario !== 'idle' && i < 2 && !offline,
      captureFps: i < 2 && !offline ? 12 : 0,
    })),
  })
  if (path === '/api/detections') return json(res, { detections: [
    { id: 'event-entry', cam: 'entry-z', at: Date.now() - 2000, people: [{ k: 'auth', name: 'Fixture Alice', conf: 97 }] },
    { id: 'event-parking', cam: 'CAM-02', at: Date.now() - 1000, people: [{ k: 'auth', name: 'Fixture Bob', conf: 93 }] },
    ...(scenario === 'unknown' ? [{ id: 'event-unknown', cam: 'entry-z', at: Date.now(), people: [{ k: 'unk', name: 'Unknown', conf: 88 }] }] : []),
    // Deliberately hostile response verifies the view never leaks other context.
    { id: 'event-hidden', cam: 'restricted-9', at: Date.now(), people: [{ k: 'auth', name: 'Hidden Person', conf: 99 }] },
  ] })
  const match = path.match(/^\/api\/cameras\/([^/]+)\/stream$/)
  if (match) {
    const id = decodeURIComponent(match[1])
    if (!assigned().some(camera => camera.id === id)) return json(res, { error: 'Forbidden' }, 403)
    opened.push(id)
    if (scenario === 'error' && id === 'entry-z') return json(res, { error: 'Fixture failure' }, 503)
    const key = ++counter
    active.set(key, { id, response: res })
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-store',
    })
    const frame = () => {
      const png = patterns[allCameras.findIndex(camera => camera.id === id)][Math.floor(Date.now() / 250) % 8]
      res.write('--frame\r\nContent-Type: image/png\r\nContent-Length: ' + png.length + '\r\n\r\n')
      res.write(png)
      res.write('\r\n')
    }
    frame()
    const timer = setInterval(frame, 100)
    res.on('close', () => { clearInterval(timer); active.delete(key); closed.push(id) })
    return
  }
  return json(res, {})
}
const vite = await createServer({
  configFile: false, base: '/monitor/',
  define: { __APP_VERSION__: JSON.stringify('test-fixture') },
  plugins: [react(), tailwindcss(), { name: 'isolated-camera-fixture', configureServer(server) { server.middlewares.use(handler) } }],
  server: { host: '127.0.0.1', port, strictPort: true },
})
await vite.listen()
