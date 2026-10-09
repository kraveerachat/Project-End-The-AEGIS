// scripts/measure/vault-preview-index-browser-i3.mjs — D-1 PR-E Task I.3 · real Chrome acceptance (LOCAL, DISPOSABLE ONLY)
//
// Real Chrome (not jsdom) drives the BUILT `dist` of this checkout, served by the current server in-process on a
// disposable PostgreSQL 15 database (TEMPLATE aegis_drive_test, drive_app) behind a local proxy that strips the `/drive`
// prefix exactly like the gateway. The writer is ON locally only, with the HG-G approved budget (8,589,934,592 B).
// Never a Production URL, credential or volume. Evidence JSON is exclusive-create.
//
// Phases (one owner, real JPEG originals generated locally):
//   1. lock during backfill   — unlock, wait for the first preview-index upload, lock: no request after the lock settles,
//                               live Object URLs → 0
//   2. backfill               — unlock, let lazy backfill write thumbs from already-decrypted tile bytes; every original
//                               chunk is fetched at most once (no extra original GET for backfill)
//   3. derivative-first       — fresh unlock: tiles render with ZERO original chunk GETs; request counts recorded
//   4. upload                 — UI upload of new JPEGs: original commit precedes the preview-index upload of each
//   5. corruption fallback    — flip bytes of one stored derivative and one stored shard: only their tiles use originals
//   6. pagehide               — a real `pagehide` purges: locked UI, Object URLs → 0, no request afterwards
// Throughout: JS heap peak + live Object URL bytes vs the 256 MiB client ceiling; live Object URLs ≤ 256; no preview data
// in localStorage / sessionStorage / IndexedDB / Cache Storage.
//
// Usage (from IDEA1-AEGIS_Drive_LC/, after `npm run build` and scripts/pg-integration-env.sh up):
//   D1_I3_CONFIRMED=1 node scripts/measure/vault-preview-index-browser-i3.mjs --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe" \
//     --playwright-core <dir containing node_modules/playwright-core> --out "$SCRATCH/i3.json" [--files 24]
// Afterwards restore the tracked build output: `git checkout -- dist`.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const CHROME = arg('chrome'), PW_DIR = arg('playwright-core'), OUT = arg('out'), FILES = Number(arg('files', '24'))
const APPROVED_BUDGET_BYTES = 8_589_934_592
const CEILING_BYTES = 256 * 1024 * 1024
const MAX_OBJECT_URLS = 256
if (process.env.D1_I3_CONFIRMED !== '1') throw new Error('requires D1_I3_CONFIRMED=1 (local disposable acceptance only)')
if (!CHROME || !PW_DIR || !OUT) throw new Error('--chrome, --playwright-core and --out are required')
if (!Number.isSafeInteger(FILES) || FILES < 8 || FILES > 60) throw new Error('--files must be 8..60')
if (await fs.stat(OUT).then(() => true, () => false)) throw new Error(`--out already exists: ${OUT}`)
const db = new URL(process.env.TEST_DATABASE_URL ?? 'x:')
if (db.protocol !== 'postgresql:' || db.hostname !== '127.0.0.1' || db.username !== 'drive_app' || db.pathname !== '/aegis_drive_test') throw new Error('refuses a database outside the local disposable harness')
const here = path.dirname(fileURLToPath(import.meta.url))
const DRIVE = path.resolve(here, '../..')
await fs.access(path.join(DRIVE, 'dist/index.html'))
const { chromium } = createRequire(path.join(path.resolve(PW_DIR), 'package.json'))('playwright-core')

