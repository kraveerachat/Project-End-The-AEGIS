#!/usr/bin/env node
// scripts/media-warmup.mjs — AEGIS Drive (IDEA1) · operator warm-up ของ media derivative (spec §21, plan Task 14)
//
//   docker compose exec drive node scripts/media-warmup.mjs [--limit N] [--rate PER_MINUTE] [--newest-first] [--dry-run] [--types poster,motion]
//
// ⚠️ ไม่มีวันรันเอง — operator เท่านั้น; แนะนำ --dry-run ก่อน แล้ว --limit 50 ก่อนรอบไม่จำกัด (spec §21)
// ⚠️ SELECT อย่างเดียวบนตาราง files; ไม่แตะต้นฉบับ; งานเข้าคิวที่ P2 ของ "โปรเซสนี้" (worker ของตัวเอง) และหยุดพักเมื่อ
//    /healthz ของ Drive ที่กำลังให้บริการรายงานว่ามีงาน P0/P1 รออยู่ (MEDIA_WARMUP_HEALTH_URL, ค่าเริ่มต้น http://127.0.0.1:8001/healthz)
// exit: 0 ok · 1 usage · 2 media tools missing/disabled · 3 database unreachable
import { parseWarmupArgs, runWarmup, WARMUP_USAGE, WarmupError } from '../server/media/warmup.js'

let opts
try { opts = parseWarmupArgs(process.argv.slice(2)) } catch (err) { console.error(err.message); process.exit(err.exitCode ?? 1) }
if (opts.help) { console.log(WARMUP_USAGE); process.exit(0) }

const { usingPostgres, query, closePool } = await import('../server/db/connection.js')
const store = await import('../server/db/store.js')
const { initStorage, STORAGE_ROOT, resolveKey, keyExists } = await import('../server/storage/fileStore.js')
const { bootMedia } = await import('../server/media/runtime.js')

// ฐานข้อมูลต้องตอบก่อน (ใน Production คือ DATABASE_URL เดียวกับ Drive); โหมด memory ใช้เพื่อพัฒนา/ทดสอบเท่านั้น
if (usingPostgres) {
  try { await query('SELECT 1') } catch (err) { console.error(`[media-warmup] database unreachable: ${err?.message ?? err}`); process.exit(3) }
}
await initStorage().catch((err) => { console.error(`[media-warmup] storage layer not ready: ${err?.message ?? err}`); process.exit(3) })

const media = await bootMedia({ env: process.env, resolveStorageKey: resolveKey, keyExists, storageRoot: STORAGE_ROOT, log: (line) => console.log(`[media-warmup] ${line}`) })
if (media.service.reason) { console.error(`[media-warmup] media unavailable: ${media.service.reason}`); await closePool?.().catch(() => {}); process.exit(2) }

const healthUrl = process.env.MEDIA_WARMUP_HEALTH_URL || `http://127.0.0.1:${process.env.PORT || 8001}/healthz`
let healthWarned = false
const interactivePending = async () => {
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) })
    const body = await res.json()
    return Number(body?.media?.queue?.interactive ?? 0)
  } catch (err) {
    if (!healthWarned) { healthWarned = true; console.warn(`[media-warmup] cannot read ${healthUrl} (${err?.message ?? err}) — proceeding without the interactive-pause signal`) }
    return 0
  }
}

let exitCode = 0
try {
  await media.service.start()
  const summary = await runWarmup({ store, service: media.service, interactivePending, ...opts, log: console.log })
  if (!opts.dryRun) {
    // รอให้งานที่โปรเซสนี้เข้าคิวไว้ทำจนจบ (worker ของโปรเซสนี้) — ค่อยปิด
    console.log('[media-warmup] waiting for queued jobs to settle…')
    await media.service.drain()
  }
  console.log(JSON.stringify({ summary }))
} catch (err) {
  console.error(`[media-warmup] ${err?.message ?? err}`)
  exitCode = err instanceof WarmupError ? err.exitCode : 1
} finally {
  await media.service.stop().catch(() => {})
  await closePool?.().catch(() => {})
}
process.exit(exitCode)
