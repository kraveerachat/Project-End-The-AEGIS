import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { register } from 'node:module'

const scenario = process.argv[2] ?? 'idle'
const allowedScenarios = new Set(['normal', 'idle', 'response-close-race', 'revalidation-race'])
assert.equal(allowedScenarios.has(scenario), true, `unknown scenario: ${scenario}`)
const streamIdleMs = scenario === 'normal' ? 1_000 : 25
const streamRevalidateMs = scenario === 'revalidation-race' ? 25 : 10_000

register(new URL('./streamAbortCrashLoader.mjs', import.meta.url), {
  data: { streamIdleMs, streamRevalidateMs },
})

let cancelCalls = 0
let readCalls = 0
let sessionReloadCalls = 0
let clientCloseRequested = false
let rejectPendingRead
const pendingRead = new Promise((resolve, reject) => {
  rejectPendingRead = reject
})

const reader = {
  read() {
    readCalls += 1
    if (readCalls === 1) {
      return Promise.resolve({
        value: new TextEncoder().encode('--frame\r\nContent-Type: image/jpeg\r\n\r\nframe\r\n'),
        done: false,
      })
    }
    if (scenario === 'normal') return Promise.resolve({ value: undefined, done: true })
    return pendingRead
  },
  cancel() {
    cancelCalls += 1
    const error = new DOMException('This operation was aborted', 'AbortError')
    if (scenario !== 'normal') rejectPendingRead(error)
    return Promise.reject(error)
  },
}

globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  headers: new Headers({ 'content-type': 'multipart/x-mixed-replace; boundary=frame' }),
  body: { getReader: () => reader },
})

const express = (await import('express')).default
const { apiRouter } = await import('../../server/routes/api.js')
const app = express()

app.use((req, res, next) => {
  req.session = {
    createdAt: Date.now(),
    user: {
      id: 1,
      username: 'operator',
      displayName: 'Operator',
      role: 'CCTV-Operator',
      mustResetPassword: false,
    },
    reload(callback) {
      sessionReloadCalls += 1
      callback(scenario === 'revalidation-race' ? new Error('session expired') : null)
    },
    destroy(callback) { callback?.() },
  }
  next()
})
app.use('/api', apiRouter)

const server = app.listen(0, '127.0.0.1')
await once(server, 'listening')
const { port } = server.address()

const response = await new Promise((resolve, reject) => {
  const request = http.get(`http://127.0.0.1:${port}/api/cameras/CAM-01/stream`, resolve)
  request.once('error', reject)
})
assert.equal(response.statusCode, 200)
let bytesReceived = 0
response.on('data', (chunk) => { bytesReceived += chunk.length })
response.resume()
if (scenario === 'response-close-race') {
  const closed = once(response, 'close')
  setTimeout(() => {
    clientCloseRequested = true
    response.destroy()
  }, streamIdleMs)
  await closed
} else {
  await once(response, 'end')
}
await new Promise((resolve) => setImmediate(resolve))

await new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve())
})

console.log(`CANCEL_CALLS=${cancelCalls}`)
console.log(`READ_CALLS=${readCalls}`)
console.log(`SESSION_RELOAD_CALLS=${sessionReloadCalls}`)
console.log(`CLIENT_CLOSE_REQUESTED=${clientCloseRequested ? 'YES' : 'NO'}`)
console.log(`BYTES_RECEIVED=${bytesReceived}`)
console.log('MONITOR_SURVIVED=YES')
