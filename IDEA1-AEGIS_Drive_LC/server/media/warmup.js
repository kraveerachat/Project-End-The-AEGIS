// server/media/warmup.js — AEGIS Drive (IDEA1) · controlled warm-up ของ derivative สำหรับไฟล์ที่มีอยู่แล้ว (spec §21, plan Task 14)
//
// ⚠️ เป็นงานของ operator เท่านั้น (scripts/media-warmup.mjs) — ไม่มีวันรันเองตอนบูต และไม่ใช่ส่วนหนึ่งของ Production gate
// ⚠️ อ่านอย่างเดียว: store.iterateMediaCandidates เป็น SELECT (vault=false, kind='file', ไม่อยู่ในถัง, มี sha) — ไม่มี DB mutation
//    ความคืบหน้าอยู่ใน state.json ของ cache เอง (READY แล้ว = ข้าม) ไม่มีคอลัมน์/ตารางใหม่
// ⚠️ ผู้ใช้ที่กำลังใช้งานชนะเสมอ: enqueue ที่ P2 (WARMUP) ผ่าน token bucket (--rate ต่อนาที) และ "หยุดพัก" ทุกครั้งที่
//    เซิร์ฟเวอร์รายงานว่ามีงาน P0/P1 รออยู่ (interactivePending) — ไม่บล็อกเส้นทาง upload/preview ใด ๆ
// ⚠️ ไม่มีชื่อไฟล์ใน log: บรรทัด log มีแค่ id / sha ย่อ / ตัวนับ
import { PRIORITY } from './queue.js'

export const WARMUP_DEFAULT_RATE_PER_MINUTE = 30
export const WARMUP_TYPES = Object.freeze(['poster', 'motion'])
export const WARMUP_USAGE = `usage: node scripts/media-warmup.mjs [--limit N] [--rate PER_MINUTE] [--newest-first] [--dry-run] [--types poster,motion]

  --limit N          stop after N enqueued files (default: unbounded)
  --rate PER_MINUTE  token bucket for enqueues (default: ${WARMUP_DEFAULT_RATE_PER_MINUTE})
  --newest-first     scan newest rows first
  --dry-run          report what would be enqueued; enqueue nothing
  --types LIST       comma list of poster,motion (default: both)

exit codes: 0 ok · 1 usage · 2 media tools missing/disabled · 3 database unreachable`

export class WarmupError extends Error {
  constructor(code, message, exitCode) { super(message); this.name = 'WarmupError'; this.code = code; this.exitCode = exitCode }
}

/** แปลง argv ของ CLI — โยน WarmupError(exitCode 1) เมื่อผิดรูป */
export function parseWarmupArgs(argv) {
  const out = { limit: null, ratePerMinute: WARMUP_DEFAULT_RATE_PER_MINUTE, newestFirst: false, dryRun: false, types: [...WARMUP_TYPES], help: false }
  const usage = (msg) => new WarmupError('USAGE', `${msg}\n${WARMUP_USAGE}`, 1)
  const intArg = (name, value, { min }) => {
    const n = Number(value)
    if (!/^\d+$/.test(String(value ?? '')) || !Number.isInteger(n) || n < min) throw usage(`invalid ${name}: ${value}`)
    return n
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    switch (a) {
      case '--limit': out.limit = intArg('--limit', argv[++i], { min: 0 }); break
      case '--rate': out.ratePerMinute = intArg('--rate', argv[++i], { min: 1 }); break
      case '--newest-first': out.newestFirst = true; break
      case '--dry-run': out.dryRun = true; break
      case '--types': {
        const list = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        if (list.length === 0 || list.some((t) => !WARMUP_TYPES.includes(t))) throw usage(`invalid --types: ${argv[i]}`)
        out.types = [...new Set(list)]
        break
      }
      case '--help': case '-h': out.help = true; break
      default: throw usage(`unknown argument: ${a}`)
    }
  }
  return out
}

