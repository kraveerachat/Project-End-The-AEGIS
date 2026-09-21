// scripts/measure/vault-tree/run-browser-bench.mjs — PR #157 Phase 0 · headless Chromium driver
//
// ⚠️ DISPOSABLE. Serves this directory over http://127.0.0.1:<port> with
//    Cross-Origin-Opener-Policy/Cross-Origin-Embedder-Policy headers (so
//    performance.measureUserAgentSpecificMemory() can work), launches a
//    Chromium-family browser headless with a throwaway profile in os.tmpdir(),
//    drives it over the Chrome DevTools Protocol (Node's global WebSocket), evaluates
//    one page-global bench function and writes its JSON result.
//
//    Firefox is not driven by this script (different remote protocol); if Firefox
//    is not installed the evidence note records NOT_MEASURED for it.
//
// Usage:
//   node scripts/measure/vault-tree/run-browser-bench.mjs \
//     --browser "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" \
//     --page manifest-bench.html --fn runManifestBench --arg '{"quick":true}' \
//     --out /tmp/chrome-manifest.json [--fixtures <dir>]
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (name, dflt = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt }
const browser = opt('--browser')
const page = opt('--page', 'manifest-bench.html')
const fn = opt('--fn', 'runManifestBench')
const arg = opt('--arg', '{}')
const out = opt('--out')
const fixturesOpt = opt('--fixtures', null)
const fixtures = fixturesOpt ? path.resolve(fixturesOpt) : null
const timeoutMs = Number(opt('--timeout-ms', '1800000'))
if (!browser || !out) { console.error('need --browser and --out'); process.exit(2) }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.bin': 'application/octet-stream' }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  let file
  const APP = path.resolve(HERE, '../../..') // IDEA1-AEGIS_Drive_LC — product modules + node_modules are served read-only
  if (url.pathname.startsWith('/fixtures/') && fixtures) file = path.join(fixtures, url.pathname.slice('/fixtures/'.length))
  else if (url.pathname.startsWith('/src/') || url.pathname.startsWith('/node_modules/')) file = path.join(APP, url.pathname.slice(1))
  else file = path.join(HERE, url.pathname === '/' ? page : url.pathname.slice(1))
  const allowed = file.startsWith(HERE) || (fixtures && file.startsWith(fixtures)) || file.startsWith(path.join(APP, 'src')) || file.startsWith(path.join(APP, 'node_modules'))
  if (!allowed) { res.writeHead(403); return res.end() }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end() }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  })
  fs.createReadStream(file).pipe(res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const pageUrl = `http://127.0.0.1:${port}/${page}`

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-vt-bench-profile-'))
const devPort = 9222 + Math.floor(Math.random() * 500)
const child = spawn(browser, [
  '--headless=new', `--remote-debugging-port=${devPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
  '--js-flags=--expose-gc', '--enable-precise-memory-info', 'about:blank',
], { stdio: 'ignore' })

async function waitForDevtools() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${devPort}/json/version`)
      if (r.ok) return r.json()
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('devtools endpoint did not come up')
}
const version = await waitForDevtools()
const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json()
const target = targets.find((t) => t.type === 'page')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let seq = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  else if (msg.method === 'Runtime.consoleAPICalled') {
    process.stderr.write('[page] ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ') + '\n')
  } else if (msg.method === 'Runtime.exceptionThrown') {
    process.stderr.write('[page-exception] ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 500) + '\n')
  }
}
const log = (m) => process.stderr.write('[driver] ' + m + '\n')
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })

// Process-level memory sampler: sums the working set of every browser process
// launched for this throwaway profile (renderer + GPU + utility), because decoded
// bitmaps and media buffers live outside the V8 heap and are invisible to
// performance.memory. Windows only (Win32_Process); elsewhere reports null.
function sampleProcessWorkingSet() {
  if (process.platform !== 'win32') return Promise.resolve(null)
  const needle = profile.replace(/'/g, "''") // -like treats backslashes literally; only quotes need escaping
  const ps = `$s = 0; Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' } | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p) { $s += $p.WorkingSet64 } }; [Console]::Out.Write($s)`
  return new Promise((resolve) => execFile('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true }, (err, stdout) => resolve(err ? null : Number(String(stdout).trim()) || null)))
}

let result
try {
  log('devtools ' + version.Browser)
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Runtime.addBinding', { name: '__aegisSampleProcessMemory' })
  const origOnMessage = ws.onmessage
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Runtime.bindingCalled' && msg.params.name === '__aegisSampleProcessMemory') {
      const reqId = msg.params.payload
      sampleProcessWorkingSet().then((bytes) => send('Runtime.evaluate', { expression: `(globalThis.__aegisMem ??= {})[${JSON.stringify(reqId)}] = ${bytes === null ? 'null' : bytes}` }))
      return
    }
    origOnMessage(ev)
  }
  await send('Page.navigate', { url: pageUrl })
  log('navigated ' + pageUrl)
  // wait for the module to define the bench function
  for (let i = 0; i < 100; i++) {
    const r = await send('Runtime.evaluate', { expression: `typeof globalThis[${JSON.stringify(fn)}]`, returnByValue: true })
    if (r.result?.result?.value === 'function') break
    await new Promise((r) => setTimeout(r, 100))
  }
  log('bench function ready; evaluating ' + fn + '(' + arg + ')')
  const evalRes = await Promise.race([
    send('Runtime.evaluate', {
      expression: `globalThis[${JSON.stringify(fn)}](${arg}).then((r) => JSON.stringify(r))`,
      awaitPromise: true, returnByValue: true, timeout: timeoutMs,
    }),
    new Promise((_, j) => setTimeout(() => j(new Error('bench timeout')), timeoutMs + 5_000)),
  ])
  if (evalRes.result?.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(evalRes.result.exceptionDetails).slice(0, 2000))
  result = JSON.parse(evalRes.result.result.value)
  result.browserVersion = version.Browser
  result.browserBinary = browser
  result.headless = true
} finally {
  try { ws.close() } catch {}
  child.kill()
  server.close()
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }) } catch {} }, 1_000)
}
fs.writeFileSync(out, JSON.stringify(result, null, 2))
console.log(`wrote ${out} (${result.rows?.length ?? 0} rows) browser=${result.browserVersion}`)
// The static server may hold keep-alive sockets open; exit explicitly once the profile is removed.
setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }) } catch {} process.exit(0) }, 1_500)
