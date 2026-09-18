// server/media/cache.js — AEGIS Drive (IDEA1) · content-addressed cache ของ media derivative
//
// ⚠️ ตัวตนของ derivative = sha256 ของต้นฉบับ + profile + ชนิด (spec §12): โมดูลนี้ไม่รู้จักชื่อไฟล์
//    ไม่รู้จักผู้ใช้ ไม่รู้จัก HTTP และไม่รู้จัก media — รู้แค่ layout บนดิสก์และการเขียนแบบ atomic
// ⚠️ cache ต้องอยู่ "นอก" STORAGE_ROOT เสมอ (constructor ปฏิเสธ) — resolveKey() จึงชี้เข้ามาไม่ได้
//    และไม่มีเส้นทาง backup/restore/integrity ใดมองเห็นมัน (spec §11) — ลบทิ้งได้ทุกเมื่อ
// ⚠️ ทุกการเขียน = เขียนลง tmp/ แล้ว rename: ผู้อ่านเห็นไฟล์ครบหรือไม่เห็นเลย ไม่มีครึ่ง ๆ กลาง ๆ

import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const SHA256_RE = /^[0-9a-f]{64}$/
const PROFILE_RE = /^v\d+$/
const TMP_RE = /\.tmp-[0-9a-f-]+$/
/** ประเภท derivative ที่ cache รู้จัก → ชื่อไฟล์ (นามสกุล poster ตามที่ state.json บันทึกไว้) */
const DERIVATIVE_FILES = Object.freeze({ poster: (ext = 'webp') => `poster.${ext}`, motion: () => 'motion.mp4' })
const MIME_BY_EXT = Object.freeze({ webp: 'image/webp', png: 'image/png', mp4: 'video/mp4' })
const PERSIST_INTERVAL_MS = 3_600_000

/**
 * rename ที่ปลายทาง/ต้นทางถูกอีก handle เปิดอยู่ล้มเหลวชั่วคราวบน Windows (EPERM/EBUSY) — บน Linux
 * rename ทับไฟล์ที่เปิดอยู่ทำได้เสมอ จึงเป็นการลองซ้ำสั้น ๆ ที่มีขอบเขต ไม่ใช่การกลืน error จริง
 */
