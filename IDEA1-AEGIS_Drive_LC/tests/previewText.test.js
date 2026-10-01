// tests/previewText.test.js — AEGIS Drive (IDEA1) · Unified Preview P1 · T-TEXT
//
// Text-family previews read a bounded HEAD of the file (1 MiB) and render it as inert text: React text
// nodes inside <pre>, never HTML. An .html/.svg file is shown as its source — <script>/<svg>/<iframe>
// elements must never exist in the rendered tree.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'
import { makeT } from '../src/lib/strings.js'
import { readTextHead, decodeTextBytes } from '../src/lib/preview/textHead.js'
import { resolveCapability, previewKindOf, previewModeOf } from '../src/lib/preview/registry.js'
import { detectFormat } from '../src/lib/preview/formats.js'
import { VAULT_TREE_CLIENT_LIMITS } from '../src/lib/vaultTreeLimits.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const t = makeT('en')
const MAX = VAULT_TREE_CLIENT_LIMITS.textPreviewMaxBytes
const enc = (s) => new TextEncoder().encode(s)

test('TX-1 Files source: Range bytes=0-(1 MiB-1); 206 total above 1 MiB → truncated; 200 small → not truncated', async () => {
  const calls = []
  const big = async (url, init) => {
    calls.push({ url, range: init?.headers?.Range, credentials: init?.credentials })
    return { ok: true, status: 206, headers: { get: (h) => (h.toLowerCase() === 'content-range' ? `bytes 0-${MAX - 1}/${MAX * 3}` : null) }, arrayBuffer: async () => enc('a'.repeat(10)).buffer }
  }
  const r = await readTextHead({ kind: 'files', url: '/api/files/9/preview' }, { maxBytes: MAX, fetchImpl: big })
  assert.deepEqual(calls, [{ url: '/api/files/9/preview', range: `bytes=0-${MAX - 1}`, credentials: 'same-origin' }])
  assert.equal(r.truncated, true); assert.equal(r.text, 'a'.repeat(10)); assert.equal(r.encoding, 'utf-8')
  const small = async () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => enc('hello').buffer })
  assert.deepEqual(await readTextHead({ kind: 'files', url: '/x' }, { maxBytes: MAX, fetchImpl: small }), { text: 'hello', truncated: false, encoding: 'utf-8' })
  const fail = async () => ({ ok: false, status: 415, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) })
  await assert.rejects(readTextHead({ kind: 'files', url: '/x' }, { maxBytes: MAX, fetchImpl: fail }), /415/)
})

test('TX-2 Vault source: only the plaintext range [0, 1 MiB) is requested; longer files are truncated', async () => {
  const asked = []
  const r = await readTextHead({ kind: 'vault', totalBytes: MAX + 5, readPlainRange: async (s, e) => { asked.push([s, e]); return enc('x'.repeat(20)) } }, { maxBytes: MAX })
  assert.deepEqual(asked, [[0, MAX]])
  assert.equal(r.truncated, true)
  const s = await readTextHead({ kind: 'vault', totalBytes: 3, readPlainRange: async () => enc('abc') }, { maxBytes: MAX })
  assert.deepEqual(s, { text: 'abc', truncated: false, encoding: 'utf-8' })
})

test('TX-3 decoding: UTF-8 BOM stripped, UTF-16 LE/BE by BOM, invalid UTF-8 replaced (never throws), cut multibyte tail dropped', () => {
  assert.deepEqual(decodeTextBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])), { text: 'hi', encoding: 'utf-8' })
  assert.deepEqual(decodeTextBytes(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])), { text: 'hi', encoding: 'utf-16le' })
  assert.deepEqual(decodeTextBytes(new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69])), { text: 'hi', encoding: 'utf-16be' })
  assert.equal(decodeTextBytes(new Uint8Array([0x61, 0xc3, 0x28, 0x62])).text, 'a�(b')
  const thai = enc('ไทย')
  assert.equal(decodeTextBytes(thai.subarray(0, 7), { truncated: true }).text, 'ไท', 'an incomplete trailing character from the byte cap is dropped')
})

test('TX-4 registry: text family → a text provider in Files and the Vault; tiles stay image/video', () => {
  for (const name of ['a.txt', 'a.LOG', 'a.svg', 'page.html', 'a.xml', 'main.js', 'x.py', 'a.yaml', 'a.md', 'a.json', 'a.csv', 'a.tsv']) {
    for (const ctx of ['files', 'vault']) {
      const cap = resolveCapability({ ...detectFormat({ name }), size: 1 }, ctx, {})
      assert.equal(cap.state, 'available', `${ctx} ${name}`)
      assert.equal(previewModeOf(cap), 'text', `${ctx} ${name}`)
      assert.equal(previewKindOf(cap), null, `${ctx} ${name}: no tile media`)
      assert.equal(cap.tile, 'icon')
    }
  }
  assert.equal(resolveCapability({ ...detectFormat({ name: 'a.txt' }), size: 1 }, 'vault', {}).verify, 'signature', 'Vault confirms text-likeness from decrypted bytes first')
})

/* ── renderer ─────────────────────────────────────────────────────────── */

