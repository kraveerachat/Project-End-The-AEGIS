// server/media/processRunner.js — AEGIS Drive (IDEA1) · ที่เดียวที่ media subsystem สร้าง child process
//
// ⚠️ Task 1 (minimal): พอสำหรับ `ffmpeg -version` / `-encoders` / `-decoders` / `ffprobe -version`
//    ตอนตรวจ capability — อาร์กิวเมนต์เป็น array เสมอ ไม่มี shell, มี timeout ที่ TERM แล้ว KILL
//    สัญญาเต็ม (env ขั้นต่ำ, เพดาน stdio, AbortSignal, /proc metrics) เติมใน Task 3 ตามแผน

import { execFile } from 'node:child_process'

/**
 * @typedef {{ code: number|null, signal: string|null, stdout: string, stderr: string,
 *             timedOut: boolean, killed: boolean, durationMs: number, metrics: null }} RunResult
 */

export function createProcessRunner({ env = process.env, cwd } = {}) {
  /**
   * @param {{ bin: string, args: string[], timeoutMs?: number, killGraceMs?: number, stdioCapBytes?: number }} opts
   * @returns {Promise<RunResult>}
   */
  function run({ bin, args = [], timeoutMs = 10_000, killGraceMs = 2000, stdioCapBytes = 65_536 }) {
    if (typeof bin !== 'string' || !bin) throw new TypeError('bin must be a non-empty string')
    for (const arg of args) {
      if (typeof arg !== 'string' || arg.includes('\0')) throw new TypeError('every argument must be a string without NUL')
    }
    const startedAt = Date.now()
    return new Promise((resolve, reject) => {
      let timedOut = false
      let killTimer = null
      const child = execFile(bin, args, {
        shell: false, env, cwd, windowsHide: true, maxBuffer: stdioCapBytes, encoding: 'utf8',
      }, (err, stdout, stderr) => {
        clearTimeout(termTimer)
        clearTimeout(killTimer)
        if (err && err.code === 'ENOENT') return reject(err)
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
          signal: err?.signal ?? null,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut,
          killed: Boolean(err?.killed || timedOut),
          durationMs: Date.now() - startedAt,
          metrics: null,
        })
      })
      const termTimer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs)
      }, timeoutMs)
    })
  }
  return { run }
}
