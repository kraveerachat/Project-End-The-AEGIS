// server/media/eviction.js — AEGIS Drive (IDEA1) · LRU eviction ของ media cache ที่สร้างใหม่ได้
//
// ⚠️ spec §19: ดัชนีในหน่วยความจำ (sha → bytes, lastAccess) สร้างจากการ scan ครั้งเดียวตอน start แล้วอัปเดต
//    จากงาน/การเสิร์ฟ; เกิน high-water (MEDIA_CACHE_MAX_BYTES) → ลบ entry ทั้งก้อนเรียงจากเข้าถึงเก่าสุดจน
//    ≤ low-water; ไดเรกทอรี profile เก่าไปก่อนเสมอ; entry ที่มีงานค้างหรือเพิ่งถูกเสิร์ฟ (< 60 s) ถูก pin;
//    การลบล้มเหลวหนึ่งรายการไม่หยุดรอบ — cache ไม่ใช่ source of truth จึงลบได้เสมอ ไม่ผูกกับการลบไฟล์ผู้ใช้

export const PIN_RECENT_MS = 60_000

/**
 * @param {{ cache: object, cacheForProfile: (profile: string) => object, limits: object, isPinned?: (sha: string) => boolean,
 *           now?: () => number, log?: Function, setIntervalFn?: Function, clearIntervalFn?: Function }} o
 */
export function createEvictor({ cache, cacheForProfile, limits, isPinned = () => false, now = Date.now, log = () => {}, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  /** @type {Map<string, { sha: string, profile: string, bytes: number, lastAccess: number }>} */
  const index = new Map()
  let total = 0
  let lastEvictionAt = null
  let passing = false
  const keyOf = (profile, sha) => `${profile}/${sha}`

  async function buildIndex() {
    index.clear(); total = 0
    for await (const e of cache.scanEntries()) {
      const lastAccess = typeof e.lastAccess === 'number' ? e.lastAccess : (e.lastAccess ? Date.parse(e.lastAccess) : 0)
      index.set(keyOf(e.profile, e.sha), { sha: e.sha, profile: e.profile, bytes: e.bytes, lastAccess: Number.isFinite(lastAccess) ? lastAccess : 0 })
      total += e.bytes
    }
    return { entries: index.size, bytes: total }
  }

  function record(sha, bytes, at = now()) {
    const key = keyOf(cache.profile, sha)
    const prev = index.get(key)
    if (prev) total -= prev.bytes
    index.set(key, { sha, profile: cache.profile, bytes, lastAccess: Math.max(prev?.lastAccess ?? 0, at) })
    total += bytes
  }
  function touch(sha, at = now()) {
    const e = index.get(keyOf(cache.profile, sha))
    if (e) e.lastAccess = Math.max(e.lastAccess, at)
  }
  function remove(sha, profile = cache.profile) {
    const key = keyOf(profile, sha)
    const e = index.get(key)
    if (!e) return false
    index.delete(key); total -= e.bytes
    return true
  }

  async function evictTo(targetBytes) {
    const t = now()
    const candidates = [...index.values()]
      .filter((e) => !(e.profile === cache.profile && (isPinned(e.sha) || t - e.lastAccess < PIN_RECENT_MS)))
      .sort((a, b) => {
        const aStale = a.profile !== cache.profile, bStale = b.profile !== cache.profile
        if (aStale !== bStale) return aStale ? -1 : 1
        return a.lastAccess - b.lastAccess
      })
    let evicted = 0, bytesFreed = 0
    for (const e of candidates) {
      if (total <= targetBytes) break
      try {
        const target = e.profile === cache.profile ? cache : cacheForProfile(e.profile)
        await target.removeEntry(e.sha)
        remove(e.sha, e.profile)
        evicted += 1; bytesFreed += e.bytes
      } catch (err) {
        log(`[media] eviction skipped ${e.profile}/${e.sha.slice(0, 12)}: ${err?.code ?? err?.message ?? err}`)
      }
    }
    if (evicted) lastEvictionAt = new Date(t).toISOString()
    return { evicted, bytesFreed }
  }

  async function runIfNeeded() {
    if (passing) return { evicted: 0, bytesFreed: 0 }
    if (total <= limits.cacheMaxBytes) return { evicted: 0, bytesFreed: 0 }
    passing = true
    try {
      return await evictTo(Math.floor(limits.cacheMaxBytes * limits.cacheLowWater))
    } finally {
      passing = false
    }
  }

  function schedule(intervalMs) {
    const handle = setIntervalFn(() => runIfNeeded().catch((err) => log(`[media] eviction pass failed: ${err?.message ?? err}`)), intervalMs)
    if (handle && typeof handle.unref === 'function') handle.unref()
    return () => clearIntervalFn(handle)
  }

  return Object.freeze({
    buildIndex, record, touch, remove, evictTo, runIfNeeded, schedule,
    totalBytes: () => total,
    entries: () => [...index.values()].map((e) => ({ ...e })),
    lastEvictionAt: () => lastEvictionAt,
  })
}
