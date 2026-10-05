// src/lib/bulkDownloadPlan.js — AEGIS Drive (IDEA1) · แผนการดาวน์โหลดหลายไฟล์ (spec §4, §6, §7.3, §12, §14)
//
// ⚠️ ฟังก์ชันในไฟล์นี้ "ซิงโครนัสและบริสุทธิ์" โดยเจตนา: แผนถูกคำนวณภายใน click (Files) หรือก่อนเปิด
//    ไดอะล็อกยืนยัน (Vault) — ทุกการปฏิเสธจึงเกิดก่อนตัวเลือกไฟล์/ไดอะล็อก/การ fetch ใด ๆ และไม่มี await
//    มาคั่นระหว่างการกดของผู้ใช้กับ showSaveFilePicker
// ⚠️ แผนคัดลอกเฉพาะค่าสเกลาร์ที่ ZIP ต้องใช้ลงวัตถุใหม่แล้ว freeze — ห้าม freeze หรือแก้วัตถุสดของจอ
//    (โหนด manifest, แถว blob, แถวรายการไฟล์, state ของ React) เด็ดขาด (SC-3)
import { assignZipEntryNames } from './zipEntryNames.js'
import { needsZip64End } from './zipStreamWriter.js'
import { estimatedPlainSize, MAX_BUFFERED_PLAINTEXT_BYTES } from './vaultChunkedDownload.js'

/** spec §25: เปิดหลังผ่าน acceptance แบบ Windows-only ที่ Human อนุมัติ (Chrome Windows FSA; Python + Windows Explorer
 *  ผ่าน R1–R3) — Firefox/macOS ยังไม่ได้ตรวจ ดู scripts/zip-acceptance/ACCEPTANCE-2026-10-05-windows.json */
export const BULK_ZIP_ENABLED = true
export const ZIP_THRESHOLD = 4
export const MAX_ZIP_ENTRIES = 1000

const U32_LIMIT = 0xFFFFFFFF
const encoder = new TextEncoder()

/**
 * spec §7.3: ความยาวที่แน่นอนของ archive คำนวณได้ในรอบเดียว (offset ของรายการ i ขึ้นกับรายการก่อนหน้าเท่านั้น)
 * @param {{ name?: string, nameBytes?: number, size: number }[]} entries
 * @param {{ startOffset?: number }} [options] startOffset — seam ของ unit test เท่านั้น (C-1);
 *        production ไม่ส่งค่านี้เลย ZIP จริงเริ่มที่ offset 0 เสมอ
 */
export function zipLayout(entries, { startOffset = 0 } = {}) {
  let pos = startOffset
  let cdSize = 0
  let payloadTotal = 0
  const out = []
  for (const e of entries) {
    const n = e.nameBytes ?? encoder.encode(e.name).length
    const s = e.size
    const sizeZ64 = s >= U32_LIMIT
    const offZ64 = pos >= U32_LIMIT
    const localSize = 30 + n + (sizeZ64 ? 20 : 0)
    const descriptorSize = sizeZ64 ? 24 : 16
    const k = (sizeZ64 ? 2 : 0) + (offZ64 ? 1 : 0)
    const centralSize = 46 + n + (k > 0 ? 4 + 8 * k : 0)
    out.push({ offset: pos, sizeZ64, offZ64, localSize, descriptorSize, centralSize })
    pos += localSize + s + descriptorSize
    cdSize += centralSize
    payloadTotal += s
  }
  const cdStart = pos
  const z64End = needsZip64End({ entryCount: entries.length, cdSize, cdStart })
  return { entries: out, cdStart, cdSize, z64End, payloadTotal, total: cdStart + cdSize + (z64End ? 76 : 0) + 22 }
}

const pad = (v) => String(v).padStart(2, '0')
function archiveName(source, now) {
  const d = now instanceof Date ? now : new Date(now ?? Date.now())
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return source === 'vault' ? `AEGIS-Vault-export-${stamp}.zip` : `AEGIS-Files-${stamp}.zip`
}

const isSafeSize = (x) => Number.isSafeInteger(x) && x >= 0
const isFolderRow = (r) => r.kind === 'folder' || r.type === 'Folder'

/** คัดลอกเฉพาะฟิลด์ของซอง V2 ที่การพิสูจน์/ดาวน์โหลดใช้จริง — ไม่ใช่ตัวแถว blob สด */
function copyBlob(b) {
  return Object.freeze({
    id: b.id, formatVersion: b.formatVersion, size: b.size, chunkSize: b.chunkSize, chunkCount: b.chunkCount,
    contentIdB64: b.contentIdB64, wrappedDekB64: b.wrappedDekB64, wrapIvB64: b.wrapIvB64,
    metaIvB64: b.metaIvB64, metaB64: b.metaB64,
  })
}

