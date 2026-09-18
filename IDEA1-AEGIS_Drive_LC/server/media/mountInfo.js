// server/media/mountInfo.js — AEGIS Drive (IDEA1) · MEDIA_CACHE_DIR เป็น mountpoint จริงหรือไม่
//
// ⚠️ อ่านจาก /proc/self/mountinfo เท่านั้น (Linux): "volume" = มีบรรทัดที่ mount point เท่ากับ
//    target พอดี, "ephemeral" = ไม่มีบรรทัดนั้นแต่ไดเรกทอรีใช้งานได้ (อยู่ใน writable layer ของ
//    คอนเทนเนอร์ → หายเมื่อ recreate), "unknown" = อ่านไม่ได้/แพลตฟอร์มไม่รองรับ/ไดเรกทอรีใช้ไม่ได้
// ⚠️ ห้ามใช้ device id ของ stat โดยเจตนา — ไม่ใช่สัญญาของ mountpoint (spec §10.4)
//    Production acceptance ต้องได้ 'volume'

import fsp from 'node:fs/promises'
import path from 'node:path'

/** ถอด octal escape ของ mountinfo: \040 (space) \011 (tab) \012 (newline) \134 (backslash) */
function unescapeField(field) {
  return field.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
}

/**
 * @param {string} text
 * @returns {Array<{ mountId: number, parentId: number, root: string, mountPoint: string }>}
 */
export function parseMountInfo(text) {
  const rows = []
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    // ฟิลด์: id parent major:minor root mount_point options [optional…] - fstype source super_options
    const fields = line.split(/\s+/)
    if (fields.length < 6) continue
    const mountId = Number(fields[0])
    const parentId = Number(fields[1])
    if (!Number.isInteger(mountId) || !Number.isInteger(parentId)) continue
    rows.push({ mountId, parentId, root: fields[3], mountPoint: unescapeField(fields[4]) })
  }
  return rows
}

/**
 * @param {{ target: string, mountInfoPath?: string, platform?: string,
 *           access?: (p: string, mode?: number) => Promise<void>, readFile?: (p: string, enc: string) => Promise<string>,
 *           realpath?: (p: string) => Promise<string> }} opts
 * @returns {Promise<'volume'|'ephemeral'|'unknown'>}
 */
export async function detectMountState({
  target,
  mountInfoPath = '/proc/self/mountinfo',
  platform = process.platform,
  access = (p) => fsp.access(p, fsp.constants.W_OK | fsp.constants.X_OK),
  readFile = (p, enc) => fsp.readFile(p, enc),
  realpath = (p) => fsp.realpath(p),
} = {}) {
  if (platform !== 'linux') return 'unknown'
  if (typeof target !== 'string' || !target) return 'unknown'
  let text
  try {
    text = await readFile(mountInfoPath, 'utf8')
  } catch {
    return 'unknown'
  }
  const resolved = path.posix.resolve(target)
  let canonical = resolved
  try { canonical = await realpath(resolved) } catch { /* ยังไม่มี → ใช้ path ที่ resolve แล้ว */ }
  const candidates = new Set([resolved, canonical])
  for (const row of parseMountInfo(text)) {
    if (candidates.has(path.posix.resolve(row.mountPoint))) return 'volume'
  }
  try {
    await access(resolved)
    return 'ephemeral'
  } catch {
    return 'unknown'
  }
}
