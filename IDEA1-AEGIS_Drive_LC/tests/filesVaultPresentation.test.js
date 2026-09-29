import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')

test('CARD-V3-1 Files and Vault consume one Files-derived card presentation primitive', () => {
  const shared = read('../src/components/FileCardPresentation.jsx')
  const files = read('../src/screens/Files.jsx')
  const vaultFile = read('../src/components/vault/VaultFileTile.jsx')
  const vaultFolder = read('../src/components/vault/VaultFolderTile.jsx')

  assert.match(shared, /export const FileCardShell/)
  assert.match(shared, /export function FileCardCheckbox/)
  assert.match(shared, /export const FileCardMenuButton/)
  for (const source of [files, vaultFile, vaultFolder]) {
    assert.match(source, /FileCardPresentation\.jsx/, 'every card adapter imports the shared Files presentation')
    assert.match(source, /<FileCardShell/, 'every card adapter renders the same outer shell')
  }
})

test('CARD-V3-2 shared controls are quiet on fine pointers and accessible for focus, selection, open menus, and coarse pointers', () => {
  const shared = read('../src/components/FileCardPresentation.jsx')
  const css = read('../src/index.css')

  assert.match(shared, /data-file-card-control/)
  assert.match(shared, /data-selected=/)
  assert.match(shared, /data-menu-open=/)
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\)[\s\S]*\.file-card-control/)
  assert.match(css, /\[data-file-card-shell\]:hover[\s\S]*\.file-card-control/)
  assert.match(css, /:focus-within[\s\S]*\.file-card-control/)
})

test('SELECT-V3-1 Files and Vault use one semantic selection action bar shell', () => {
  const shared = read('../src/components/SelectionActionBar.jsx')
  const files = read('../src/screens/Files.jsx')
  const vault = read('../src/screens/VaultTreeScreen.jsx')

  assert.match(shared, /bg-card/)
  assert.match(shared, /border-line/)
  assert.match(shared, /text-ink/)
  assert.doesNotMatch(shared, /bg-ink/)
  assert.match(files, /<SelectionActionBar/)
  assert.match(vault, /<SelectionActionBar/)
})

test('VAULT-V3-1 the prominent cluster is Refresh + Lock while Trash remains in secondary workspace navigation', () => {
  const source = read('../src/screens/VaultTreeScreen.jsx')
  const topStart = source.indexOf('data-testid="vault-tree-refresh"')
  const toolbarStart = source.indexOf('data-testid="vault-workspace-toolbar"')
  assert.ok(topStart >= 0 && toolbarStart > topStart)
  const prominent = source.slice(topStart, toolbarStart)
  assert.doesNotMatch(prominent, /vaultTreeMenuTrash/)
  assert.doesNotMatch(prominent, /vaultTreeViewActive/)
  assert.match(prominent, /lockVault/)
  assert.match(source.slice(toolbarStart), /data-testid="vault-workspace-view"/, 'Trash/active view remains reachable in the secondary toolbar')
})

test('MOVE-V3-1 Move picker uses dedicated All files copy without changing the Vault root identity', () => {
  const strings = read('../src/lib/strings.js')
  const screen = read('../src/screens/VaultTreeScreen.jsx')
  assert.match(strings, /vaultTreeMoveRootName: 'All files'/)
  assert.match(strings, /vaultTreeMoveRootName: 'ไฟล์ทั้งหมด'/)
  assert.match(strings, /vaultTreeRootName: 'ห้องนิรภัย'/)
  assert.match(screen, /dialog\?\.kind === 'move'[\s\S]*vaultTreeMoveRootName/)
})

test('MEDIA-V3-1 TREE_V1 wires GIF and video hover-hold motion and refreshes opaque inventory after upload', () => {
  const source = read('../src/screens/VaultTreeScreen.jsx')
  assert.match(source, /openVideoMotion/)
  assert.match(source, /isGif \|\| isVideo/)
  assert.match(source, /vaultApi\.refresh\(\)/)
  assert.match(source, /muted/)
  assert.match(source, /closePreviewSession/)
})

test('MEDIA-HIGHRES-1 TREE_V1 owns one decode-admission gate and delegates image byte ownership to makeImageThumb', () => {
  const source = read('../src/screens/VaultTreeScreen.jsx')
  assert.match(source, /createImageDecodeAdmission/)
  assert.match(source, /liveMemoryBytes:\s*\(\)\s*=>\s*schedulerRef\.current\?\.stats\(\)\.estMemBytes/)
  assert.match(source, /admission,\s*signal,\s*skipUrl:\s*true/)
  assert.match(source, /readChunk:\s*\(\)\s*=>\s*readNodeBytesRef\.current/)
  assert.doesNotMatch(source, /const bytes = await readNodeBytesRef\.current\([\s\S]{0,400}makeImageThumb/, 'screen must not retain a second outer plaintext reference')
  assert.match(source, /admission\?\.releaseAll/)
  assert.match(source, /vaultHighResPreviewTooLarge/)
})

test('PREVIEW-V3-1 TREE_V1 full video Preview retains the encrypted range-session path', () => {
  const source = read('../src/screens/VaultTreeScreen.jsx')
  assert.match(source, /previewStreamToken/)
  assert.match(source, /plainSize > MAX_PREVIEW_CEILING_BYTES[\s\S]*openPreviewSession/)
  assert.match(source, /data-vault-preview-streamed/)
  assert.doesNotMatch(source, /api\/files/)
})
