// Unit cover for the opaque blob inventory that backs the Private Vault screen.
//
// The production bug this exists for: upload succeeded, the new file appeared
// while unlocked, and an immediate Lock rendered "Empty Vault" because locked
// mode read `vaultApi.data.blobs` — the result of the *previous* GET. The fix
// is a deterministic client-side inventory, so it gets deterministic tests that
// need no DOM, no network, and no crypto.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  reconcileVaultInventory, addLocalVaultBlob, removeLocalVaultBlob,
  tombstoneVaultBlob, vaultBlobId, lockedVaultEntry,
} from '../src/lib/vaultInventory.js'

const blob = (id, size = 100) => ({ id, size, metaB64: `meta-${id}` })
const ids = (list) => list.map((b) => String(b.id))

test('a successful upload is visible before any refetch returns', () => {
  const local = addLocalVaultBlob([], blob('a'))
  const inventory = reconcileVaultInventory({ serverBlobs: [], localBlobs: local })
  assert.deepEqual(ids(inventory), ['a'], 'the POST result alone is enough to render a locked card')
})

test('a later GET carrying the same blob does not produce a duplicate card', () => {
  const local = addLocalVaultBlob([], blob('a'))
  const inventory = reconcileVaultInventory({ serverBlobs: [blob('a'), blob('b')], localBlobs: local })
  assert.deepEqual(ids(inventory), ['a', 'b'], 'exactly two cards, deduped strictly by blob id')
})

test('the newest upload sorts ahead of pre-existing server blobs', () => {
  const local = addLocalVaultBlob(addLocalVaultBlob([], blob('a')), blob('c'))
  const inventory = reconcileVaultInventory({ serverBlobs: [blob('b')], localBlobs: local })
  assert.deepEqual(ids(inventory), ['c', 'a', 'b'])
})

test('re-adding the same id replaces it instead of stacking a second copy', () => {
  const local = addLocalVaultBlob(addLocalVaultBlob([], blob('a', 10)), blob('a', 20))
  assert.equal(local.length, 1)
  assert.equal(local[0].size, 20, 'the newer envelope wins')
})

test('a blob with no id is never admitted to the inventory', () => {
  assert.deepEqual(addLocalVaultBlob([], { size: 5 }), [], 'a POST result without an id is not a blob')
  assert.deepEqual(addLocalVaultBlob([], null), [])
  const inventory = reconcileVaultInventory({ serverBlobs: [null, { size: 1 }, blob('a')] })
  assert.deepEqual(ids(inventory), ['a'])
})

test('a deleted blob is not resurrected by a stale GET', () => {
  const removed = tombstoneVaultBlob(new Set(), 'a')
  const inventory = reconcileVaultInventory({
    serverBlobs: [blob('a'), blob('b')],     // a GET issued before the DELETE landed
    localBlobs: removeLocalVaultBlob([blob('a')], 'a'),
    removedIds: removed,
  })
  assert.deepEqual(ids(inventory), ['b'], 'the tombstone outlives the in-flight refetch')
})

test('tombstones accumulate without mutating the previous set', () => {
  const first = tombstoneVaultBlob(new Set(), 'a')
  const second = tombstoneVaultBlob(first, 'b')
  assert.deepEqual([...first], ['a'], 'the earlier set is not mutated in place')
  assert.deepEqual([...second].sort(), ['a', 'b'])
})

test('ids compare as strings, so a numeric server id and a string local id are one blob', () => {
  const inventory = reconcileVaultInventory({ serverBlobs: [blob(7)], localBlobs: [blob('7')] })
  assert.equal(inventory.length, 1, 'one blob, not two')
  assert.equal(vaultBlobId({ id: 7 }), '7')
  assert.equal(vaultBlobId({}), null)
  assert.equal(vaultBlobId(null), null)

  const removed = tombstoneVaultBlob(new Set(), 7)
  assert.deepEqual(reconcileVaultInventory({ serverBlobs: [blob('7')], removedIds: removed }), [])
})

test('removedIds accepts a plain array as well as a Set', () => {
  const inventory = reconcileVaultInventory({ serverBlobs: [blob('a'), blob('b')], removedIds: ['a'] })
  assert.deepEqual(ids(inventory), ['b'])
})

test('reconciling is pure: the caller’s arrays are never mutated', () => {
  const serverBlobs = [blob('a')]
  const localBlobs = [blob('b')]
  reconcileVaultInventory({ serverBlobs, localBlobs, removedIds: ['a'] })
  assert.deepEqual(ids(serverBlobs), ['a'])
  assert.deepEqual(ids(localBlobs), ['b'])
})

test('a failed upload leaves no ghost: nothing was added, so nothing renders', () => {
  // addLocalVaultBlob is only ever reached on a 2xx, but prove the empty path too.
  const inventory = reconcileVaultInventory({ serverBlobs: [], localBlobs: [] })
  assert.deepEqual(inventory, [])
})

test('the locked view of a blob carries no plaintext field at all', () => {
  const entry = lockedVaultEntry({ id: 'a', size: 4096, metaB64: 'ciphertext', name: 'secret.gif' })
  assert.deepEqual(Object.keys(entry).sort(), ['blob', 'id', 'name', 'size'])
  assert.equal(entry.name, null, 'the locked view has no filename, even if one is handed in')
  assert.equal(entry.size, 4096, 'size is the ciphertext size the server measured')
  assert.equal(entry.plainSize, undefined, 'plaintext size is not knowable while locked')

  const serialised = JSON.stringify({ id: entry.id, name: entry.name, size: entry.size })
  assert.doesNotMatch(serialised, /secret\.gif/, 'the rendered locked identity cannot leak the filename')
})

test('a blob missing a size still renders a locked identity instead of crashing', () => {
  assert.equal(lockedVaultEntry({ id: 'a' }).size, 0)
  assert.equal(lockedVaultEntry(null).id, null)
})
