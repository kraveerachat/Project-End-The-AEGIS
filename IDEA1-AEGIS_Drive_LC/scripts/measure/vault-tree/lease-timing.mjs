// scripts/measure/vault-tree/lease-timing.mjs — PR #157 Phase 0 Task 0.1 Step 5 · decrypt-all timing
//
// ⚠️ DISPOSABLE. Measures how long the genesis migration's "decrypt every existing
//    V1/V2 envelope" step takes for inventories of 100 / 1 000 / 10 000 items, using
//    the REAL existing product functions (vaultCrypto.encryptFileEnvelope /
//    decryptBlobMeta and vaultChunkCrypto.createVaultV2Envelope /
//    decryptVaultV2Meta) under a fake AES key standing in for the Argon2id KEK
//    (Argon2 cost is per-unlock, not per-item, and is unchanged by this PR).
//    Informs the migration-lease-duration row of the Limits Register.
//
//   node scripts/measure/vault-tree/lease-timing.mjs
import { encryptFileEnvelope, decryptBlobMeta } from '../../../src/lib/vaultCrypto.js'
import { createVaultV2Envelope, decryptVaultV2Meta, newContentId } from '../../../src/lib/vaultChunkCrypto.js'
import { bytesToB64 } from '../../../src/lib/vaultCrypto.js'

const subtle = globalThis.crypto.subtle
const kek = await subtle.importKey('raw', new Uint8Array(32).fill(9), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
const now = () => performance.now()

async function makeInventory(n) {
  const blobs = []
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      const env = await encryptFileEnvelope(kek, { name: `file-${i}.bin`, type: 'application/octet-stream', size: 3, bytes: new Uint8Array([1, 2, 3]) })
      blobs.push({ formatVersion: 1, id: i, ...env })
    } else {
      const contentId = newContentId()
      const env = await createVaultV2Envelope(kek, { name: `file-${i}.bin`, type: 'application/octet-stream', size: 1_000_000, chunkCount: 1, contentId })
      blobs.push({ formatVersion: 2, id: bytesToB64(contentId), ...env, contentIdB64: bytesToB64(contentId), chunkCount: 1 })
    }
  }
  return blobs
}

const rows = []
for (const n of [100, 1_000, 10_000]) {
  const inv = await makeInventory(n)
  const t = now()
  let ok = 0
  for (const b of inv) {
    const meta = b.formatVersion === 2 ? await decryptVaultV2Meta(kek, b) : await decryptBlobMeta(kek, b)
    if (meta.name) ok++
  }
  const ms = now() - t
  rows.push({ items: n, decryptedOk: ok, decryptAllMs: +ms.toFixed(1), perItemMs: +(ms / n).toFixed(3) })
  console.error(JSON.stringify(rows.at(-1)))
}
console.log(JSON.stringify({ node: process.version, kekModel: 'fake AES-GCM key (Argon2id unlock excluded; per-unlock, unchanged)', rows }, null, 2))
