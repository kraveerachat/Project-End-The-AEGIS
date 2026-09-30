// tests/vaultTreeManifestV2.test.js — AEGIS Drive (IDEA1) · Unified Preview P2a · T-MAN-V2
//
// P2a reads manifest schema v1 AND v2 but writes only v1. v2 adds two optional file-node keys
// (`contentFormat`, `previews`); anything else — including any schema version outside [1, 2] —
// fails secure. v1 stays exactly as strict as before: v2-only keys on a v1 manifest are UNKNOWN_KEY.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MANIFEST_SCHEMA_VERSION, MANIFEST_SCHEMA_VERSION_WRITE, MANIFEST_SCHEMA_VERSIONS_READ,
  createGenesisManifest, validateManifest, ManifestError,
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
