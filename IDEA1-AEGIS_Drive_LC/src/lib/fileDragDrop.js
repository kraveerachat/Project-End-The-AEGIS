// src/lib/fileDragDrop.js — AEGIS Drive (IDEA1) · กติกาของการลากวางในหน้า Files
//
// ⚠️ หน้านี้มีการลากวางสองชนิดที่ความหมายตรงข้ามกัน และห้ามปนกันเด็ดขาด:
//
//      ไฟล์จากเครื่องผู้ใช้ (OS)     → อัปโหลดขึ้น Data Lake
//      รายการที่มีอยู่แล้วในจอ       → ย้ายเข้าโฟลเดอร์
//
//    ถ้าปนกัน ผู้ใช้ลากไฟล์ที่อัปโหลดไว้แล้วไปวางในโฟลเดอร์แล้วจะได้ "การอัปโหลดซ้ำ"
//    ของไฟล์เดิม หรือแย่กว่านั้นคือถูกนับเป็นเวอร์ชันใหม่ของตัวเอง
//
// ⚠️ การแยกชนิดใช้ `DataTransfer.types` ซึ่งเบราว์เซอร์เป็นผู้ประกาศ ไม่ใช่การเดาจาก
//    พฤติกรรมหรือลำดับ event — เบราว์เซอร์ใส่ 'Files' ให้เองเมื่อมีไฟล์จริงจากระบบไฟล์
//    ส่วนชนิดของเราถูกใส่โดยโค้ดของเราเองตอน dragstart เท่านั้น
//
// ⚠️ ทั้งการลากวางและกล่องโต้ตอบ Move เรียก Move API ตัวเดียวกัน การลากเป็นแค่ทางลัด
//    ผู้ใช้คีย์บอร์ดและผู้ใช้จอสัมผัสต้องทำได้ครบทุกอย่างโดยไม่ต้องลากแม้แต่ครั้งเดียว

/** ชนิดข้อมูลของ "รายการภายใน AEGIS" บน DataTransfer */
export const AEGIS_ITEMS_TYPE = 'application/x-aegis-items'

const typesOf = (transfer) => {
  const types = transfer?.types
  if (!types) return []
  // DataTransfer.types เป็น DOMStringList ในบางเบราว์เซอร์ ไม่ใช่ Array เสมอไป
  return Array.from(types)
}

/** ไฟล์จากระบบไฟล์ของผู้ใช้ = เส้นทางอัปโหลดเดิม ห้ามเปลี่ยนความหมายนี้ */
export function isExternalFileDrag(transfer) {
  return typesOf(transfer).includes('Files')
}

/** รายการที่ลากมาจากในจอเอง = เส้นทางย้าย */
export function isInternalItemDrag(transfer) {
  return typesOf(transfer).includes(AEGIS_ITEMS_TYPE)
}

/**
 * ลากอะไรไปบ้าง
 *
 * ⚠️ ลากรายการที่อยู่ในสิ่งที่เลือกไว้ = ลากทั้งชุดที่เลือก (ผู้ใช้เลือกไว้แล้วย่อมตั้งใจ
 *    ให้มันไปด้วยกัน) ส่วนการลากรายการนอกชุด = ลากเฉพาะตัวนั้น และต้องไม่ไปแตะ
 *    ชุดที่เลือกไว้ ไม่งั้นการลากผิดตัวหนึ่งครั้งจะย้ายของที่ผู้ใช้ไม่ได้ตั้งใจทั้งชุด
 */
export function dragPayloadFor(id, selectedIds) {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds ?? [])
  return selected.has(id) ? [...selected] : [id]
}

/** วางลงตรงนี้ได้ไหม — เฉพาะโฟลเดอร์ และต้องไม่ใช่รายการที่กำลังลากอยู่เอง */
export function canDropOn(target, draggedIds = []) {
  if (!target || target.kind !== 'folder') return false
  return !draggedIds.map(String).includes(String(target.id))
}

export function writeDragPayload(transfer, ids) {
  transfer?.setData?.(AEGIS_ITEMS_TYPE, JSON.stringify(ids))
}

/** อ่านรายการที่ลากมา — ข้อมูลพังหรือมาจากที่อื่น = ไม่มีอะไรให้ย้าย ไม่ใช่ error ใส่ผู้ใช้ */
export function readDragPayload(transfer) {
  if (!isInternalItemDrag(transfer)) return []
  try {
    const parsed = JSON.parse(transfer.getData(AEGIS_ITEMS_TYPE) || '[]')
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}
