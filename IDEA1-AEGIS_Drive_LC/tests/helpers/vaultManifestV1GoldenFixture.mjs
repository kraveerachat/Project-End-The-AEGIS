// tests/helpers/vaultManifestV1GoldenFixture.mjs — Unified Preview P2a · frozen v1 manifest fixture
//
// A fixed schema-v1 manifest (fixed ids, fixed timestamps) whose canonical bytes were captured from
// origin/main 07633c93 BEFORE any P2a change and frozen in tests/fixtures/vaultManifestV1Golden.json.
// Every v1 revision already stored in Production decrypts only while these bytes stay identical.
// ⚠️ Never edit this fixture: a change here silently re-baselines the golden vector.

const ID = (n) => String(n).padStart(22, 'A')
const T0 = 1_790_000_000_000

/** A fresh copy each call (tests may mutate). Covers folders, V1+V2 blob refs, trash, Unicode, escapes. */
export function v1GoldenManifest() {
  const node = (id, parent, kind, name, extra = {}) => ({
    nodeId: ID(id), kind, parentNodeId: parent === null ? null : ID(parent), name,
    createdAtClient: T0 + id, modifiedAtClient: T0 + id * 2, lifecycle: { state: 'active' }, ...extra,
  })
  const nodes = [
    node(0, null, 'folder', ''),
    node(1, 0, 'folder', 'Photos'),
    node(2, 1, 'file', 'รูปภาพ-ทะเล.jpg', { blobRef: { formatVersion: 2, id: 'blob-v2-0002' }, mediaType: 'image/jpeg', plainSize: 3_145_728 }),
    node(3, 1, 'file', 'old "quoted" name.png', { blobRef: { formatVersion: 1, id: 'blob-v1-0003' }, mediaType: 'image/png', plainSize: 1024 }),
    node(4, 0, 'folder', 'Café', { lifecycle: { state: 'trashed', trashedAtClient: T0 + 400, trashedFromParentNodeId: ID(0) } }),
    node(5, 4, 'file', 'clip 😀.mp4', { blobRef: { formatVersion: 2, id: 'blob-v2-0005' }, mediaType: 'video/mp4', plainSize: 1_288_490_188 }),
    node(6, 0, 'file', 'notes.txt', { blobRef: { formatVersion: 2, id: 'blob-v2-0006' }, mediaType: 'text/plain;x="a\\b\tc"', plainSize: 0 }),
  ]
  // Map insertion order deliberately differs from nodeId order: the encoder must sort.
  const order = [5, 0, 3, 1, 6, 2, 4]
  return {
    schemaVersion: 1, treeId: ID(900), generation: 7, revisionId: ID(901), baseRevisionId: ID(902), rootNodeId: ID(0),
    createdAtClient: T0 + 7000, nodes: new Map(order.map((i) => [nodes[i].nodeId, nodes[i]])), recentOperationIds: [ID(700), ID(701)],
  }
}
