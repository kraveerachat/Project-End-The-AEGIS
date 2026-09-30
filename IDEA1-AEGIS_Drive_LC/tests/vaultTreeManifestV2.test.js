// tests/vaultTreeManifestV2.test.js — AEGIS Drive (IDEA1) · Unified Preview P2a · T-MAN-V2
//
// P2a reads manifest schema v1 AND v2 but writes only v1. v2 adds two optional file-node keys
// (`contentFormat`, `previews`); anything else — including any schema version outside [1, 2] —
// fails secure. v1 stays exactly as strict as before: v2-only keys on a v1 manifest are UNKNOWN_KEY.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MANIFEST_SCHEMA_VERSION, MANIFEST_SCHEMA_VERSION_WRITE, MANIFEST_SCHEMA_VERSIONS_READ,
  createGenesisManifest, validateManifest, effectivePreviews, ManifestError,
} from '../src/lib/vaultTreeManifest.js'
import { treeLimitsFrom } from '../src/lib/vaultTreeLimits.js'

const ID = (n) => String(n).padStart(22, 'A')
const NOW = 1_790_000_000_000
const LIMITS = treeLimitsFrom({ maxNodes: 1_000, maxDepth: 16, maxNameBytes: 60, maxRecentOperationIds: 8 })

function node(id, parent, kind = 'file', name = `n${id}`, extra = {}) {
  const base = { nodeId: ID(id), kind, parentNodeId: parent === null ? null : ID(parent), name, createdAtClient: NOW, modifiedAtClient: NOW, lifecycle: { state: 'active' } }
  if (kind === 'file') Object.assign(base, { blobRef: { formatVersion: 2, id: `blob-${id}` }, mediaType: 'video/mp4', plainSize: 1_000_000 })
  return Object.assign(base, extra)
}
function manifest(schemaVersion, nodesArr) {
  return {
    schemaVersion, treeId: ID(900), generation: 3, revisionId: ID(901), baseRevisionId: ID(902), rootNodeId: ID(0),
    createdAtClient: NOW, nodes: new Map(nodesArr.map((n) => [n.nodeId, n])), recentOperationIds: [ID(700)],
  }
}
const TREE = (v) => manifest(v, [node(0, null, 'folder', ''), node(1, 0, 'folder', 'docs'), node(2, 1, 'file', 'a.mp4')])
const rejects = (m, code, msg) => assert.throws(() => validateManifest(m, LIMITS), (e) => e instanceof ManifestError && e.code === code, msg ?? code)

// ── Task 1: version dispatch ──────────────────────────────────────────────────

test('MV2-1 constants: read [1, 2], write 1; legacy MANIFEST_SCHEMA_VERSION stays the write version', () => {
  assert.equal(MANIFEST_SCHEMA_VERSION_WRITE, 1)
  assert.deepEqual([...MANIFEST_SCHEMA_VERSIONS_READ], [1, 2])
  assert.ok(Object.isFrozen(MANIFEST_SCHEMA_VERSIONS_READ))
  assert.equal(MANIFEST_SCHEMA_VERSION, MANIFEST_SCHEMA_VERSION_WRITE)
  const g = createGenesisManifest({ treeId: ID(900), rootNodeId: ID(0), revisionId: ID(901), now: NOW })
  assert.equal(g.schemaVersion, 1, 'genesis is always written as v1 in P2a')
})

test('MV2-2 a schema v2 manifest without any new key validates; v1 still validates', () => {
  assert.equal(validateManifest(TREE(2), LIMITS).ok, true)
  assert.equal(validateManifest(TREE(1), LIMITS).ok, true)
})

test('MV2-3 unknown schema versions fail secure with UNSUPPORTED_SCHEMA_VERSION', () => {
  for (const v of [3, 0, -1, 1.5, '2', '1', null, undefined, 2n, Number.MAX_SAFE_INTEGER]) {
    const m = TREE(1); m.schemaVersion = v
    rejects(m, 'UNSUPPORTED_SCHEMA_VERSION', `schemaVersion ${String(v)}`)
  }
  const missing = TREE(1); delete missing.schemaVersion
  rejects(missing, 'UNSUPPORTED_SCHEMA_VERSION', 'missing schemaVersion')
})

test('MV2-4 a v1 manifest carrying v2-only keys is UNKNOWN_KEY (v1 stays byte-strict)', () => {
  const withPreviews = TREE(1); withPreviews.nodes.get(ID(2)).previews = []
  rejects(withPreviews, 'UNKNOWN_KEY')
  const withFormat = TREE(1); withFormat.nodes.get(ID(2)).contentFormat = 'mp4'
  rejects(withFormat, 'UNKNOWN_KEY')
})

// ── Task 2: v2 node fields (contentFormat, previews) + effectivePreviews ──────

