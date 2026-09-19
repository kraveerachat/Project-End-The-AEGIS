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
  scope.localStorage = throwingStorage()
  scope.sessionStorage = throwingStorage()
  scope.indexedDB = { open: () => { counts.writes++; throw new Error('indexedDB forbidden') }, deleteDatabase: () => { counts.writes++; throw new Error('indexedDB forbidden') } }
  scope.caches = { open: async () => { counts.writes++; throw new Error('Cache API forbidden') }, match: async () => { counts.reads++; return undefined }, keys: async () => [] }
  return counts
}