process.env.PI_UPLOAD_PG = '1'
const H = await import(pathToFileURL(path.join(DRIVE, 'tests/helpers/previewIndexUploadHarness.mjs')).href)
const { transportOf } = await import(pathToFileURL(path.join(DRIVE, 'tests/helpers/previewIndexOldClientSpec.mjs')).href)
const { currentPasswordOf } = await import(pathToFileURL(path.join(DRIVE, 'tests/helpers/testClient.mjs')).href)
const sharp = (await import('sharp')).default
const treeApi = await import(pathToFileURL(path.join(DRIVE, 'src/lib/vaultTreeApi.js')).href)
const { createVaultSetup } = await import(pathToFileURL(path.join(DRIVE, 'src/lib/vaultCrypto.js')).href)
const { runGenesis } = await import(pathToFileURL(path.join(DRIVE, 'src/lib/vaultTreeMigration.js')).href)
const { createTreeSession } = await import(pathToFileURL(path.join(DRIVE, 'src/lib/vaultTreeSync.js')).href)
const { uploadTreeFile } = await import(pathToFileURL(path.join(DRIVE, 'src/lib/vaultTreeUpload.js')).href)
const { createUnlockedVaultState } = await import(pathToFileURL(path.join(DRIVE, 'src/lib/vaultUnlockedState.js')).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => process.stderr.write(`[i3] ${m}\n`)
const result = { label: 'I3_CHROME_LOCAL_ACCEPTANCE', started: new Date().toISOString(), files: FILES, approvedRetainedBudgetBytes: APPROVED_BUDGET_BYTES, checks: {}, measurements: {} }
const check = (k, ok, detail) => { result.checks[k] = { result: ok ? 'PASS' : 'FAIL', detail }; log(`${k}: ${ok ? 'PASS' : 'FAIL'} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`) }

// ── stack ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const config = H.vaultTreeConfigFromEnv({
  VAULT_TREE_SCHEMA_AVAILABLE: 'true', VAULT_TREE_PROTOCOL_ENABLED: 'true', VAULT_TREE_GENESIS_MIGRATION_ENABLED: 'true', VAULT_TREE_UI_ENABLED: 'true',
  VAULT_MEDIA_PREVIEW_ENABLED: 'true', VAULT_DESTRUCTIVE_PURGE_ENABLED: 'false', VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE: 'true',
  VAULT_PREVIEW_INDEX_READ_ENABLED: 'true', VAULT_PREVIEW_INDEX_WRITE_ENABLED: 'true', VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER: String(APPROVED_BUDGET_BYTES),
})
await H.setup({ app: config })
await H.reset()
const upstream = new URL(H.base('app'))
const proxy = http.createServer((req, res) => {
  const p = req.url.startsWith('/drive/') ? req.url.slice(6) : req.url === '/drive' ? '/' : req.url
  // Host is kept as sent: the CSRF origin check compares Origin with Host, exactly as behind the gateway
  const out = http.request({ host: upstream.hostname, port: upstream.port, method: req.method, path: p, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res) })
  out.on('error', () => { res.statusCode = 502; res.end() })
  req.pipe(out)
})
await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
const ORIGIN = `http://127.0.0.1:${proxy.address().port}`
log(`stack ${ORIGIN}/drive/ → ${upstream.href}`)

