// tests/vaultHighResWiring.test.js — AEGIS Drive (IDEA1) · PR220-R2 C/D · production wiring of the reduced lane
//
//   HRW-1  V2 image tiles stream decrypted chunks into makeImageThumb with the reduced decoder + capability
//   HRW-2  high-res admission defers while a Vault upload is active; the upload drawer reports its count
//   HRW-3  no server derivative / plaintext cache / upload-transport change is introduced by the wiring
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const code = (rel) => readFileSync(path.join(rootDir, rel), 'utf8').replace(/\/\/.*$/gm, '')

test('HRW-1 image tiles use the streamed two-lane path with the reduced decoder', () => {
  const screen = code('src/screens/VaultTreeScreen.jsx')
  assert.match(screen, /openVaultPlainChunks\(/, 'decrypted V2 chunks are pulled, not buffered whole')
  assert.match(screen, /openChunks:/)
  assert.match(screen, /reduced:\s*\{\s*capability:\s*detectReducedDecodeCapability\(\),\s*startJob:\s*startReducedDecodeJob\s*\}/)
})

test('HRW-2 high-res admission defers while a Vault upload is active', () => {
  const screen = code('src/screens/VaultTreeScreen.jsx')
  assert.match(screen, /deferHighRes:\s*\(\)\s*=>\s*activeUploadsRef\.current > 0/)
  assert.match(screen, /onActiveUploadsChange=/)
  const drawer = code('src/components/VaultUploadDrawer.jsx')
  assert.match(drawer, /activeReportRef\.current = onActiveUploadsChange/)
  assert.match(drawer, /activeReportRef\.current\?\.\(uploadingCount\)/, 'the drawer reports its real uploading count')
})

test('HRW-3 the wiring adds no server derivative, plaintext cache, or storage', () => {
  const screen = code('src/screens/VaultTreeScreen.jsx')
  assert.doesNotMatch(screen, /\/api\/vault\/[^'"`]*(thumb|poster|derivative)/i, 'no server-side thumbnail route')
  for (const rel of ['src/lib/vaultPlainChunkStream.js', 'src/lib/vaultImageThumb.js']) {
    assert.doesNotMatch(code(rel), /localStorage|sessionStorage|indexedDB|caches\.|fetch\(/, `${rel} keeps no plaintext cache`)
  }
})