let vite, textModule, filesModule
before(async () => {
  vite = await createServer({ configFile: false, root: rootDir, appType: 'custom', logLevel: 'silent', plugins: [reactPlugin()], server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] } })
  textModule = await vite.ssrLoadModule('/src/components/preview/providers/TextPreview.jsx').catch((e) => ({ loadError: e }))
  filesModule = await vite.ssrLoadModule('/src/screens/Files.jsx')
})
after(async () => { await vite?.close() })

async function mount(fetchImpl) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const w = dom.window
  w.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })
  const previous = new Map()
  const globals = { window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, fetch: fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => ({}) })) }
  for (const [k, v] of Object.entries(globals)) { previous.set(k, Object.getOwnPropertyDescriptor(globalThis, k)); Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v }) }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(w.document.getElementById('root'))
  return {
    render: (el) => act(async () => { root.render(el) }),
    settle: () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) }),
    unmount: async () => { await act(async () => root.unmount()); for (const [k, d] of previous) { if (d === undefined) delete globalThis[k]; else Object.defineProperty(globalThis, k, d) } w.close() },
  }
}

const ACTIVE = '<!doctype html><html><body onload="alert(1)"><script>alert(1)</script><iframe src="javascript:alert(2)"></iframe><svg onload="alert(3)"><circle/></svg><img src=x onerror="alert(4)"></body></html>'

test('TX-5 TextPreview renders active HTML/SVG as literal text in <pre>; no script/svg/iframe/img element exists; truncation banner', async () => {
  assert.equal(textModule.loadError, undefined, String(textModule.loadError?.message ?? ''))
  const m = await mount()
  try {
    await m.render(React.createElement(textModule.TextPreview, { t, text: ACTIVE, truncated: true, maxBytes: MAX }))
    const pre = document.querySelector('pre')
    assert.ok(pre)
    assert.equal(pre.textContent, ACTIVE)
    assert.equal(document.querySelector('#root').querySelector('script, svg, iframe, img, object, embed, a[href]'), null)
    assert.ok(document.body.textContent.includes(t('previewTextTruncated', { size: '1 MB' }).slice(0, 18)) || document.querySelector('[data-preview-truncated]'), 'truncation notice')
    assert.ok(document.querySelector('[data-preview-truncated]'))
  } finally { await m.unmount() }
})

test('TX-6 Files modal: page.html is fetched with a bounded Range and shown as source text, never rendered', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), range: init?.headers?.Range })
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => enc(ACTIVE).buffer, json: async () => ({}) }
  }
  const m = await mount(fetchImpl)
  try {
    await m.render(React.createElement(filesModule.FilePreviewModal, { t, file: { id: 'h1', name: 'page.html', kind: 'file', size: ACTIVE.length }, onClose() {}, onDownload() {} }))
    await m.settle()
    const previewCall = seen.find((c) => c.url.endsWith('/api/files/h1/preview'))
    assert.ok(previewCall, 'fetched the owner-only preview route')
    assert.equal(previewCall.range, `bytes=0-${MAX - 1}`)
    const body = document.querySelector('[data-preview-shell]')
    assert.equal(body.getAttribute('data-preview-state'), 'ready')
    assert.equal(body.querySelector('pre')?.textContent, ACTIVE)
    assert.equal(body.querySelector('script, svg, iframe, img'), null)
    assert.equal(document.querySelector('[data-preview-download]').disabled, false)
  } finally { await m.unmount() }
})

test('TX-7 Files modal: a 415 (server signature mismatch) becomes a failure with Download still enabled', async () => {
  const m = await mount(async () => ({ ok: false, status: 415, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) }))
  try {
    await m.render(React.createElement(filesModule.FilePreviewModal, { t, file: { id: 'b1', name: 'bin.txt', kind: 'file', size: 10 }, onClose() {}, onDownload() {} }))
    await m.settle()
    assert.equal(document.querySelector('[data-preview-shell]').getAttribute('data-preview-state'), 'failed')
    assert.equal(document.querySelector('[data-preview-download]').disabled, false)
  } finally { await m.unmount() }
})

test('TX-8 Vault head read stops after the chunk that crosses 1 MiB — later chunks are never fetched/decrypted', async () => {
  const { readVaultPlainHead } = await import('../src/lib/preview/vaultTextHead.js')
  const CH = 700 * 1024
  let fetched = 0
  const download = async ({ sink, signal }) => {
    for (let i = 0; i < 4; i++) {
      if (signal.aborted) return { ok: false, reason: 'cancelled' }
      fetched += 1
      await sink.write(new Uint8Array(CH).fill(0x41 + i))
    }
    return { ok: true }
  }
  const head = await readVaultPlainHead({ download, maxBytes: MAX, plainSize: CH * 4 })
  assert.equal(head.length, MAX)
  assert.equal(fetched, 2, 'two 700 KiB chunks cover 1 MiB; chunks 3 and 4 are never requested')
  assert.equal(head[0], 0x41); assert.equal(head[MAX - 1], 0x42)
  const small = await readVaultPlainHead({ download: async ({ sink }) => { await sink.write(enc('tiny')); return { ok: true } }, maxBytes: MAX, plainSize: 4 })
  assert.equal(new TextDecoder().decode(small), 'tiny')
  await assert.rejects(readVaultPlainHead({ download: async () => ({ ok: false, reason: 'auth-failed' }), maxBytes: MAX, plainSize: 10 }), /auth-failed/)
})