/**
 * @param {{ source: 'files'|'vault', items: any[], resolve: (item: any) => object|null,
 *           fsa: boolean, workerStream?: boolean, enabled?: boolean, now?: Date|number }} options
 *   fsa          — มี File System Access (showSaveFilePicker) → transport 'fsa' เสมอ (เส้นทางเดิม ไม่เปลี่ยน)
 *   workerStream — ไม่มี FSA แต่สตรีมผ่าน Service Worker ตัวเดิมของ /drive/ ได้ → 'worker-stream'
 *                  (ZIP เดียวโดยไม่บัฟเฟอร์ทั้งก้อน ไม่ว่า archive จะใหญ่กว่า 64 MiB หรือไม่)
 *   Files: items = id ที่เลือก, resolve(id) → แถวในรายการปัจจุบัน หรือ null
 *   Vault: items = โหนดที่เลือก, resolve(node) → แถว blob ใน blobIndex หรือ null
 */
export function planBulkDownload({ source, items, resolve, fsa, workerStream = false, enabled = BULK_ZIP_ENABLED, now }) {
  let skippedFolders = 0
  let unavailable = 0
  const picked = []
  for (const item of items) {
    if (source === 'vault') {
      if (item?.kind === 'folder') { skippedFolders += 1; continue }
      const blob = item?.blobRef ? resolve(item) : null
      if (!blob) { unavailable += 1; continue }
      picked.push({ original: item, blob })
    } else {
      const r = resolve(item)
      if (!r) { unavailable += 1; continue }
      if (isFolderRow(r)) { skippedFolders += 1; continue }
      picked.push({ original: r })
    }
  }
  const base = { source, skippedFolders, unavailable, count: picked.length }
  const perFile = (extra = {}) => Object.freeze({ ...base, mode: 'per-file', perFile: Object.freeze(picked.map((p) => p.original)), ...extra })

  if (picked.length === 0) return Object.freeze({ ...base, mode: 'none' })
  if (!enabled || picked.length < ZIP_THRESHOLD) return perFile()
  if (picked.length > MAX_ZIP_ENTRIES) return Object.freeze({ ...base, mode: 'refused', reason: 'too-many' })
  // D-1: V1 ถอดได้แค่ทั้งก้อน — สตรีมเข้า ZIP ไม่ได้ ปฏิเสธก่อนไดอะล็อกและตัวเลือกไฟล์
  if (source === 'vault' && picked.some((p) => p.original.blobRef.formatVersion !== 2)) {
    return Object.freeze({ ...base, mode: 'refused', reason: 'v1-in-zip' })
  }

  const names = assignZipEntryNames(picked.map((p) => p.original.name))
  const entries = Object.freeze(picked.map((p, i) => {
    if (source === 'files') return Object.freeze({ id: p.original.id, name: names[i], size: p.original.size })
    const n = p.original
    const blob = copyBlob(p.blob)
    return Object.freeze({
      nodeId: n.nodeId,
      name: names[i],
      // ⚠️ ขนาดชั่วคราว (provisional): ใช้ตัดสินก่อนตัวเลือกไฟล์และแสดงในไดอะล็อกเท่านั้น หลัง pre-flight
      //    ขนาดที่พิสูจน์แล้วของ effective plan แทนที่ทั้งหมด (SC-4)
      size: isSafeSize(n.plainSize) ? n.plainSize : estimatedPlainSize(blob),
      // ค่าดิบจาก manifest — ไม่แปลงชนิด ไม่ตั้งค่าเริ่มต้น; pre-flight เป็นผู้ตรวจ
      manifestPlainSize: n.plainSize,
      blobRef: Object.freeze({ formatVersion: n.blobRef.formatVersion, id: n.blobRef.id }),
      blob,
    })
  }))
  const layout = zipLayout(entries)
  let transport = 'fsa'
  if (!fsa && workerStream) {
    // ⚠️ ตรวจจากความสามารถ ไม่ใช่ user agent — เพดาน 64 MiB ด้านล่างไม่เกี่ยวกับเส้นทางนี้เพราะไม่มีการบัฟเฟอร์
    transport = 'worker-stream'
  } else if (!fsa) {
    // ⚠️ 64 MiB คือเพดานนโยบายของขนาด archive ที่บัฟเฟอร์ ไม่ใช่การรับประกันหน่วยความจำของโปรเซส (spec §14, §15)
    if (layout.total > MAX_BUFFERED_PLAINTEXT_BYTES) {
      if (source === 'files') return perFile({ fallbackNotice: 'no-fsa-large' })
      return Object.freeze({ ...base, mode: 'refused', reason: 'too-large' })
    }
    transport = 'buffered'
  }
  return Object.freeze({
    ...base, mode: 'zip', transport, entries, layout: Object.freeze(layout),
    totalBytes: layout.payloadTotal, suggestedName: archiveName(source, now),
  })
}
