// src/lib/zipStreamWriter.js — AEGIS Drive (IDEA1) · ตัวเขียน ZIP แบบสตรีม (STORE) ของการดาวน์โหลดหลายไฟล์
//
// spec §7: archive มีเฉพาะระเบียนเหล่านี้ตามลำดับ — ต่อรายการ (local header, เนื้อ, data descriptor)
// แล้ว central directory ทั้งหมด แล้ว (ZIP64 EOCD + locator) เมื่อจำเป็น แล้ว EOCD แบบคลาสสิก
//
// ⚠️ ตัวเขียนไม่รู้จัก Files / Vault / DOM และ "ไม่เคย" เรียก close()/abort() ของ sink เอง —
//    การปิดหรือยกเลิกปลายทางเป็นของ orchestrator คนเดียว (spec §9, §20)
// ⚠️ หน่วยความจำ: ตัวเขียนไม่ถือเนื้อไฟล์ไว้เลย ไบต์ผ่าน CRC แล้วลง sink ทันที ที่ถือไว้มีแค่ระเบียน
//    central directory (≤ 1000 รายการ) จนถึง finish()
import { createCRC32 } from 'hash-wasm'

const U32_LIMIT = 0xFFFFFFFF
const U16_LIMIT = 0xFFFF
const FLAGS = 0x0808 // bit 3 (data descriptor) + bit 11 (UTF-8 names)
const VERSION_MADE_BY = 45 // host 0 (MS-DOS)
const VERSION_ZIP64 = 45
const VERSION_CLASSIC = 20

const encoder = new TextEncoder()

/**
 * spec §7.2: ZIP64 end records ถูกเขียน "ก็ต่อเมื่อ" ข้อใดข้อหนึ่งจริง — ตัวตัดสินเดียวของทั้งระบบ
 * (สูตรความยาว zipLayout และตัวเขียนเรียกฟังก์ชันนี้ ไม่มีใครเขียนเงื่อนไขซ้ำเอง)
 */
export function needsZip64End({ entryCount, cdSize, cdStart }) {
  return entryCount >= U16_LIMIT || cdSize >= U32_LIMIT || cdStart >= U32_LIMIT
}

