import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let vite
let apiUpload
let setCsrfToken

before(async () => {
  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
  })
  ;({ apiUpload, setCsrfToken } = await vite.ssrLoadModule('/src/lib/api.js'))
})

after(async () => {
  await vite?.close()
  delete globalThis.XMLHttpRequest
})

test('apiUpload reports browser upload progress from real loaded/total byte events', async () => {
  let request
  class FakeXhr {
    constructor() {
      request = this
      this.upload = {}
      this.headers = {}
      this.status = 0
      this.responseText = ''
    }
    open(method, url) { this.method = method; this.url = url }
    setRequestHeader(name, value) { this.headers[name] = value }
    send(body) {
      this.body = body
      queueMicrotask(() => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 256, total: 1024 })
        this.upload.onprogress?.({ lengthComputable: true, loaded: 1024, total: 1024 })
        this.status = 201
        this.responseText = JSON.stringify({ file: { id: 'real-upload' } })
        this.onload?.()
      })
    }
    abort() { this.onabort?.() }
  }
  globalThis.XMLHttpRequest = FakeXhr
  setCsrfToken('csrf-progress-test')

  const form = new FormData()
  form.append('file', new Blob(['payload']), 'payload.bin')
  const progress = []
  const result = await apiUpload('/api/files/upload', {
    method: 'POST',
    body: form,
    onProgress: (event) => progress.push(event),
  })

  assert.equal(result.ok, true)
  assert.equal(result.status, 201)
  assert.equal(request.withCredentials, true)
  assert.equal(request.headers['X-CSRF-Token'], 'csrf-progress-test')
  assert.equal(request.body, form)
  assert.deepEqual(progress, [
    { loadedBytes: 256, totalBytes: 1024, percent: 25 },
    { loadedBytes: 1024, totalBytes: 1024, percent: 100 },
  ])
})

test('Uploads renders only measured byte progress and contains no stage percentages', async () => {
  // ⚠️ เดิมยืนยันว่าจอเรียก apiUpload ตรง ๆ — เส้นทาง V2 ย้ายการเรียกนั้นไปที่
  //    src/lib/chunkedUpload.js (หนึ่ง apiUpload ต่อหนึ่ง chunk) สัญญาที่ต้องคงไว้จึงเป็น
  //    "เปอร์เซ็นต์มาจาก byte event ที่วัดได้จริง" ไม่ใช่ชื่อของฟังก์ชันที่จอเรียก
  const [screen, uploader] = await Promise.all([
    fs.readFile(new URL('../src/screens/Uploads.jsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/lib/chunkedUpload.js', import.meta.url), 'utf8'),
  ])
  assert.match(uploader, /apiUpload/)
  assert.match(screen, /onProgress/)
  assert.match(screen, /item\.progress/)
  assert.doesNotMatch(screen, /stage === 'staged' \? '5%'|stage === 'hashing' \? '40%'|stage === 'transferring' \? '75%'/)
})
