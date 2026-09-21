// scripts/measure/vault-tree/media-bench-browser.js — PR #157 Phase 0 Task 0.2 · browser entry
//
// ⚠️ DISPOSABLE. Measures what a client-only Vault preview would cost in the
//    browser: image decode time/heap vs. bytes and pixels, scaled poster time,
//    animated GIF Object-URL heap, concurrent decode heap, retained Object URLs,
//    and a first-frame video poster via <video preload="metadata"> + canvas.
//    Fixtures are served by run-browser-bench.mjs under /fixtures/ (plaintext —
//    this bench measures decode cost only; decrypt cost is measured by the
//    manifest bench and is byte-linear).
import { memoryProbe } from './manifest-bench-browser.js'

const now = () => performance.now()
const MIB = 1_048_576

// Process working set sampled by the driver (see run-browser-bench.mjs). Decoded
// bitmaps/media buffers are outside the V8 heap, so this is the measure that a
// preview memory ceiling must be derived from. Falls back to the JS-heap probe,
// which is then labelled as such (it under-reports bitmaps).
async function processMemoryProbe() {
  if (typeof globalThis.__aegisSampleProcessMemory !== 'function') return null
  const read = async () => {
    if (typeof globalThis.gc === 'function') globalThis.gc()
    await new Promise((r) => setTimeout(r, 300))
    const id = 'm' + Math.random().toString(36).slice(2)
    globalThis.__aegisSampleProcessMemory(id)
    for (let i = 0; i < 200; i++) {
      if (globalThis.__aegisMem && id in globalThis.__aegisMem) { const v = globalThis.__aegisMem[id]; delete globalThis.__aegisMem[id]; return v }
      await new Promise((r) => setTimeout(r, 50))
    }
    return null
  }
  const first = await read()
  if (first === null) return null
  return { name: 'browser process working set (all processes of the throwaway profile, Win32_Process via driver; gc-forced)', read }
}

async function fetchBytes(name) {
  const r = await fetch('/fixtures/' + name)
  if (!r.ok) throw new Error('fixture ' + name + ' → ' + r.status)
  return new Uint8Array(await r.arrayBuffer())
}

function mimeOf(f) { return { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4' }[f.format] }

async function measureImage(f, memory) {
  const bytes = await fetchBytes(f.name)
  const m0 = memory ? await memory() : null
  let t = now()
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeOf(f) }))
  const decodeMs = now() - t
  const m1 = memory ? await memory() : null
  // scaled poster (longest edge 512) through OffscreenCanvas → Blob → Object URL
  t = now()
  const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height))
  const oc = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)))
  oc.getContext('2d').drawImage(bitmap, 0, 0, oc.width, oc.height)
  const posterBlob = await oc.convertToBlob({ type: 'image/webp', quality: 0.8 })
  const url = URL.createObjectURL(posterBlob)
  const posterMs = now() - t
  bitmap.close()
  URL.revokeObjectURL(url)
  return {
    name: f.name, format: f.format, bytes: f.bytes, pixels: f.pixels, width: f.width, height: f.height,
    decodeMs: +decodeMs.toFixed(1), posterMs: +posterMs.toFixed(1), posterBytes: posterBlob.size,
    decodeHeapDeltaMB: m0 == null ? 'NOT_MEASURED' : +((m1 - m0) / MIB).toFixed(1),
    expectedRgbaMB: +((f.pixels * 4) / MIB).toFixed(1),
  }
}

async function measureGif(f, memory) {
  const bytes = await fetchBytes(f.name)
  // static poster = first frame via createImageBitmap (decodes only frame 0)
  const m0 = memory ? await memory() : null
  let t = now()
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/gif' }))
  const posterMs = now() - t
  const m1 = memory ? await memory() : null
  bitmap.close()
  // animated playback: <img src=objectURL> attached to DOM, wait for load, sample heap while animating
  const m2 = memory ? await memory() : null
  t = now()
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/gif' }))
  const img = document.createElement('img')
  img.src = url
  document.body.appendChild(img)
  await new Promise((r, j) => { img.onload = r; img.onerror = j })
  const loadMs = now() - t
  await new Promise((r) => setTimeout(r, 1_500)) // let the animation run
  const m3 = memory ? await memory() : null
  img.remove()
  URL.revokeObjectURL(url)
  return {
    name: f.name, format: 'gif', bytes: f.bytes, frames: f.frames, pixelsPerFrame: f.pixelsPerFrame,
    posterDecodeMs: +posterMs.toFixed(1), posterHeapDeltaMB: m0 == null ? 'NOT_MEASURED' : +((m1 - m0) / MIB).toFixed(1),
    playLoadMs: +loadMs.toFixed(1), playHeapDeltaMB: m2 == null ? 'NOT_MEASURED' : +((m3 - m2) / MIB).toFixed(1),
    expectedAllFramesRgbaMB: +((f.frames * f.pixelsPerFrame * 4) / MIB).toFixed(1),
  }
}

async function measureConcurrency(f, counts, memory) {
  const bytes = await fetchBytes(f.name)
  const out = []
  for (const n of counts) {
    const m0 = memory ? await memory() : null
    const t = now()
    const bitmaps = await Promise.all(Array.from({ length: n }, () => createImageBitmap(new Blob([bytes], { type: mimeOf(f) }))))
    const ms = now() - t
    const m1 = memory ? await memory() : null
    bitmaps.forEach((b) => b.close())
    out.push({ fixture: f.name, concurrent: n, totalMs: +ms.toFixed(1), heapDeltaMB: m0 == null ? 'NOT_MEASURED' : +((m1 - m0) / MIB).toFixed(1) })
  }
  return out
}

