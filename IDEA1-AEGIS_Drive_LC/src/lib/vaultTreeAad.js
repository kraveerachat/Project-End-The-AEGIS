// src/lib/vaultTreeAad.js — AEGIS Drive (IDEA1) · Private Vault encrypted hierarchy · AAD encoders
//
// สามชั้นของ tree ใช้ AAD คนละ "โดเมน" กัน: ห่อ TRK, ห่อ Manifest DEK, และ ciphertext ของ manifest
// ซองจากชั้น/ช่อง/tree/revision หนึ่งต้องพิสูจน์ไม่ผ่านในทุกบริบทอื่น — GCM ทำให้ได้ก็ต่อเมื่อ
// AAD ต่างกันแบบตายตัว ไฟล์นี้จึงเป็น "นิยามของรูปแบบ" เหมือน contentChunkAad ใน vaultChunkCrypto.js:
// การแก้ไบต์ใดหลัง genesis ทำให้ revision ที่มีอยู่ทั้งหมดถอดไม่ออกตลอดกาล (tests/vaultTreeAad.test.js
// ตรึงเวกเตอร์ไว้ทุกไบต์)
//
// รูปแบบ (ไบนารีล้วน ไม่มีการต่อสตริง):
//   u8  layoutVersion = 1
//   u16 labelLen (big-endian) ‖ label (UTF-8)
//   ต่อฟิลด์ตามลำดับตาราง: u8 tag ‖ u32 len (big-endian) ‖ value
//     - id เป็น UTF-8 ของ base64url 22 ตัวอักษร (16 ไบต์สุ่ม)
//     - จำนวนเต็มเป็น 8 ไบต์ big-endian
//     - baseRevisionId = null → len 0 (genesis) — ต้องระบุ null ชัดเจน ไม่ใช่ปล่อยว่าง
//
// ⚠️ ไม่มีชื่อ, parent, ชนิด node, จำนวน node หรือ metadata เนื้อหาใน AAD เลย — AAD ถูกพิสูจน์แต่
//    "ไม่ถูกเข้ารหัส" จึงใส่ได้เฉพาะค่าประสานงานทึบที่เซิร์ฟเวอร์เห็นอยู่แล้ว

const te = new TextEncoder()

export const AAD_LAYOUT_VERSION = 1
export const TRK_WRAP_LABEL = 'AEGIS-Vault-Tree-TRK-Wrap-v1'
export const MANIFEST_DEK_WRAP_LABEL = 'AEGIS-Vault-Tree-Manifest-DEK-Wrap-v1'
export const MANIFEST_CIPHERTEXT_LABEL = 'AEGIS-Vault-Tree-Manifest-Ciphertext-v1'

export const TRK_SLOTS = Object.freeze(['primary', 'recovery'])

/** base64url ของ 16 ไบต์ = 22 ตัวอักษร ไม่มี padding */
const ID_RE = /^[A-Za-z0-9_-]{22}$/
const MAX_SAFE = Number.MAX_SAFE_INTEGER

function idField(name, value) {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new TypeError(`${name} must be a 22-character base64url id`)
  return te.encode(value)
}

function optionalIdField(name, value) {
  if (value === null) return new Uint8Array(0)
  if (value === undefined) throw new TypeError(`${name} must be an id or an explicit null`)
  return idField(name, value)
}

function intField(name, value, { min = 0 } = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > MAX_SAFE) {
    throw new TypeError(`${name} must be a safe integer >= ${min}`)
  }
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false)
  return out
}

function slotField(value) {
  if (!TRK_SLOTS.includes(value)) throw new TypeError(`slot must be one of ${TRK_SLOTS.join('|')}`)
  return te.encode(value)
}

/** ประกอบ layout: version ‖ label ‖ (tag ‖ len ‖ value)* — คืน Uint8Array ใหม่ทุกครั้ง */
function encode(label, fields) {
  const labelBytes = te.encode(label)
  let total = 1 + 2 + labelBytes.length
  for (const f of fields) total += 1 + 4 + f.length
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  out[0] = AAD_LAYOUT_VERSION
  view.setUint16(1, labelBytes.length, false)
  out.set(labelBytes, 3)
  let o = 3 + labelBytes.length
  fields.forEach((bytes, i) => {
    out[o] = i + 1
    view.setUint32(o + 1, bytes.length, false)
    out.set(bytes, o + 5)
    o += 5 + bytes.length
  })
  return out
}

/**
 * AAD ของช่อง TRK ที่ห่อด้วย KEK — ผูก owner scope (id ทึบ ไม่ใช่ user id), tree, เวอร์ชันโปรโตคอล,
 * เวอร์ชันซองกุญแจ และช่อง (primary/recovery) เข้าด้วยกัน
 * @param {{ownerScopeId:string, treeId:string, protocolVersion:number, keyEnvelopeVersion:number, slot:'primary'|'recovery'}} ctx
 */
export function trkWrapAad({ ownerScopeId, treeId, protocolVersion, keyEnvelopeVersion, slot }) {
  return encode(TRK_WRAP_LABEL, [
    idField('ownerScopeId', ownerScopeId),
    idField('treeId', treeId),
    intField('protocolVersion', protocolVersion, { min: 1 }),
    intField('keyEnvelopeVersion', keyEnvelopeVersion, { min: 1 }),
    slotField(slot),
  ])
}

/**
 * AAD ของ Manifest DEK ที่ห่อด้วย TRK — ผูกกับ revision หนึ่งเป๊ะ ๆ
 * @param {{treeId:string, revisionId:string, baseRevisionId:string|null, generation:number, manifestSchemaVersion:number}} ctx
 */
export function manifestDekWrapAad({ treeId, revisionId, baseRevisionId, generation, manifestSchemaVersion }) {
  return encode(MANIFEST_DEK_WRAP_LABEL, [
    idField('treeId', treeId),
    idField('revisionId', revisionId),
    optionalIdField('baseRevisionId', baseRevisionId),
    intField('generation', generation, { min: 1 }),
    intField('manifestSchemaVersion', manifestSchemaVersion, { min: 1 }),
  ])
}

/**
 * AAD ของ ciphertext manifest — เหมือนชั้น DEK บวกความยาว plaintext หลัง padding
 * @param {{treeId:string, revisionId:string, baseRevisionId:string|null, generation:number, manifestSchemaVersion:number, paddedPlaintextLength:number}} ctx
 */
export function manifestCiphertextAad({ treeId, revisionId, baseRevisionId, generation, manifestSchemaVersion, paddedPlaintextLength }) {
  return encode(MANIFEST_CIPHERTEXT_LABEL, [
    idField('treeId', treeId),
    idField('revisionId', revisionId),
    optionalIdField('baseRevisionId', baseRevisionId),
    intField('generation', generation, { min: 1 }),
    intField('manifestSchemaVersion', manifestSchemaVersion, { min: 1 }),
    intField('paddedPlaintextLength', paddedPlaintextLength, { min: 1 }),
  ])
}
