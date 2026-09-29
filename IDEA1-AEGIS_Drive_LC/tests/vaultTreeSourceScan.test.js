// tests/vaultTreeSourceScan.test.js — AEGIS Drive (IDEA1) · PR #157 · architecture boundary source scans
//
// ⚠️ เทสต์ชุดนี้ไม่รันโค้ด — มันอ่านซอร์สแล้วยืนยันขอบเขตสถาปัตยกรรมที่ห้ามข้าม:
//    SS-1  โมดูล Vault ฝั่ง client ไม่ import เซิร์ฟเวอร์, sharp, ffmpeg หรือท่อ media ของ Files
//    SS-2  เซิร์ฟเวอร์ไม่ import กฎของ tree (manifest/ops/canonical/rebase) — เซิร์ฟเวอร์ห้ามรู้กฎเหล่านี้
//    SS-3  โมดูล vault* ฝั่ง client ไม่แตะ localStorage/sessionStorage/indexedDB/Cache API
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function listFiles(dir, pred, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') listFiles(p, pred, out) }
    else if (pred(p)) out.push(p)
  }
  return out
}
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/')
const clientVaultFiles = () => [
  ...listFiles(path.join(ROOT, 'src/lib'), (p) => /[\\/]vault[^\\/]*\.js$/i.test(p) || /unicodeCaseFold\.js$/.test(p)),
  ...listFiles(path.join(ROOT, 'src/components/vault'), (p) => p.endsWith('.jsx') || p.endsWith('.js')),
  ...listFiles(path.join(ROOT, 'src'), (p) => /vaultPreviewServiceWorker\.js$/.test(p)),
]
const importsOf = (src) => [...src.matchAll(/(?:^|\n)\s*(?:import[^'"]*from\s*|import\s*\(\s*|export[^'"]*from\s*)['"]([^'"]+)['"]/g)].map((m) => m[1])

test('SS-1 client vault modules never import server code, sharp/ffmpeg, or the normal Files media pipeline', () => {
  const files = clientVaultFiles()
  assert.ok(files.length >= 8, `found ${files.length} client vault files`)
  const forbidden = [/(^|\/)server\//, /^sharp$/, /ffmpeg/i, /mediaApi\.js$/, /mediaScheduler\.js$/, /MediaThumb\.jsx$/, /useMediaTile\.js$/, /mediaTile\.js$/]
  for (const f of files) {
    for (const spec of importsOf(fs.readFileSync(f, 'utf8'))) {
      for (const re of forbidden) assert.doesNotMatch(spec, re, `${rel(f)} imports ${spec}`)
    }
  }
})

test('SS-2 server code never imports the tree rule modules (SRV-NOIMPORT-1)', () => {
  const files = listFiles(path.join(ROOT, 'server'), (p) => p.endsWith('.js') || p.endsWith('.mjs'))
  assert.ok(files.length > 10)
  const forbidden = /vaultTreeManifest\.js|vaultTreeOps\.js|vaultTreeCanonical\.js|vaultTreeRebase\.js|unicodeCaseFold\.js/
  for (const f of files) {
    for (const spec of importsOf(fs.readFileSync(f, 'utf8'))) assert.doesNotMatch(spec, forbidden, `${rel(f)} imports ${spec}`)
  }
})

test('SS-3 client vault modules contain no browser-storage or Cache API access', () => {
  const files = clientVaultFiles()
  const forbidden = /\b(localStorage|sessionStorage|indexedDB|caches\.open|caches\.match|caches\.keys|openDatabase)\b/
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/)
    let inBlock = false
    lines.forEach((line, i) => {
      if (line.includes('storage-absence-guard')) return
      // strip block comments (multi-line aware) and line comments before matching
      let code = ''
      let rest = line
      while (rest.length) {
        if (inBlock) { const end = rest.indexOf('*/'); if (end < 0) { rest = ''; break } inBlock = false; rest = rest.slice(end + 2); continue }
        const start = rest.indexOf('/*'); const lineC = rest.indexOf('//')
        if (start >= 0 && (lineC < 0 || start < lineC)) { code += rest.slice(0, start); inBlock = true; rest = rest.slice(start + 2); continue }
        if (lineC >= 0) { code += rest.slice(0, lineC); rest = ''; break }
        code += rest; rest = ''
      }
      assert.doesNotMatch(code, forbidden, `${rel(f)}:${i + 1}: ${line.trim().slice(0, 80)}`)
    })
  }
})