async function measureObjectUrls(f, counts, memory) {
  // retained poster Object URLs: each is a ~512px webp blob
  const bytes = await fetchBytes(f.name)
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeOf(f) }))
  const oc = new OffscreenCanvas(512, 512)
  oc.getContext('2d').drawImage(bitmap, 0, 0, 512, 512)
  const blob = await oc.convertToBlob({ type: 'image/webp', quality: 0.8 })
  bitmap.close()
  const out = []
  for (const n of counts) {
    const m0 = memory ? await memory() : null
    const urls = []
    const imgs = []
    for (let i = 0; i < n; i++) {
      const u = URL.createObjectURL(blob.slice(0)) // distinct blob per URL
      urls.push(u)
      const img = document.createElement('img'); img.src = u; document.body.appendChild(img); imgs.push(img)
    }
    await Promise.all(imgs.map((img) => new Promise((r) => { img.onload = r; img.onerror = r })))
    const m1 = memory ? await memory() : null
    imgs.forEach((i) => i.remove()); urls.forEach((u) => URL.revokeObjectURL(u))
    out.push({ retainedUrls: n, posterBytes: blob.size, heapDeltaMB: m0 == null ? 'NOT_MEASURED' : +((m1 - m0) / MIB).toFixed(1) })
  }
  return out
}

async function measureVideoPoster(f, memory) {
  const m0 = memory ? await memory() : null
  const t = now()
  const video = document.createElement('video')
  video.muted = true; video.preload = 'metadata'; video.src = '/fixtures/' + f.name
  document.body.appendChild(video)
  await new Promise((r, j) => { video.onloadedmetadata = r; video.onerror = () => j(new Error('video error')) })
  const metaMs = now() - t
  video.currentTime = 0.5
  await new Promise((r) => { video.onseeked = r })
  const seekMs = now() - t - metaMs
  const oc = new OffscreenCanvas(512, Math.round(512 * video.videoHeight / video.videoWidth))
  oc.getContext('2d').drawImage(video, 0, 0, oc.width, oc.height)
  const poster = await oc.convertToBlob({ type: 'image/webp', quality: 0.8 })
  const totalMs = now() - t
  const m1 = memory ? await memory() : null
  video.remove()
  return {
    name: f.name, bytes: f.bytes, width: f.width, height: f.height,
    metadataMs: +metaMs.toFixed(1), seekMs: +seekMs.toFixed(1), posterTotalMs: +totalMs.toFixed(1), posterBytes: poster.size,
    heapDeltaMB: m0 == null ? 'NOT_MEASURED' : +((m1 - m0) / MIB).toFixed(1),
  }
}

globalThis.runMediaBench = async function runMediaBench({ maxMiB = 64 } = {}) {
  const probe = (await processMemoryProbe()) ?? (await memoryProbe())
  const memory = probe?.read ?? null
  const fx = await (await fetch('/fixtures/fixtures.json')).json()
  const ok = fx.fixtures.filter((f) => f.status === 'OK' && (f.targetMiB ?? 0) <= maxMiB)
  const images = [], gifs = [], concurrency = [], objectUrls = [], videos = [], errors = []
  for (const f of ok.filter((f) => ['jpeg', 'png', 'webp'].includes(f.format))) {
    try { const r = await measureImage(f, memory); images.push(r); console.log('image', JSON.stringify(r)) }
    catch (e) { errors.push({ name: f.name, error: String(e) }); console.log('image-error', f.name, String(e)) }
  }
  for (const f of ok.filter((f) => f.format === 'gif')) {
    try { const r = await measureGif(f, memory); gifs.push(r); console.log('gif', JSON.stringify(r)) }
    catch (e) { errors.push({ name: f.name, error: String(e) }); console.log('gif-error', f.name, String(e)) }
  }
  const four = ok.find((f) => f.format === 'jpeg' && f.targetMiB === 4)
  if (four) {
    try { concurrency.push(...await measureConcurrency(four, [1, 2, 4, 8], memory)); console.log('concurrency', JSON.stringify(concurrency)) } catch (e) { errors.push({ name: 'concurrency', error: String(e) }) }
    try { objectUrls.push(...await measureObjectUrls(four, [16, 64, 256, 1024], memory)); console.log('objectUrls', JSON.stringify(objectUrls)) } catch (e) { errors.push({ name: 'objectUrls', error: String(e) }) }
  }
  for (const f of ok.filter((f) => f.format === 'mp4')) {
    try { const r = await measureVideoPoster(f, memory); videos.push(r); console.log('video', JSON.stringify(r)) }
    catch (e) { errors.push({ name: f.name, error: String(e) }); console.log('video-error', f.name, String(e)) }
  }
  return {
    userAgent: navigator.userAgent, crossOriginIsolated: globalThis.crossOriginIsolated === true,
    memoryApi: probe?.name ?? 'NOT_MEASURED', deviceMemoryGiB: navigator.deviceMemory ?? 'NOT_MEASURED',
    tools: fx.tools, notMeasured: fx.fixtures.filter((f) => f.status !== 'OK'),
    images, gifs, concurrency, objectUrls, videos, errors,
  }
}
