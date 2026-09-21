// tests/helpers/vaultTreeFixtures.mjs — PR #157 · shared fixtures for the tree API / migration / upload suites
//
// - ids are 22-char base64url like the product (random or deterministic)
// - `capture()` records every server-bound request line/header/body so NO-LEAK-* assertions can scan
//   them for plaintext names / node ids (design §6: nothing explicit leaves the client)
import { createHash, randomBytes } from 'node:crypto'

export const b64url = (buf) => Buffer.from(buf).toString('base64url')
export const randomId = () => b64url(randomBytes(16))
export const fixedId = (n, tag = 'A') => String(n).padStart(22, tag)
export const ivB64 = () => Buffer.from(randomBytes(12)).toString('base64')
export const wrappedB64 = (n = 48) => Buffer.from(randomBytes(n)).toString('base64')
export const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex')

/** a plausible opaque revision descriptor for POST /api/vault/tree/revisions */
export function revisionDescriptor({ revisionId = randomId(), baseRevisionId, generation, idempotencyKey = randomId(), treeId } = {}) {
  const d = { revisionId, baseRevisionId: baseRevisionId ?? null, generation, ivB64: ivB64(), wrappedManifestDekB64: wrappedB64(), wrapIvB64: ivB64(), manifestSchemaVersion: 1, idempotencyKey }
  if (treeId !== undefined) d.treeId = treeId
  return d
}

/** fake ciphertext of a given size (opaque bytes; the server never inspects them) */
export const fakeCiphertext = (n = 4_112) => randomBytes(n)

/**
 * wraps a test client so every request is recorded; `all()` returns one big string of
 * method+path+headers+body for leak scans, `bodies()` the parsed JSON bodies sent
 */
export function capture(client) {
  const log = []
  const orig = client.req.bind(client)
  client.req = async (pathname, opts = {}) => {
    const body = opts.body instanceof Uint8Array ? `<${opts.body.length} raw bytes>` : JSON.stringify(opts.body ?? null)
    log.push({ method: opts.method ?? 'GET', pathname, headers: opts.headers ?? {}, body })
    return orig(pathname, opts)
  }
  return {
    all: () => log.map((l) => `${l.method} ${l.pathname}\n${JSON.stringify(l.headers)}\n${l.body}`).join('\n'),
    entries: () => log.slice(),
    clear: () => { log.length = 0 },
  }
}

/** instrumented browser-storage globals: any write throws, reads are counted (storage-absence tests) */
export function installStorageGuards(scope = globalThis) {
  const counts = { reads: 0, writes: 0 }
  const throwingStorage = () => new Proxy({}, {
    get(_t, prop) {
      if (prop === 'setItem' || prop === 'removeItem' || prop === 'clear') return () => { counts.writes++; throw new Error('storage write forbidden') }
      counts.reads++
      return prop === 'getItem' ? () => null : prop === 'length' ? 0 : undefined
    },
    set() { counts.writes++; throw new Error('storage write forbidden') },
  })
  // defineProperty: บน jsdom Window พวกนี้เป็น accessor (getter อย่างเดียว) — กำหนดทับที่ instance ได้
  const define = (name, value) => Object.defineProperty(scope, name, { value, configurable: true, writable: true })
  define('localStorage', throwingStorage())
  define('sessionStorage', throwingStorage())
  define('indexedDB', { open: () => { counts.writes++; throw new Error('indexedDB forbidden') }, deleteDatabase: () => { counts.writes++; throw new Error('indexedDB forbidden') } })
  define('caches', { open: async () => { counts.writes++; throw new Error('Cache API forbidden') }, match: async () => { counts.reads++; return undefined }, keys: async () => [] })
  return counts
}

/** ── Phase 7 media fixtures ─────────────────────────────────────────────────
   โครงสร้างพอสำหรับชุด scheduler/preview (ไม่มี large binary committed):
   header จริงของ PNG/GIF ยาวเท่าที่ parser ต้องอ่าน + ไบต์ padding ถึงขนาดที่ต้องการ */
export function syntheticPng({ width = 8, height = 8, padBytes = 0 } = {}) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  const header = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), ihdr,
  ])
  const pad = Buffer.alloc(padBytes, 0x5a)
  return new Uint8Array(Buffer.concat([header, pad]))
}

export function syntheticGif({ width = 8, height = 8, padBytes = 0 } = {}) {
  const header = Buffer.concat([
    Buffer.from('GIF89a'),
    Buffer.from([width & 0xff, (width >> 8) & 0xff, height & 0xff, (height >> 8) & 0xff, 0, 0, 0, 0]),
  ])
  const pad = Buffer.alloc(padBytes, 0x5a)
  return new Uint8Array(Buffer.concat([header, pad]))
}

export function syntheticJpeg({ width = 8, height = 8, padBytes = 0 } = {}) {
  const app0 = Buffer.from([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])
  const sof0 = Buffer.concat([
    Buffer.from([0xff, 0xc0, 0, 17, 8, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
  ])
  const header = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0])
  const pad = Buffer.alloc(padBytes, 0x5a)
  return new Uint8Array(Buffer.concat([header, pad]))
}

export function syntheticWebp({ width = 8, height = 8, padBytes = 0 } = {}) {
  const header = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('WEBPVP8 '),
    Buffer.from([0x0a, 0x00, 0x00, 0x00]),
    Buffer.from([0x30, 0x00, 0x00, 0x9d, 0x01, 0x2a, width & 0xff, (width >> 8) & 0xff, height & 0xff, (height >> 8) & 0xff]),
  ])
  const pad = Buffer.alloc(padBytes, 0x5a)
  return new Uint8Array(Buffer.concat([header, pad]))
}
