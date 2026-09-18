// server/media/processRunner.js — AEGIS Drive (IDEA1) · ที่เดียวที่ media subsystem สร้าง child process
//
// ⚠️ สัญญา (spec §10.3, §17.7):
//    - spawn ด้วย argument array เท่านั้น, shell:false — ไม่มีการตีความ string ใดเป็นคำสั่ง
//    - env ของลูก = PATH/HOME/LANG เท่านั้น: DATABASE_URL, SESSION_SECRET, bootstrap credentials
//      ของ Drive ไม่มีวันถึง decoder
//    - stdout/stderr เก็บไว้ไม่เกิน stdioCapBytes แต่ "ระบายท่อต่อ" เสมอ (ลูกที่พูดมากต้องไม่ค้าง)
//    - timeout: SIGTERM แล้ว SIGKILL หลัง killGraceMs; AbortSignal ฆ่าได้เหมือนกัน
//    - ผลลัพธ์ไม่มี Buffer ของ media เลย — ตัวสร้าง derivative เขียนลงไฟล์ ไม่ใช่ท่อ
//    - metrics จาก /proc/<pid>/io และ /proc/<pid>/status (Linux, best-effort) เพื่อวัด I/O และ RSS จริง

import { spawn } from 'node:child_process'
import fs from 'node:fs'

export const MINIMAL_CHILD_ENV = Object.freeze({
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp',
  LANG: 'C',
})

const METRICS_SAMPLE_MS = 50

/**
 * @typedef {{ code: number|null, signal: string|null, stdout: string, stderr: string,
 *             stdoutTruncated: boolean, stderrTruncated: boolean,
 *             timedOut: boolean, killed: boolean, durationMs: number,
 *             metrics: { rchar: number, readBytes: number, vmHwmKb: number } | null }} RunResult
 */

function readProcMetrics(pid) {
  try {
    const io = fs.readFileSync(`/proc/${pid}/io`, 'utf8')
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
    const num = (text, key) => { const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text); return m ? Number(m[1]) : 0 }
    return { rchar: num(io, 'rchar'), readBytes: num(io, 'read_bytes'), vmHwmKb: num(status, 'VmHWM') }
  } catch {
    return null
  }
}

/**
 * @param {{ env?: Record<string,string>, cwd?: string, metrics?: boolean }} [opts]
 */
export function createProcessRunner({ env = MINIMAL_CHILD_ENV, cwd, metrics = process.platform === 'linux' } = {}) {
  /**
   * @param {{ bin: string, args?: string[], timeoutMs?: number, killGraceMs?: number,
   *           stdioCapBytes?: number, signal?: AbortSignal }} opts
   * @returns {Promise<RunResult>}
   */
  function run({ bin, args = [], timeoutMs = 10_000, killGraceMs = 2000, stdioCapBytes = 65_536, signal } = {}) {
    if (typeof bin !== 'string' || !bin || bin.includes('\0')) throw new TypeError('bin must be a non-empty string')
    if (!Array.isArray(args)) throw new TypeError('args must be an array of strings')
    for (const arg of args) {
      if (typeof arg !== 'string' || arg.includes('\0')) throw new TypeError('every argument must be a string without NUL')
    }
    const startedAt = Date.now()
    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(bin, args, { shell: false, env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        return reject(err)
      }
      let timedOut = false
      let killed = false
      let settled = false
      let termTimer = null
      let killTimer = null
      let sampler = null
      let lastMetrics = null

      // ⚠️ นับ "ไบต์ดิบ" ของท่อ ไม่ใช่ความยาว string: หลัง setEncoding('utf8') chunk.length คือจำนวน
      //    UTF-16 code unit ('é' = 1 หน่วยแต่ 2 ไบต์) ซึ่งทำให้เก็บเกินเพดานได้ถึง 2–3 เท่า จึงเก็บเป็น
      //    Buffer chunk ที่ตัดตามไบต์ แล้วแปลงเป็น string ครั้งเดียวตอนจบ — ท่อยังถูกระบายต่อเสมอ
      //    (ไม่ pause ไม่ถอด listener) และผลลัพธ์ที่ออกไปเป็น string เท่านั้น
      const capture = (stream) => {
        const state = { chunks: [], bytes: 0, truncated: false }
        stream.on('data', (chunk) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
          const room = stdioCapBytes - state.bytes
          if (room <= 0) { state.truncated = true; return }
          if (buf.length <= room) { state.chunks.push(buf); state.bytes += buf.length; return }
          state.chunks.push(buf.subarray(0, room))
          state.bytes += room
          state.truncated = true
        })
        stream.on('error', () => {})
        return state
      }
      const textOf = (state) => Buffer.concat(state.chunks, state.bytes).toString('utf8')
      const out = capture(child.stdout)
      const err = capture(child.stderr)

      const terminate = () => {
        killed = true
        try { child.kill('SIGTERM') } catch { /* already gone */ }
        killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, killGraceMs)
      }
      termTimer = setTimeout(() => { timedOut = true; terminate() }, timeoutMs)
      const onAbort = () => { if (!settled) terminate() }
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
      if (metrics && child.pid) {
        sampler = setInterval(() => { const m = readProcMetrics(child.pid); if (m) lastMetrics = m }, METRICS_SAMPLE_MS)
        const first = readProcMetrics(child.pid)
        if (first) lastMetrics = first
      }

      const finish = (code, sig, spawnError) => {
        if (settled) return
        settled = true
        clearTimeout(termTimer); clearTimeout(killTimer); clearInterval(sampler)
        signal?.removeEventListener('abort', onAbort)
        if (spawnError) return reject(spawnError)
        // ครั้งสุดท้ายก่อนปิด: โปรเซสอาจยังอยู่ใน /proc เป็น zombie ชั่วครู่ — best-effort เท่านั้น
        if (metrics && child.pid) { const m = readProcMetrics(child.pid); if (m) lastMetrics = m }
        resolve({
          code, signal: sig,
          stdout: textOf(out), stderr: textOf(err),
          stdoutTruncated: out.truncated, stderrTruncated: err.truncated,
          timedOut, killed, durationMs: Date.now() - startedAt,
          metrics: metrics ? lastMetrics : null,
        })
      }
      child.on('error', (e) => finish(null, null, e))
      // 'close' รอให้ท่อ stdio ปิดด้วย — ไม่ตัดผลลัพธ์ทิ้งกลางทาง
      child.on('close', (code, sig) => finish(code, sig, null))
    })
  }
  return { run }
}