/** เวลา/วันที่แบบ DOS ของเวลาเริ่ม archive — ทุกรายการใช้ค่าเดียวกัน (ไม่มี mtime ต่อไฟล์ใน v1) */
function dosDateTime(now) {
  const d = now instanceof Date ? now : new Date(now ?? Date.now())
  const year = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

/** ตัวช่วยเขียน little-endian ลงบัฟเฟอร์ขนาดที่รู้ล่วงหน้า */
function record(size) {
  const bytes = new Uint8Array(size)
  const view = new DataView(bytes.buffer)
  let p = 0
  const w = {
    u16(v) { view.setUint16(p, v, true); p += 2; return w },
    u32(v) { view.setUint32(p, v >>> 0, true); p += 4; return w },
    u64(v) { view.setBigUint64(p, BigInt(v), true); p += 8; return w },
    raw(b) { bytes.set(b, p); p += b.length; return w },
    done() {
      if (p !== size) throw new Error(`zip record length ${p} !== ${size}`)
      return bytes
    },
  }
  return w
}

/**
 * @param {{ sink: { write(bytes: Uint8Array): Promise<void> }, createHasher?: () => Promise<object>,
 *           now?: Date|number, startOffset?: number }} options
 *   startOffset — seam ของ unit test เท่านั้น (plan C-1): ตำแหน่งตรรกะของไบต์แรก ทุก offset ที่คำนวณ
 *   รวม startOffset แล้ว; production ไม่ส่งค่านี้ ZIP จริงเริ่มที่ 0 เสมอ
 */
export function createZipStreamWriter({ sink, createHasher = createCRC32, now, startOffset = 0 }) {
  const { time, date } = dosDateTime(now)
  const central = []
  let hasher = null
  let pos = startOffset
  let open = null
  let finished = false

  const emit = async (bytes) => {
    await sink.write(bytes)
    pos += bytes.length
  }

  async function begin() {
    // ⚠️ async (WASM init) — orchestrator เรียกหลังตัวเลือกไฟล์คืนค่าเท่านั้น (spec §8)
    hasher = await createHasher()
  }

  async function addEntry({ name, size }) {
    if (!hasher) throw new Error('zip writer not begun')
    if (finished) throw new Error('zip writer already finished')
    if (open) throw new Error('zip entry still open')
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('zip entry size invalid')
    const nameBytes = encoder.encode(name)
    const offset = pos
    // spec §7.2: ทุกการตัดสิน ZIP64 ของรายการนี้รู้ได้ก่อนเขียน local header (ขนาดถูกยืนยันแล้ว)
    const sizeZ64 = size >= U32_LIMIT
    const offZ64 = offset >= U32_LIMIT
    const needed = sizeZ64 || offZ64 ? VERSION_ZIP64 : VERSION_CLASSIC
    const extraLen = sizeZ64 ? 20 : 0
    const w = record(30 + nameBytes.length + extraLen)
      .u32(0x04034b50).u16(needed).u16(FLAGS).u16(0).u16(time).u16(date)
      .u32(0) // CRC อยู่ใน data descriptor (bit 3)
      .u32(sizeZ64 ? U32_LIMIT : 0).u32(sizeZ64 ? U32_LIMIT : 0)
      .u16(nameBytes.length).u16(extraLen)
      .raw(nameBytes)
    if (sizeZ64) w.u16(0x0001).u16(16).u64(0).u64(0)
    const entry = { nameBytes, size, offset, sizeZ64, offZ64, needed, count: 0, crc: 0 }
    open = entry
    hasher.init()
    await emit(w.done())

    let closing = null
    return {
      async write(bytes) {
        if (closing) throw new Error('zip entry already closed')
        // ⚠️ ตรวจล้นก่อนแตะ CRC หรือ sink — ไบต์ที่เกินขนาดที่ประกาศต้องไม่ถูกเขียนแม้แต่ไบต์เดียว
        if (entry.count + bytes.length > size) throw new Error('zip entry write exceeds declared size')
        hasher.update(bytes)
        if (bytes.length > 0) await emit(bytes)
        entry.count += bytes.length
      },
      close() {
        if (!closing && entry.count !== size) {
          return Promise.reject(new Error(`zip entry size mismatch: ${entry.count} !== ${size}`))
        }
        // ปิดซ้ำ = คืนผลเดิม ไม่เขียน descriptor ซ้ำ (downloadVaultV2 ปิด entry sink เองก่อน orchestrator)
        closing ??= (async () => {
          entry.crc = parseInt(hasher.digest('hex'), 16) >>> 0
          const d = sizeZ64
            ? record(24).u32(0x08074b50).u32(entry.crc).u64(size).u64(size)
            : record(16).u32(0x08074b50).u32(entry.crc).u32(size).u32(size)
          await emit(d.done())
          central.push(entry)
          open = null
        })()
        return closing
      },
      // ⚠️ ไม่มีผลกับ archive — orchestrator เป็นผู้ยกเลิกปลายทางเพียงครั้งเดียว (spec §20)
      async abort() {},
    }
  }

  async function finish() {
    if (open) throw new Error('zip entry still open; close() it before finish()')
    if (finished) throw new Error('zip writer already finished')
    finished = true
    const cdStart = pos
    for (const e of central) {
      const k = (e.sizeZ64 ? 2 : 0) + (e.offZ64 ? 1 : 0)
      const extraLen = k > 0 ? 4 + 8 * k : 0
      const w = record(46 + e.nameBytes.length + extraLen)
        .u32(0x02014b50).u16(VERSION_MADE_BY).u16(e.needed).u16(FLAGS).u16(0).u16(time).u16(date)
        .u32(e.crc)
        .u32(e.sizeZ64 ? U32_LIMIT : e.size).u32(e.sizeZ64 ? U32_LIMIT : e.size)
        .u16(e.nameBytes.length).u16(extraLen).u16(0) // comment length
        .u16(0).u16(0).u32(0) // disk start, internal, external attributes
        .u32(e.offZ64 ? U32_LIMIT : e.offset)
        .raw(e.nameBytes)
      // APPNOTE order: uncompressed, compressed, offset — only the fields that overflowed
      if (k > 0) {
        w.u16(0x0001).u16(8 * k)
        if (e.sizeZ64) w.u64(e.size).u64(e.size)
        if (e.offZ64) w.u64(e.offset)
      }
      await emit(w.done())
    }
    const cdSize = pos - cdStart
    const entryCount = central.length
    if (needsZip64End({ entryCount, cdSize, cdStart })) {
      const z64Offset = pos
      await emit(record(56)
        .u32(0x06064b50).u64(44).u16(VERSION_MADE_BY).u16(VERSION_ZIP64)
        .u32(0).u32(0).u64(entryCount).u64(entryCount).u64(cdSize).u64(cdStart)
        .done())
      await emit(record(20).u32(0x07064b50).u32(0).u64(z64Offset).u32(1).done())
    }
    await emit(record(22)
      .u32(0x06054b50).u16(0).u16(0)
      .u16(Math.min(entryCount, U16_LIMIT)).u16(Math.min(entryCount, U16_LIMIT))
      .u32(cdSize >= U32_LIMIT ? U32_LIMIT : cdSize)
      .u32(cdStart >= U32_LIMIT ? U32_LIMIT : cdStart)
      .u16(0)
      .done())
  }

  return { begin, addEntry, finish, get position() { return pos } }
}