const CID = 'AAECAwQFBgcICQoLDA0ODw==' // base64 of 16 bytes
const thumb = (over = {}) => ({ kind: 'thumb', profile: 'vp1', blobRef: { formatVersion: 2, id: 'deriv-thumb' }, contentId: CID, sourceBlobRef: { formatVersion: 2, id: 'blob-2' }, mime: 'image/webp', width: 512, height: 288, plainSize: 41_234, createdAtClient: NOW, ...over })
const poster = (over = {}) => thumb({ kind: 'poster', blobRef: { formatVersion: 2, id: 'deriv-poster' }, mime: 'image/jpeg', ...over })
const motion = (over = {}) => thumb({ kind: 'motion', blobRef: { formatVersion: 2, id: 'deriv-motion' }, mime: 'video/mp4', width: 480, height: 270, durationMs: 6000, plainSize: 4 * 1024 * 1024, ...over })
const proxy = (over = {}) => thumb({ kind: 'proxy', blobRef: { formatVersion: 2, id: 'deriv-proxy' }, mime: 'video/mp4', width: 854, height: 480, durationMs: 120_000, plainSize: 16_000_000, ...over })
const V2 = (fileExtra = {}) => manifest(2, [node(0, null, 'folder', ''), node(1, 0, 'folder', 'docs'), node(2, 1, 'file', 'a.mp4', { contentFormat: 'mp4', previews: [thumb(), poster()], ...fileExtra })])
const withPreviews = (...p) => V2({ previews: p })

test('MV2-5 a valid v2 file node with contentFormat + thumb/poster (and all four kinds) validates', () => {
  assert.equal(validateManifest(V2(), LIMITS).ok, true)
  assert.equal(validateManifest(withPreviews(thumb(), poster(), motion(), proxy()), LIMITS).ok, true)
  assert.equal(validateManifest(V2({ previews: [] }), LIMITS).ok, true, 'empty previews list')
  assert.equal(validateManifest(V2({ contentFormat: '' }), LIMITS).ok, true, 'empty string = format unknown')
  const noPrev = V2(); delete noPrev.nodes.get(ID(2)).previews; delete noPrev.nodes.get(ID(2)).contentFormat
  assert.equal(validateManifest(noPrev, LIMITS).ok, true, 'both keys are optional')
  // portrait media: bounds are long/short edge, not width/height
  assert.equal(validateManifest(withPreviews(thumb({ width: 288, height: 512 }), motion({ width: 270, height: 480 })), LIMITS).ok, true)
  // a V1 original may carry V2 derivatives
  const v1src = V2({ blobRef: { formatVersion: 1, id: 'blob-2' }, previews: [thumb({ sourceBlobRef: { formatVersion: 1, id: 'blob-2' } })] })
  assert.equal(validateManifest(v1src, LIMITS).ok, true)
})