let browser = null
const q = async (sql, params = []) => (await H.connection.query(sql, params)).rows
try {
  // ── seed (Node, current client modules): owner, Vault, TREE_V1, real JPEG originals without previews ─────────────
  const client = await H.login('app') // DEMO_USER; forced first-login reset handled by the test client
  const passphrase = `i3-local-${crypto.randomBytes(6).toString('hex')}`
  const setup = await createVaultSetup(passphrase, { memorySizeKiB: 19_456, iterations: 2, parallelism: 1 })
  if ((await client.req('/api/vault/setup', { method: 'POST', body: { saltB64: setup.saltB64, params: setup.params, verifier: setup.verifier } })).status !== 201) throw new Error('vault setup failed')
  const t = transportOf(client, treeApi)
  if ((await runGenesis({ kek: setup.kek, api: t.api })).protocolState !== 'TREE_V1') throw new Error('genesis failed')
  const session = createTreeSession({ kek: setup.kek, api: t.api, unlockedState: createUnlockedVaultState() })
  await session.loadHead()
  const jpeg = (i) => sharp({ create: { width: 1280, height: 960, channels: 3, background: { r: (i * 37) % 255, g: (i * 91) % 255, b: (i * 53) % 255 } } })
    .composite([{ input: Buffer.from(`<svg width="1280" height="960"><text x="80" y="480" font-size="220" fill="white">I3-${i}</text></svg>`), top: 0, left: 0 }]).jpeg({ quality: 85 }).toBuffer()
  for (let i = 0; i < FILES; i++) {
    const r = await uploadTreeFile({ kek: setup.kek, file: new File([await jpeg(i)], `i3-photo-${String(i).padStart(2, '0')}.jpg`, { type: 'image/jpeg' }), parentNodeId: session.head.manifest.rootNodeId, session, unlockedState: createUnlockedVaultState(), fetchJson: t.fetchJson, sendUpload: t.sendUpload, concurrency: 1 })
    if (!r.ok) throw new Error(`seed upload ${i}: ${r.stage} ${r.reason}`)
  }
  const userId = String((await H.connection.getUserByUsername(H.DEMO_USER.username)).id)
  const originals = async () => new Set((await q(`SELECT blob_id FROM vault_tree_blob_state WHERE user_id = $1 AND lifecycle = 'TREE_MANAGED'`, [userId])).map((r) => r.blob_id))
  const indexBlobs = async () => q(`SELECT s.blob_id, s.lifecycle, b.storage_key, b.ciphertext_size::int AS size FROM vault_tree_blob_state s JOIN vault_v2_blobs b ON b.id = s.blob_id AND b.user_id = s.user_id WHERE s.user_id = $1 AND s.lifecycle IN ('INDEX_STAGED','INDEX_MANAGED')`, [userId])
  const seeded = await originals()
  log(`seeded ${seeded.size} originals`)
  if (seeded.size !== FILES) throw new Error('seed count mismatch')

  // ── browser ───────────────────────────────────────────────────────────────────────────────────────────────────────
  browser = await chromium.launch({ executablePath: CHROME, headless: true })
  result.measurements.browserVersion = browser.version()
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 } })
  await context.addInitScript(() => {
    const live = new Map(); let peak = 0, peakBytes = 0, created = 0
    const c = URL.createObjectURL.bind(URL), r = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = (o) => { const u = c(o); live.set(u, o?.size ?? 0); created++; peak = Math.max(peak, live.size); peakBytes = Math.max(peakBytes, [...live.values()].reduce((a, b) => a + b, 0)); return u }
    URL.revokeObjectURL = (u) => { live.delete(u); return r(u) }
    globalThis.__i3 = () => ({ live: live.size, liveBytes: [...live.values()].reduce((a, b) => a + b, 0), peak, peakBytes, created })
  })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Performance.enable')
  const requests = []
  page.on('request', (r) => requests.push({ at: Date.now(), method: r.method(), url: r.url().replace(ORIGIN, '') }))
  let heapPeak = 0, sampling = true
  const sampler = (async () => { while (sampling) { try { const m = (await cdp.send('Performance.getMetrics')).metrics.find((x) => x.name === 'JSHeapUsedSize'); heapPeak = Math.max(heapPeak, m?.value ?? 0) } catch { /* page navigating */ } await sleep(250) } })()
  const urlStats = async () => page.evaluate(() => globalThis.__i3?.() ?? null).catch(() => null)
  let urlPeak = 0, urlPeakBytes = 0
  const trackUrls = async () => { const s = await urlStats(); if (s) { urlPeak = Math.max(urlPeak, s.peak); urlPeakBytes = Math.max(urlPeakBytes, s.peakBytes) } return s }

  // login through the real UI
  await page.goto(`${ORIGIN}/drive/`)
  await page.fill('input[autocomplete="username"]', H.DEMO_USER.username)
  await page.fill('input[autocomplete="current-password"]', currentPasswordOf(H.DEMO_USER.username))
  await page.click('button[type="submit"]')
  await page.waitForFunction(() => !document.querySelector('input[autocomplete="current-password"]'), null, { timeout: 30_000 })
  await page.goto(`${ORIGIN}/drive/vault`)
  const unlock = async () => {
    await page.getByRole('button', { name: /Unlock vault|ปลดล็อกห้องนิรภัย/ }).first().click({ timeout: 30_000 })
    await page.waitForSelector('#vault-key', { timeout: 30_000 })
    await page.fill('#vault-key', passphrase)
    await page.locator('#vault-key').press('Enter')
    await page.waitForSelector('[data-testid="vault-tree-screen"]', { timeout: 60_000 })
  }
  const lockUi = async () => { await page.getByRole('button', { name: /^s*(Lock vault|ล็อกห้องนิรภัย)s*$/ }).first().click(); await page.waitForSelector('[data-testid="locked-vault-preview"]', { timeout: 30_000 }) }
  const chunkGets = (from, to = Date.now()) => requests.filter((r) => r.at >= from && r.at <= to && r.method === 'GET' && /\/api\/vault\/blobs\/[0-9a-f]{48}\/chunks\/\d+/.test(r.url)).map((r) => r.url.match(/blobs\/([0-9a-f]{48})/)[1])
  const tilesRendered = () => page.locator('[data-testid="vault-files-section"] img[src^="blob:"]').count()
  const waitTiles = async (n, timeout = 60_000) => { const end = Date.now() + timeout; while (Date.now() < end) { if ((await tilesRendered()) >= n) return true; await trackUrls(); await sleep(250) } return false }
  const waitStable = async (fn, quietMs = 4000, timeout = 120_000) => { const end = Date.now() + timeout; let last = await fn(), since = Date.now(); while (Date.now() < end) { await sleep(500); await trackUrls(); const v = await fn(); if (v !== last) { last = v; since = Date.now() } else if (Date.now() - since >= quietMs) return last } return last }
  const visibleTarget = Math.min(FILES, 24)

  // 1. lock during backfill
  let t0 = Date.now()
  await unlock()
  const firstWrite = await (async () => { const end = Date.now() + 60_000; while (Date.now() < end) { if (requests.some((r) => r.at >= t0 && r.method === 'POST' && r.url.includes('/api/vault/tree/preview-index/uploads'))) return true; await sleep(100) } return false })()
  await lockUi()
  const lockedAt = Date.now()
  await sleep(500) // let any already-sent request settle
  const settled = Date.now()
  await sleep(4000)
  const afterLock = requests.filter((r) => r.at > settled && r.url.includes('/api/'))
  const s1 = await trackUrls()
  check('I3_LOCK_BACKFILL', firstWrite && afterLock.length === 0 && s1?.live === 0, { backfillStartedBeforeLock: firstWrite, apiRequestsAfterLockSettled: afterLock.length, liveObjectUrlsAfterLock: s1?.live, lockedAtMs: lockedAt - t0 })

  // 2. backfill to completion; no extra original GET
  t0 = Date.now()
  await unlock()
  await waitTiles(visibleTarget)
  const derivCount = async () => (await indexBlobs()).length
  await waitStable(derivCount)
  const t1 = Date.now()
  const gets2 = chunkGets(t0, t1)
  const origSeen = gets2.filter((id) => seeded.has(id))
  const perOriginal = {}; for (const id of origSeen) perOriginal[id] = (perOriginal[id] ?? 0) + 1
  const maxPerOriginal = Math.max(0, ...Object.values(perOriginal))
  const idx2 = await indexBlobs()
  check('I3_NO_EXTRA_ORIGINAL_GET', maxPerOriginal <= 1 && idx2.length > 0, { originalsFetched: Object.keys(perOriginal).length, maxChunkGetsPerOriginal: maxPerOriginal, indexBlobsAfterBackfill: idx2.length })
  await lockUi()

  // 3. derivative-first on a fresh unlock
  t0 = Date.now()
  await unlock()
  const rendered3 = await waitTiles(visibleTarget)
  await sleep(1500)
  const t3 = Date.now()
  const gets3 = chunkGets(t0, t3)
  const orig3 = gets3.filter((id) => seeded.has(id))
  const idxIds = new Set((await indexBlobs()).map((r) => r.blob_id))
  const api3 = requests.filter((r) => r.at >= t0 && r.at <= t3 && r.url.includes('/api/'))
  result.measurements.derivativeFirstColdRequests = { apiRequests: api3.length, chunkGets: gets3.length, indexObjectGets: gets3.filter((id) => idxIds.has(id)).length, originalGets: orig3.length }
  check('I3_DERIVATIVE_FIRST', rendered3 && orig3.length === 0 && gets3.some((id) => idxIds.has(id)), result.measurements.derivativeFirstColdRequests)

  // 4. UI upload: original commit precedes each preview-index upload
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-i3-upload-'))
  const upFiles = []
  for (let i = 0; i < 3; i++) { const p = path.join(tmp, `i3-upload-${i}.jpg`); await fs.writeFile(p, await jpeg(100 + i)); upFiles.push(p) }
  t0 = Date.now()
  const before4 = (await indexBlobs()).length
  await page.click('[data-testid="vault-tree-upload"]')
  await page.locator('[data-testid="vault-upload-input"]').setInputFiles(upFiles)
  await waitStable(derivCount, 5000)
  const reqs4 = requests.filter((r) => r.at >= t0 && r.method !== 'GET')
  const firstTreeCommit = reqs4.findIndex((r) => /\/api\/vault\/tree\/uploads\/[0-9a-f]{48}\/commit/.test(r.url))
  const firstPreviewUpload = reqs4.findIndex((r) => r.url.includes('/api/vault/tree/preview-index/uploads'))
  const added4 = (await indexBlobs()).length - before4
  check('I3_UPLOAD_ORIGINAL_FIRST', firstTreeCommit >= 0 && firstPreviewUpload > firstTreeCommit && added4 > 0, { firstTreeCommitIndex: firstTreeCommit, firstPreviewUploadIndex: firstPreviewUpload, indexBlobsAdded: added4 })
  await fs.rm(tmp, { recursive: true, force: true })
  await lockUi()

  // 5. corruption fallback: corrupt the CURRENT derivative of tile A and the CURRENT shard covering tile B (exact ids from
  //    the decrypted root + reader in Node, owner key known locally). Exactly A and the nodes of B's shard may fall back.
  const { createPreviewIndexReader } = await import(pathToFileURL(path.join(DRIVE, 'src/lib/vaultPreviewIndexReader.js')).href)
  const { openIndexObject } = await import(pathToFileURL(path.join(DRIVE, 'src/lib/vaultPreviewIndexObject.js')).href)
  const { decodeRoot } = await import(pathToFileURL(path.join(DRIVE, 'src/lib/vaultPreviewIndexCodec.js')).href)
  const { routingBits, prefixOf } = await import(pathToFileURL(path.join(DRIVE, 'src/lib/vaultPreviewIndexRouting.js')).href)
  const { INDEX_ROOT_MARKER, PREVIEW_INDEX_LIMITS: L } = await import(pathToFileURL(path.join(DRIVE, 'src/lib/vaultPreviewIndexConstants.js')).href)
  const view = createTreeSession({ kek: setup.kek, api: t.api, unlockedState: createUnlockedVaultState() })
  await view.loadHead()
  const piApi = {
    async getPreviewIndexHead() { const r = await t.fetchJson('/api/vault/tree/preview-index/head'); return r.status === 404 ? null : r.data },
    async getPreviewIndexEnvelopes(ids) { return (await t.fetchJson(`/api/vault/tree/preview-index/envelopes?ids=${ids.join(',')}`)).data.blobs },
  }
  const reader = createPreviewIndexReader({ kek: setup.kek, api: piApi, fetchBytes: t.fetchBytes })
  if ((await reader.load({ treeId: view.head.treeId, generation: view.head.generation, index: view.head.index })).status !== 'READY') throw new Error('node reader not READY')
  const files = [...view.head.index.nodes.values()].filter((n) => n.kind === 'file' && n.lifecycle?.state === 'active')
  const tiles = []
  for (const n of files) tiles.push({ nodeId: n.nodeId, original: n.blobRef.id, prefix: prefixOf(await routingBits(n.nodeId), L.initialPrefixBits), deriv: (await reader.lookup(n, 'thumb'))?.blobRef.id ?? null })
  const head = await piApi.getPreviewIndexHead()
  const [rootEnv] = await piApi.getPreviewIndexEnvelopes([head.rootBlobRef.id])
  const rootOpen = await openIndexObject({ kek: setup.kek, envelope: rootEnv, expected: { blobRef: head.rootBlobRef, contentId: head.rootContentIdB64 }, marker: INDEX_ROOT_MARKER, maxPaddedBytes: L.rootPaddingBuckets.at(-1), fetchBytes: t.fetchBytes })
  if (!rootOpen.ok) throw new Error(`root open ${rootOpen.reason}`)
  const root = decodeRoot(rootOpen.plaintext, { treeId: head.treeId, indexGeneration: head.indexGeneration })
  const A = tiles.find((x) => x.deriv)
  const B = tiles.find((x) => x.deriv && x.prefix !== A.prefix)
  const shardB = root.shards.find((sd) => B.prefix.startsWith(sd.prefix))
  const keyOf = async (id) => (await q('SELECT storage_key FROM vault_v2_blobs WHERE id = $1', [id]))[0].storage_key
  const flip = async (id) => { const p = path.join(process.env.STORAGE_ROOT, await keyOf(id)); const b = await fs.readFile(p); b[Math.floor(b.length / 2)] ^= 0xff; await fs.writeFile(p, b) }
  await flip(A.deriv); await flip(shardB.blobRef.id)
  const expected = new Set([A.original, ...tiles.filter((x) => !x.deriv || x.prefix.startsWith(shardB.prefix)).map((x) => x.original)])
  t0 = Date.now()
  await unlock()
  const rendered5 = await waitTiles(tiles.length)
  await sleep(2000)
  const orig5 = new Set(chunkGets(t0).filter((id) => tiles.some((x) => x.original === id)))
  const exact = orig5.size === expected.size && [...orig5].every((id) => expected.has(id))
  check('I3_CORRUPTION_FALLBACK', rendered5 && exact, { corrupted: { derivativeOfTileA: true, shardCoveringTileB: true }, expectedFallbackOriginals: expected.size, observedOriginalGets: orig5.size, exactMatch: exact, tilesRendered: await tilesRendered(), tiles: tiles.length })
  await lockUi()

  // 6. pagehide
  t0 = Date.now()
  await unlock()
  await waitTiles(1)
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })))
  await page.waitForSelector('[data-testid="locked-vault-preview"]', { timeout: 30_000 })
  const hid = Date.now()
  await sleep(500)
  const settled6 = Date.now()
  await sleep(3000)
  const s6 = await trackUrls()
  const after6 = requests.filter((r) => r.at > settled6 && r.url.includes('/api/vault'))
  check('I3_PAGEHIDE', s6?.live === 0 && after6.length === 0, { lockedUiAfterPagehide: true, liveObjectUrls: s6?.live, vaultRequestsAfter: after6.length, msToLock: hid - t0 })

  // storage + memory + Object URLs
  const storage = await page.evaluate(async () => ({ localStorage: localStorage.length, localStorageKeys: Object.keys(localStorage), localStorageValues: Object.keys(localStorage).map((k) => localStorage.getItem(k) ?? ''), sessionStorage: sessionStorage.length, indexedDB: (await indexedDB.databases?.())?.length ?? null, caches: (await caches.keys()).length }))
  // The pre-D-1 sealed upload-recovery record (aegis.vault.tree.uploads.recovery.v1.*, allowlisted opaque fields) is expected;
  // the invariant is: no preview/index store and no plaintext (names, MIME) anywhere in browser storage.
  const plaintextHit = storage.localStorageValues.some((v) => /i3-photo|i3-upload|image\/jpeg|image\/webp/.test(v))
  const { localStorageValues, ...storageEvidence } = storage
  check('I3_NO_PERSISTENT_PREVIEW_STORAGE', storage.indexedDB === 0 && storage.caches === 0 && storage.sessionStorage === 0 && !plaintextHit && storage.localStorageKeys.every((k) => !/preview|thumb|poster|deriv|kek/i.test(k)), { ...storageEvidence, plaintextInValues: plaintextHit, valueBytes: localStorageValues.map((v) => v.length) })
  await trackUrls()
  sampling = false; await sampler
  result.measurements.memory = { jsHeapUsedPeakBytes: heapPeak, liveObjectUrlBytesPeak: urlPeakBytes, combinedPeakBytes: heapPeak + urlPeakBytes, ceilingBytes: CEILING_BYTES }
  check('I3_MEMORY_LIMIT', heapPeak + urlPeakBytes < CEILING_BYTES, result.measurements.memory)
  check('I3_OBJECTURL_LIMIT', urlPeak <= MAX_OBJECT_URLS, { liveObjectUrlsPeak: urlPeak, limit: MAX_OBJECT_URLS })
  result.measurements.indexBlobsEnd = (await indexBlobs()).length
  result.measurements.requestsTotal = requests.length
} catch (e) {
  result.error = e?.stack ?? String(e)
  try { const pages = browser?.contexts()?.[0]?.pages() ?? []; if (pages[0]) await pages[0].screenshot({ path: `${OUT}.failure.png` }) } catch { /* best effort */ }
  log(`ERROR ${result.error}`)
} finally {
  if (browser) await browser.close()
  await new Promise((r) => proxy.close(r))
  await H.teardown()
  result.finished = new Date().toISOString()
  result.verdict = !result.error && Object.values(result.checks).every((c) => c.result === 'PASS') ? 'PASS' : 'FAIL'
  await fs.writeFile(OUT, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  log(`verdict ${result.verdict} → ${OUT}`)
  process.exitCode = result.verdict === 'PASS' ? 0 : 1
}
