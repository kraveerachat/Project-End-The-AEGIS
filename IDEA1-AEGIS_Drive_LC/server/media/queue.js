// server/media/queue.js — AEGIS Drive (IDEA1) · คิวงาน media ที่มีขอบเขต: dedup, ลำดับความสำคัญ, worker ตายตัว
//
// ⚠️ in-process และไม่ persist โดยเจตนา (spec §13): cache สร้างใหม่ได้ งานที่หายตอน restart จะถูก
//    ขอใหม่จากคำขอถัดไป — สิ่งที่คิว "ต้อง" รับประกันคือ (1) key เดียวกันไม่วิ่งซ้อน (2) P0 ก่อน P2
//    (3) ไม่เกิน concurrency ที่ตั้ง (4) ความลึกมีเพดาน: ล้น = ปฏิเสธทันที ไม่ใช่รอไม่มีที่สิ้นสุด
//    (5) งานพังหนึ่งงานไม่หยุดคิว (6) shutdown ยกเลิกงานที่วิ่งอยู่ผ่าน AbortSignal และปฏิเสธที่รอ

export const PRIORITY = Object.freeze({ INTERACTIVE: 0, UPLOAD: 1, WARMUP: 2 })
const LANES = [PRIORITY.INTERACTIVE, PRIORITY.UPLOAD, PRIORITY.WARMUP]

export class QueueFullError extends Error {
  constructor(maxDepth) { super(`media job queue is full (maxDepth ${maxDepth})`); this.name = 'QueueFullError'; this.code = 'QUEUE_FULL' }
}
export class QueueShutdownError extends Error {
  constructor(reason) { super(`media job queue is shut down${reason ? ` (${reason})` : ''}`); this.name = 'QueueShutdownError'; this.code = 'QUEUE_SHUTDOWN' }
}

/**
 * @param {{ concurrency?: number, maxDepth?: number, now?: () => number }} [opts]
 */
export function createJobQueue({ concurrency = 1, maxDepth = 500, now = Date.now } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('concurrency must be a positive integer')
  if (!Number.isInteger(maxDepth) || maxDepth < 1) throw new TypeError('maxDepth must be a positive integer')

  /** @type {Map<string, Job>} */
  const jobs = new Map()
  /** @type {Record<number, Job[]>} */
  const lanes = { 0: [], 1: [], 2: [] }
  let running = 0
  let completed = 0
  let failed = 0
  let shutdownReason = null

  const normalisePriority = (p) => (LANES.includes(p) ? p : PRIORITY.WARMUP)

  function nextJob() {
    for (const lane of LANES) {
      if (lanes[lane].length) return lanes[lane].shift()
    }
    return null
  }

  function pump() {
    while (running < concurrency && shutdownReason === null) {
      const job = nextJob()
      if (!job) return
      job.state = 'running'
      running += 1
      job.startedAt = now()
      // ⚠️ ปรับสถานะคิว (running/jobs) "ก่อน" resolve/reject: ผู้รอผลต้องเห็นคิวที่สอดคล้องแล้ว
      const settle = () => { running -= 1; jobs.delete(job.key) }
      Promise.resolve()
        .then(() => job.run({ signal: job.controller.signal }))
        .then(
          (value) => { settle(); completed += 1; job.resolve(value); pump() },
          (err) => { settle(); failed += 1; job.reject(err); pump() },
        )
    }
  }

  /**
   * @param {string} key   dedup key (เช่น `v1/<sha>/poster`)
   * @param {number} priority
   * @param {(ctx: { signal: AbortSignal }) => Promise<any>} run
   * @returns {{ promise: Promise<any>, deduplicated: boolean }}
   */
  function enqueue(key, priority, run) {
    if (typeof key !== 'string' || !key) throw new TypeError('job key must be a non-empty string')
    if (typeof run !== 'function') throw new TypeError('run must be a function')
    if (shutdownReason !== null) return { promise: Promise.reject(new QueueShutdownError(shutdownReason)), deduplicated: false }
    const wanted = normalisePriority(priority)
    const existing = jobs.get(key)
    if (existing) {
      promote(key, wanted)
      return { promise: existing.promise, deduplicated: true }
    }
    if (jobs.size >= maxDepth) return { promise: Promise.reject(new QueueFullError(maxDepth)), deduplicated: false }
    let resolve, reject
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    // ผู้เรียกที่ไม่สนใจผล (fire-and-forget) ต้องไม่ทำให้เกิด unhandled rejection
    promise.catch(() => {})
    const job = { key, priority: wanted, run, resolve, reject, promise, state: 'queued', controller: new AbortController(), enqueuedAt: now(), startedAt: null }
    jobs.set(key, job)
    lanes[wanted].push(job)
    pump()
    return { promise, deduplicated: false }
  }

  /** ย้ายงานที่ "รออยู่" ไปเลนที่สำคัญกว่า — งานที่วิ่งอยู่หรือลดความสำคัญ = no-op */
  function promote(key, priority) {
    const job = jobs.get(key)
    const wanted = normalisePriority(priority)
    if (!job || job.state !== 'queued' || wanted >= job.priority) return false
    const lane = lanes[job.priority]
    const idx = lane.indexOf(job)
    if (idx >= 0) lane.splice(idx, 1)
    job.priority = wanted
    lanes[wanted].push(job)
    pump()
    return true
  }

  const has = (key) => jobs.has(key)
  const size = () => jobs.size
  const runningCount = () => running
  const stats = () => ({
    depth: LANES.reduce((n, lane) => n + lanes[lane].length, 0),
    running,
    byPriority: { 0: lanes[0].length, 1: lanes[1].length, 2: lanes[2].length },
    completed,
    failed,
  })

  /** ยกเลิกงานที่วิ่งอยู่ (abort) และปฏิเสธงานที่รอ; หลังจากนี้ enqueue ถูกปฏิเสธเสมอ */
  async function shutdown({ reason = 'shutdown' } = {}) {
    if (shutdownReason !== null) return
    shutdownReason = reason
    const error = new QueueShutdownError(reason)
    for (const lane of LANES) {
      for (const job of lanes[lane].splice(0)) { jobs.delete(job.key); job.reject(error) }
    }
    for (const job of jobs.values()) {
      if (job.state === 'running') job.controller.abort(new Error(reason))
    }
  }

  return Object.freeze({ enqueue, promote, has, size, running: runningCount, stats, shutdown, isShutdown: () => shutdownReason !== null })
}
