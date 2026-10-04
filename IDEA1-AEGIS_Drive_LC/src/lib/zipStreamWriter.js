// src/lib/zipStreamWriter.js — AEGIS Drive (IDEA1) · ตัวเขียน ZIP แบบสตรีม (STORE) ของการดาวน์โหลดหลายไฟล์
//
// spec §7: archive มีเฉพาะระเบียนเหล่านี้ตามลำดับ — ต่อรายการ (local header, เนื้อ, data descriptor)
// แล้ว central directory ทั้งหมด แล้ว (ZIP64 EOCD + locator) เมื่อจำเป็น แล้ว EOCD แบบคลาสสิก

const U32_LIMIT = 0xFFFFFFFF
const U16_LIMIT = 0xFFFF

/**
 * spec §7.2: ZIP64 end records ถูกเขียน "ก็ต่อเมื่อ" ข้อใดข้อหนึ่งจริง — ตัวตัดสินเดียวของทั้งระบบ
 * (สูตรความยาว zipLayout และตัวเขียนเรียกฟังก์ชันนี้ ไม่มีใครเขียนเงื่อนไขซ้ำเอง)
 */
export function needsZip64End({ entryCount, cdSize, cdStart }) {
  return entryCount >= U16_LIMIT || cdSize >= U32_LIMIT || cdStart >= U32_LIMIT
}