async function renameWithRetry(from, to, attempts = 25) {
  for (let i = 0; ; i += 1) {
    try {
      return await fsp.rename(from, to)
    } catch (err) {
      if (i >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err
      await new Promise((r) => setTimeout(r, 10))
    }
  }
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * @param {{ root: string, profile: string, storageRoot: string, now?: () => number }} opts
 */
export function createMediaCache({ root, profile, storageRoot, now = Date.now }) {
  if (typeof root !== 'string' || !root) throw new Error('media cache root is required')
  if (typeof profile !== 'string' || !PROFILE_RE.test(profile)) throw new Error(`media cache profile must match ${PROFILE_RE} (got ${profile})`)
  if (typeof storageRoot === 'string' && storageRoot && isInside(root, storageRoot)) {
    throw new Error('media cache root must not be inside STORAGE_ROOT')
  }
  const ROOT = path.resolve(root)
  const TMP = path.join(ROOT, 'tmp')
  /** @type {Map<string, { lastAccess: number, persistedAt: number }>} */
  const access = new Map()

  const isValidSha256 = (value) => typeof value === 'string' && SHA256_RE.test(value)
  const assertSha = (sha) => {
    if (!isValidSha256(sha)) throw new Error('invalid sha256 cache key')
    return sha
  }

  function entryDir(sha) {
    assertSha(sha)
    return path.join(ROOT, profile, sha.slice(0, 2), sha.slice(2, 4), sha)
  }

  function paths(sha) {
    const dir = entryDir(sha)
    return {
      dir,
      probe: path.join(dir, 'probe.json'),
      state: path.join(dir, 'state.json'),
      poster: (ext = 'webp') => path.join(dir, DERIVATIVE_FILES.poster(ext)),
      motion: path.join(dir, DERIVATIVE_FILES.motion()),
      tmpDir: TMP,
    }
  }

  /**
   * เขียน finalPath แบบ atomic: producer ได้รับ tmpPath ใต้ tmp/ แล้ว rename เมื่อสำเร็จเท่านั้น
   * @param {string} finalPath
   * @param {(tmpPath: string) => Promise<void>} produce
   */
  async function writeAtomic(finalPath, produce) {
    await fsp.mkdir(TMP, { recursive: true })
    await fsp.mkdir(path.dirname(finalPath), { recursive: true })
    const tmpPath = path.join(TMP, `${path.basename(finalPath)}.tmp-${randomUUID()}`)
    try {
      await produce(tmpPath)
      await renameWithRetry(tmpPath, finalPath)
    } catch (err) {
      await fsp.rm(tmpPath, { force: true }).catch(() => {})
      throw err
    }
  }

  async function readJson(file) {
    try {
      return JSON.parse(await fsp.readFile(file, 'utf8'))
    } catch {
      return null // ไม่มี / อ่านไม่ได้ / JSON เสีย = "ยังไม่มี" (สร้างใหม่ได้) ไม่ใช่ error
    }
  }
  const writeJson = (file, value) => writeAtomic(file, (tmp) => fsp.writeFile(tmp, JSON.stringify(value)))

  const readState = (sha) => readJson(paths(sha).state)
  const writeState = (sha, state) => writeJson(paths(sha).state, state)
  const readProbe = (sha) => readJson(paths(sha).probe)
  const writeProbe = (sha, probe) => writeJson(paths(sha).probe, probe)

  /** @returns {Promise<{ path: string, bytes: number, mime: string } | null>} */
  async function statDerivative(sha, type) {
    if (!DERIVATIVE_FILES[type]) return null
    const p = paths(sha)
    const state = await readState(sha)
    const recorded = state?.[type]?.file
    const file = recorded ? path.join(p.dir, path.basename(recorded)) : (type === 'poster' ? p.poster('webp') : p.motion)
    try {
      const st = await fsp.stat(file)
      if (!st.isFile()) return null
      const ext = path.extname(file).slice(1)
      return { path: file, bytes: st.size, mime: state?.[type]?.mime ?? MIME_BY_EXT[ext] ?? 'application/octet-stream' }
    } catch {
      return null
    }
  }

  const lastAccessOf = (sha) => access.get(assertSha(sha))?.lastAccess ?? null

  /** อัปเดตเวลาเข้าถึงในหน่วยความจำทันที; เขียนลง state.json ไม่เกินหนึ่งครั้งต่อชั่วโมงต่อ entry */
  async function touch(sha, at = now()) {
    assertSha(sha)
    const current = access.get(sha) ?? { lastAccess: 0, persistedAt: -Infinity }
    current.lastAccess = at
    access.set(sha, current)
    if (at - current.persistedAt < PERSIST_INTERVAL_MS) return false
    const state = await readState(sha)
    if (!state) return false
    await writeState(sha, { ...state, lastAccess: new Date(at).toISOString() })
    current.persistedAt = at
    return true
  }

  async function cleanupTmp({ olderThanMs }) {
    let removed = 0
    let names
    try { names = await fsp.readdir(TMP) } catch { return { removed } }
    const cutoff = now() - olderThanMs
    for (const name of names) {
      if (!TMP_RE.test(name) && !name.startsWith('evict-')) continue
      const file = path.join(TMP, name)
      try {
        const st = await fsp.stat(file)
        if (st.mtimeMs <= cutoff) { await fsp.rm(file, { recursive: true, force: true }); removed += 1 }
      } catch { /* หายไปแล้วระหว่างกวาด — ไม่เป็นไร */ }
    }
    return { removed }
  }

  async function listProfileDirs() {
    try {
      return (await fsp.readdir(ROOT, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && PROFILE_RE.test(d.name)).map((d) => d.name).sort()
    } catch { return [] }
  }

  /** ไล่ทุก entry ในทุก profile: bytes = ผลรวมของไฟล์ derivative (ไม่นับ json) */
  async function* scanEntries() {
    for (const prof of await listProfileDirs()) {
      const profDir = path.join(ROOT, prof)
      let l1
      try { l1 = await fsp.readdir(profDir) } catch { continue }
      for (const a of l1) {
        let l2
        try { l2 = await fsp.readdir(path.join(profDir, a)) } catch { continue }
        for (const b of l2) {
          let entries
          try { entries = await fsp.readdir(path.join(profDir, a, b)) } catch { continue }
          for (const sha of entries) {
            if (!SHA256_RE.test(sha)) continue
            const dir = path.join(profDir, a, b, sha)
            let files
            try { files = await fsp.readdir(dir) } catch { continue }
            let bytes = 0
            for (const f of files) {
              if (f.endsWith('.json')) continue
              try { bytes += (await fsp.stat(path.join(dir, f))).size } catch { /* skip */ }
            }
            const state = await readJson(path.join(dir, 'state.json'))
            const persisted = state?.lastAccess ? Date.parse(state.lastAccess) : NaN
            const mem = prof === profile ? access.get(sha)?.lastAccess : undefined
            const lastAccess = mem ?? (Number.isFinite(persisted) ? state.lastAccess : null)
            yield { sha, profile: prof, bytes, lastAccess }
          }
        }
      }
    }
  }

  const staleProfileDirs = async () => (await listProfileDirs()).filter((p) => p !== profile)

  /** ลบทั้ง entry: rename ออกไปที่ tmp/evict-* ก่อน (ผู้อ่านเห็น "ไม่มี" ทันที) แล้วค่อย unlink */
  async function removeEntry(sha) {
    const dir = entryDir(sha)
    await fsp.mkdir(TMP, { recursive: true })
    const grave = path.join(TMP, `evict-${randomUUID()}`)
    try {
      await renameWithRetry(dir, grave)
    } catch (err) {
      if (err.code === 'ENOENT') return false
      throw err
    }
    await fsp.rm(grave, { recursive: true, force: true })
    access.delete(sha)
    return true
  }

  return Object.freeze({
    root: ROOT, profile,
    isValidSha256, entryDir, paths,
    readState, writeState, readProbe, writeProbe,
    writeAtomic, statDerivative, touch, lastAccessOf,
    cleanupTmp, scanEntries, removeEntry, staleProfileDirs,
  })
}
