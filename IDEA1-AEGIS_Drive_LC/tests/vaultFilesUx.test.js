import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

async function optionalModule(path) {
  try { return await import(path) } catch { return null }
}

const folder = (over = {}) => ({
  nodeId: 'folder-a', kind: 'folder', name: 'งาน', createdAt: 10, modifiedAt: 20, ...over,
})

const file = (over = {}) => ({
  nodeId: 'file-a', kind: 'file', name: 'Photo 2.jpg', mediaType: 'image/jpeg',
  plainSize: 20, createdAt: 30, modifiedAt: 40, ...over,
})

test('UX-02/03/07/08/09 vault workspace derives client-only folder-first sections', async () => {
  const mod = await optionalModule('../src/lib/vaultWorkspace.js')
  assert.equal(typeof mod?.deriveVaultWorkspace, 'function', 'vault workspace derivation must exist')

  const input = [
    file({ nodeId: 'video', name: 'Clip.mp4', mediaType: 'video/mp4' }),
    folder({ nodeId: 'photos', name: 'รูปภาพ' }),
    file({ nodeId: 'image', name: 'Holiday.JPG', mediaType: 'image/jpeg' }),
    folder({ nodeId: 'work', name: 'งานเอกสาร' }),
  ]

  const searched = mod.deriveVaultWorkspace(input, { query: 'งาน', typeFilter: 'all', sort: 'name-asc' })
  assert.deepEqual(searched.folders.map((n) => n.nodeId), ['work'])
  assert.deepEqual(searched.files, [])

  const images = mod.deriveVaultWorkspace(input, { query: '', typeFilter: 'images', sort: 'name-asc' })
  assert.deepEqual(new Set(images.folders.map((n) => n.nodeId)), new Set(['photos', 'work']), 'file filters keep truthful folder navigation visible')
  assert.deepEqual(images.files.map((n) => n.nodeId), ['image'])
  assert.equal(input[0].nodeId, 'video', 'derivation does not mutate the decrypted manifest order')
})

test('UX-04 vault workspace sorting is deterministic inside separate folder/file groups', async () => {
  const mod = await optionalModule('../src/lib/vaultWorkspace.js')
  assert.equal(typeof mod?.deriveVaultWorkspace, 'function', 'vault workspace derivation must exist')

  const a = file({ nodeId: 'b', name: 'same.txt', mediaType: 'text/plain', plainSize: 10 })
  const b = file({ nodeId: 'a', name: 'same.txt', mediaType: 'text/plain', plainSize: 10 })
  const one = mod.deriveVaultWorkspace([a, b], { sort: 'size-desc' }).files.map((n) => n.nodeId)
  const two = mod.deriveVaultWorkspace([b, a], { sort: 'size-desc' }).files.map((n) => n.nodeId)
  assert.deepEqual(one, ['a', 'b'])
  assert.deepEqual(two, one)
})

test('HIST-01/VHIST-02/03 folder history stores only scope plus opaque identity and preserves the URL', async () => {
  const mod = await optionalModule('../src/lib/folderHistory.js')
  assert.equal(typeof mod?.writeFolderHistory, 'function', 'folder history coordinator must exist')

  const calls = []
  const history = {
    state: { app: 'drive' },
    pushState: (...args) => calls.push(['push', ...args]),
    replaceState: (...args) => calls.push(['replace', ...args]),
  }
  const location = { pathname: '/drive/vault', search: '', hash: '' }
  mod.writeFolderHistory({ history, location, scope: 'vault', nodeId: 'opaque-node-7', replace: false })

  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'push')
  assert.equal(calls[0][3], '/drive/vault')
  assert.equal(JSON.stringify(calls[0][1]).includes('Secret Folder'), false)
  assert.deepEqual(mod.readFolderHistory(calls[0][1], 'vault'), { nodeId: 'opaque-node-7' })
})

test('HIST-06/VHIST-06 stale or invalid folder history falls back to the supplied root', async () => {
  const mod = await optionalModule('../src/lib/folderHistory.js')
  assert.equal(typeof mod?.resolveFolderHistoryTarget, 'function', 'history fallback resolver must exist')

  assert.equal(mod.resolveFolderHistoryTarget('folder-a', new Set(['root', 'folder-a']), 'root'), 'folder-a')
  assert.equal(mod.resolveFolderHistoryTarget('deleted-folder', new Set(['root', 'folder-a']), 'root'), 'root')
  assert.equal(mod.resolveFolderHistoryTarget(null, new Set(['root']), 'root'), 'root')
})

test('REC-01 recovery copy is explicit and the Thai security note states traffic-analysis limits', async () => {
  const { STRINGS } = await import('../src/lib/strings.js')
  const th = STRINGS.th

  assert.equal(th.vaultTreeOrphansTitle, 'ไฟล์ที่รอจัดเข้าโฟลเดอร์')
  assert.equal(
    th.vaultTreeOrphansDescription,
    'ไฟล์เหล่านี้ถูกเข้ารหัสแล้ว แต่ยังไม่ได้จัดเข้าโครงสร้างโฟลเดอร์ของห้องนิรภัย',
  )
  assert.equal(
    th.vaultTreeSecurityNote,
    'AEGIS ซ่อนชื่อไฟล์และเนื้อหาของคุณไว้ แต่ผู้สังเกตการณ์บนเครือข่ายอาจยังเห็นรูปแบบการใช้งานโดยรวม เช่น เวลาเข้าถึง ปริมาณข้อมูล และขนาดข้อมูลที่เข้ารหัส โดยไม่เห็นชื่อไฟล์หรือเนื้อหาจริง',
  )
  assert.equal(typeof th.vaultFilterImages, 'string')
  assert.equal(typeof th.vaultFilterVideos, 'string')
  assert.equal(typeof th.vaultFilterDocuments, 'string')
})

test('AUDIT-01 tile overflow controls remain available to touch and selected items avoid hover-only motion', () => {
  for (const fileName of ['VaultFileTile.jsx', 'VaultFolderTile.jsx']) {
    const source = fs.readFileSync(new URL(`../src/components/vault/${fileName}`, import.meta.url), 'utf8')
    assert.match(source, /FileCardMenuButton/)
    assert.match(source, /FileCardCheckbox/)
    assert.match(source, /FileCardShell/)
    assert.match(source, /data-visible=\{selected \|\| menuOpen \? 'true' : undefined\}/)
    assert.doesNotMatch(source, /hover:-translate/)
  }
})

test('MEDIA-05 Vault schedules video posters through the existing encrypted preview session', () => {
  const source = fs.readFileSync(new URL('../src/screens/VaultTreeScreen.jsx', import.meta.url), 'utf8')
  assert.match(source, /openVideoPoster/)
  assert.match(source, /openPreviewSession/)
  assert.match(source, /previewKindFor\(n\.mediaType\) === 'video'/)
  assert.match(source, /unwrapVaultV2Dek/)
})