const terminalMotion = (m) => m === 'READY' || m === 'UNSUPPORTED' || m === 'GENERATION_FAILED'

/**
 * @param {{ store: { iterateMediaCandidates: Function }, service: object, interactivePending: () => Promise<number>,
 *           limit?: number|null, ratePerMinute?: number, newestFirst?: boolean, dryRun?: boolean, types?: string[],
 *           pageSize?: number, pausePollMs?: number, now?: () => number, sleep?: (ms: number) => Promise<void>, log?: Function }} o
 * @returns {Promise<{ scanned: number, skippedReady: number, enqueued: number, unsupported: number, failed: number, wouldEnqueue: number, dryRun: boolean, limit: number|null }>}
 */
export async function runWarmup({
  store, service, interactivePending, limit = null, ratePerMinute = WARMUP_DEFAULT_RATE_PER_MINUTE, newestFirst = false, dryRun = false,
  types = [...WARMUP_TYPES], pageSize = 200, pausePollMs = 500, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log,
}) {
  if (!service || service.reason) throw new WarmupError('TOOLS_MISSING', `media service unavailable (${service?.reason ?? 'no service'})`, 2)
  if (typeof store?.iterateMediaCandidates !== 'function') throw new WarmupError('DB_UNREACHABLE', 'store has no iterateMediaCandidates', 3)
  const wantMotion = types.includes('motion')
  const summary = { scanned: 0, skippedReady: 0, enqueued: 0, unsupported: 0, failed: 0, wouldEnqueue: 0, dryRun, limit }
  const intervalMs = Math.ceil(60_000 / Math.max(1, ratePerMinute))
  let nextSlotAt = now()
  const tag = (row) => `id=${row.id} sha=${String(row.sha256 ?? '').slice(0, 12)}`

  for await (const row of store.iterateMediaCandidates({ pageSize, newestFirst })) {
    if (limit != null && summary.enqueued >= limit) break
    summary.scanned += 1
    const peek = await service.peek(row)
    if (peek.status === 'UNSUPPORTED' || peek.status === 'NOT_FOUND') { summary.unsupported += 1; continue }
    if (peek.status === 'GENERATION_FAILED') { summary.failed += 1; continue }
    const posterReady = peek.poster?.state === 'READY'
    const motionDone = !wantMotion || terminalMotion(peek.motion?.state)
    if (posterReady && motionDone) { summary.skippedReady += 1; continue }
    if (dryRun) { summary.wouldEnqueue += 1; continue }
    // ผู้ใช้ที่กำลังใช้งานมาก่อน: มีงาน P0/P1 รอ = หยุดพักจนกว่าจะหมด
    for (;;) { const pending = await interactivePending(); if (!(pending > 0)) break; await sleep(pausePollMs) }
    // token bucket
    const wait = nextSlotAt - now()
    if (wait > 0) await sleep(wait)
    nextSlotAt = Math.max(now(), nextSlotAt) + intervalMs
    // หนึ่ง ensure ต่อไฟล์: poster ที่ยังไม่มี = งาน poster (service ต่อ motion ให้เองเมื่อ probe บอกว่าเคลื่อนไหว);
    // poster มีแล้วแต่ motion ยังไม่จบและถูกขอ = งาน motion
    const type = !posterReady ? 'poster' : 'motion'
    const accepted = Boolean(await service.ensure(row, type, PRIORITY.WARMUP))
    if (accepted) { summary.enqueued += 1; log(`[media-warmup] enqueued ${tag(row)} (${summary.enqueued}${limit != null ? `/${limit}` : ''})`) }
    else { summary.failed += 1; log(`[media-warmup] not accepted ${tag(row)}`) }
  }
  log(`[media-warmup] summary scanned=${summary.scanned} skippedReady=${summary.skippedReady} enqueued=${summary.enqueued} unsupported=${summary.unsupported} failed=${summary.failed}${dryRun ? ` wouldEnqueue=${summary.wouldEnqueue} (dry-run)` : ''}`)
  return summary
}
