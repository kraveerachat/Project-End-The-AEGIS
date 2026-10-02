// tests/helpers/previewIndexFixture.mjs — D-1 PR-B · TEST HARNESS ONLY
//
// Builds a real encrypted preview index (real codec, real V2 envelopes) on top of the test-only fake transport, plus a
// fake read API ({ getPreviewIndexHead, getPreviewIndexEnvelopes }) with request counters. Never imported by src/ or server/.
import { randomBytes } from 'node:crypto'
import { encodeRoot, encodeShard } from '../../src/lib/vaultPreviewIndexCodec.js'
import { sealIndexObject, sealDerivative } from '../../src/lib/vaultPreviewIndexObject.js'
import { routingBits, prefixOf } from '../../src/lib/vaultPreviewIndexRouting.js'
import { INDEX_ROOT_MARKER, INDEX_SHARD_MARKER, PREVIEW_INDEX_LIMITS } from '../../src/lib/vaultPreviewIndexConstants.js'
import { createPreviewIndexFakeTransport } from './previewIndexFakeTransport.mjs'

export const TREE_ID = 'T'.repeat(22)
export const newKek = () => globalThis.crypto.subtle.importKey('raw', randomBytes(32), 'AES-GCM', false, ['encrypt', 'decrypt'])
export const id22 = () => randomBytes(16).toString('base64url')

/** a minimal valid JPEG-looking body: SOI + SOF0 (dims) + EOI; signature and dims are what the reader checks */
export function fakeJpeg(width = 320, height = 240, pad = 64) {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]
  return new Uint8Array([0xff, 0xd8, ...sof, ...new Array(pad).fill(0), 0xff, 0xd9])
}
/** a minimal WebP (VP8X canvas dims) body */
export function fakeWebp(width = 320, height = 240, pad = 32) {
  const w = width - 1, h = height - 1
  const vp8x = [0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0, w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff]
  const body = [0x57, 0x45, 0x42, 0x50, ...vp8x, ...new Array(pad).fill(0)]
  const size = body.length
  return new Uint8Array([0x52, 0x49, 0x46, 0x46, size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >> 24) & 0xff, ...body])
}

export const fileNode = (nodeId, blobId, o = {}) => ({
  nodeId, kind: 'file', parentNodeId: 'R'.repeat(22), name: 'secret.jpg', createdAtClient: 1, modifiedAtClient: 1,
  lifecycle: { state: 'active' }, blobRef: { formatVersion: 2, id: blobId }, mediaType: 'image/jpeg', plainSize: 1_000_000, ...o,
})

/**
 * @param {{ files: number, kinds?: ('thumb'|'poster')[], generation?: number }} o
 * @returns everything a reader/derivative test needs
 */
export async function buildIndex({ files = 4, kinds = ['thumb'], generation = 1, mime = 'image/jpeg' } = {}) {
  const kek = await newKek()
  const t = createPreviewIndexFakeTransport()
  const rootNode = { nodeId: 'R'.repeat(22), kind: 'folder', parentNodeId: null, name: '', createdAtClient: 1, modifiedAtClient: 1, lifecycle: { state: 'active' } }
  const nodes = new Map([[rootNode.nodeId, rootNode]])
  const byPrefix = new Map()
  const derivs = new Map()
  for (let i = 0; i < files; i++) {
    const nodeId = id22()
    const source = randomBytes(24).toString('hex')
    nodes.set(nodeId, fileNode(nodeId, source))
    const list = []
    for (const kind of kinds) {
      const bytes = mime === 'image/webp' ? fakeWebp() : fakeJpeg()
      const d = await sealDerivative({ kek, bytes, mime, transport: t })
      derivs.set(`${nodeId}:${kind}`, { ...d, bytes })
      list.push({ kind, profile: 'vp1', blobRef: d.blobRef, contentId: d.contentId, sourceBlobRef: { formatVersion: 2, id: source }, mime, width: 320, height: 240, plainSize: bytes.length, createdAtClient: 1_700_000_000_000 })
    }
    const p = prefixOf(await routingBits(nodeId), PREVIEW_INDEX_LIMITS.initialPrefixBits)
    if (!byPrefix.has(p)) byPrefix.set(p, new Map())
    byPrefix.get(p).set(nodeId, list)
  }
  const shards = []
  for (const prefix of [...byPrefix.keys()].sort()) {
    const plaintext = await encodeShard({ schemaVersion: 1, treeId: TREE_ID, prefix, entries: byPrefix.get(prefix) })
    const s = await sealIndexObject({ kek, marker: INDEX_SHARD_MARKER, plaintext, buckets: PREVIEW_INDEX_LIMITS.shardPaddingBuckets, transport: t })
    shards.push({ prefix, blobRef: s.blobRef, contentId: s.contentId })
  }
  const rootPlain = encodeRoot({ schemaVersion: 1, treeId: TREE_ID, indexGeneration: generation, createdAtClient: 1_700_000_000_000, shards })
  const root = await sealIndexObject({ kek, marker: INDEX_ROOT_MARKER, plaintext: rootPlain, buckets: PREVIEW_INDEX_LIMITS.rootPaddingBuckets, transport: t })
  let head = { treeId: TREE_ID, indexGeneration: generation, rootBlobRef: root.blobRef, rootContentIdB64: root.contentId }
  const calls = { head: 0, envelopes: 0, envelopeIds: [] }
  const api = {
    async getPreviewIndexHead() { calls.head++; return head },
    async getPreviewIndexEnvelopes(ids) { calls.envelopes++; calls.envelopeIds.push(...ids); return ids.map((id) => t.envelopeOf(id)).filter(Boolean) },
  }
  t.reset()
  return {
    kek, t, api, calls, derivs, shards, root, nodes,
    mainHead: { treeId: TREE_ID, generation: 5, index: { nodes, rootNodeId: rootNode.nodeId, limits: { maxDepth: 64 } } },
    fileIds: [...nodes.keys()].filter((k) => k !== rootNode.nodeId),
    setHead(h) { head = h },
    chunkGets: () => t.requests.filter((r) => r.transport === 'bytes').map((r) => r.path),
  }
}
