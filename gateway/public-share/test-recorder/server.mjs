// Test-only Drive stand-in. It has no AEGIS data, authorization, or secret.
import { createServer } from 'node:http'

const state = { count: 0, requests: [] }
const json = (res, status, value) => {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

createServer((req, res) => {
  if (req.url === '/__test/health') return json(res, 200, { ok: true })
  if (req.url === '/__test/state') return json(res, 200, state)
  if (req.url === '/__test/reset' && req.method === 'POST') {
    state.count = 0
    state.requests = []
    return json(res, 200, state)
  }

  let bodyLength = 0
  req.on('data', (chunk) => {
    bodyLength += chunk.length
    if (bodyLength > 64 * 1024) req.destroy()
  })
  req.on('end', () => {
    const request = {
      method: req.method,
      path: req.url,
      headers: { ...req.headers },
      bodyLength,
    }
    state.count += 1
    state.requests.push(request)
    if (state.requests.length > 200) state.requests.shift()
    json(res, 200, request)
  })
}).listen(8001, '0.0.0.0', () => {
  console.log('[public-share-test-recorder] listening on network-only port 8001')
})