test('MV2-6 each preview violation throws its own code', () => {
  rejects(withPreviews(thumb({ extra: 1 })), 'UNKNOWN_KEY', 'unknown preview key')
  rejects(withPreviews(thumb({ blobRef: { formatVersion: 2, id: 'x', more: 1 } })), 'UNKNOWN_KEY', 'unknown blobRef key')
  rejects(withPreviews(thumb(), thumb({ blobRef: { formatVersion: 2, id: 'other' } })), 'PREVIEW_DUPLICATE_KIND')
  rejects(withPreviews(thumb(), poster(), motion(), proxy(), thumb()), 'LIMIT_PREVIEWS', '5 entries')
  rejects(V2({ previews: 'thumb' }), 'PREVIEW_BAD_FIELD', 'previews not an array')
  rejects(withPreviews(null), 'PREVIEW_BAD_FIELD', 'entry not an object')
  rejects(withPreviews(thumb({ kind: 'banner' })), 'PREVIEW_BAD_KIND')
  rejects(withPreviews(thumb({ profile: 'v1' })), 'PREVIEW_BAD_PROFILE')
  rejects(withPreviews(thumb({ profile: 'vp0' })), 'PREVIEW_BAD_PROFILE')
  rejects(withPreviews(thumb({ blobRef: { formatVersion: 1, id: 'deriv-thumb' } })), 'PREVIEW_BAD_BLOB_REF', 'derivative must be V2')
  rejects(withPreviews(thumb({ blobRef: { formatVersion: 2, id: '' } })), 'PREVIEW_BAD_BLOB_REF', 'empty id')
  rejects(withPreviews(thumb({ blobRef: { formatVersion: 2, id: 'x'.repeat(129) } })), 'PREVIEW_BAD_BLOB_REF', 'id too long')
  rejects(withPreviews(thumb({ contentId: 'AAECAwQFBgcICQoLDA0O' })), 'PREVIEW_BAD_CONTENT_ID', '15 bytes')
  rejects(withPreviews(thumb({ contentId: 'AAECAwQFBgcICQoLDA0ODxA=' })), 'PREVIEW_BAD_CONTENT_ID', '17 bytes')
  rejects(withPreviews(thumb({ contentId: 'AAECAwQFBgcICQoLDA0ODw' })), 'PREVIEW_BAD_CONTENT_ID', 'unpadded')
  rejects(withPreviews(thumb({ contentId: 16 })), 'PREVIEW_BAD_CONTENT_ID', 'not a string')
  rejects(withPreviews(thumb({ sourceBlobRef: { formatVersion: 3, id: 'blob-2' } })), 'PREVIEW_BAD_SOURCE_REF')
  rejects(withPreviews(thumb({ sourceBlobRef: { formatVersion: 2, id: '' } })), 'PREVIEW_BAD_SOURCE_REF')
  rejects(withPreviews(thumb({ mime: 'video/mp4' })), 'PREVIEW_BAD_MIME', 'mime not allowed for thumb')
  rejects(withPreviews(proxy({ mime: 'image/webp' })), 'PREVIEW_BAD_MIME', 'mime not allowed for proxy')
  rejects(withPreviews(thumb({ width: 513 })), 'PREVIEW_OUT_OF_BOUNDS', 'width above vp1 bound')
  rejects(withPreviews(motion({ width: 480, height: 271 })), 'PREVIEW_OUT_OF_BOUNDS', 'motion short edge')
  rejects(withPreviews(thumb({ plainSize: 256 * 1024 + 1 })), 'PREVIEW_OUT_OF_BOUNDS', 'thumb plainSize')
  rejects(withPreviews(motion({ durationMs: 6001 })), 'PREVIEW_OUT_OF_BOUNDS', 'motion duration')
  rejects(withPreviews(thumb({ width: 0 })), 'PREVIEW_BAD_FIELD', 'zero width')
  rejects(withPreviews(thumb({ height: 1.5 })), 'PREVIEW_BAD_FIELD', 'fractional height')
  rejects(withPreviews(thumb({ plainSize: 0 })), 'PREVIEW_BAD_FIELD', 'zero plainSize')
  rejects(withPreviews(thumb({ createdAtClient: -1 })), 'PREVIEW_BAD_FIELD', 'negative createdAtClient')
  rejects(withPreviews(thumb({ durationMs: 1000 })), 'PREVIEW_BAD_DURATION', 'durationMs on thumb')
  const noDur = motion(); delete noDur.durationMs
  rejects(withPreviews(noDur), 'PREVIEW_BAD_DURATION', 'motion without durationMs')
  rejects(withPreviews(motion({ durationMs: 0 })), 'PREVIEW_BAD_DURATION', 'zero duration')
  rejects(V2({ contentFormat: 'exe' }), 'BAD_CONTENT_FORMAT', 'not a known FormatId')
  rejects(V2({ contentFormat: 'x'.repeat(33) }), 'BAD_CONTENT_FORMAT', 'over 32 bytes')
  rejects(V2({ contentFormat: 42 }), 'BAD_CONTENT_FORMAT', 'not a string')
  const folderPrev = V2(); folderPrev.nodes.get(ID(1)).previews = []; rejects(folderPrev, 'FOLDER_HAS_PREVIEWS')
  const folderFmt = V2(); folderFmt.nodes.get(ID(1)).contentFormat = 'mp4'; rejects(folderFmt, 'FOLDER_HAS_PREVIEWS')
})

test('MV2-7 an unknown profile is structurally validated but not bound-checked (spec §10: ignored, not an error)', () => {
  assert.equal(validateManifest(withPreviews(thumb({ profile: 'vp9', width: 4096, mime: 'image/avif' })), LIMITS).ok, true)
  rejects(withPreviews(thumb({ profile: 'vp9', width: -1 })), 'PREVIEW_BAD_FIELD', 'structure still enforced')
  rejects(withPreviews(thumb({ profile: 'vp9', mime: '' })), 'PREVIEW_BAD_MIME', 'mime must still be a non-empty string')
})

test('MV2-8 effectivePreviews keeps only entries for the current blob with a known profile, never throws', () => {
  const stale = thumb({ sourceBlobRef: { formatVersion: 2, id: 'replaced-original' } })
  const staleFv = poster({ sourceBlobRef: { formatVersion: 1, id: 'blob-2' } })
  const future = motion({ profile: 'vp9' })
  const m = withPreviews(stale, staleFv, future, proxy())
  validateManifest(m, LIMITS)
  const eff = effectivePreviews(m.nodes.get(ID(2)))
  assert.deepEqual(eff.map((p) => p.kind), ['proxy'])
  assert.ok(Object.isFrozen(eff))
  assert.deepEqual(effectivePreviews(V2().nodes.get(ID(2))).map((p) => p.kind), ['thumb', 'poster'])
  assert.deepEqual(effectivePreviews(TREE(1).nodes.get(ID(2))), [], 'v1 node → no previews')
  assert.deepEqual(effectivePreviews(TREE(1).nodes.get(ID(1))), [], 'folder → no previews')
  assert.deepEqual(effectivePreviews(null), [])
})
