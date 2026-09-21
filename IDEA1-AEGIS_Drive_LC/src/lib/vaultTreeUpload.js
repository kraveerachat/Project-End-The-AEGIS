// src/lib/vaultTreeUpload.js — AEGIS Drive (IDEA1) · PR #157 Task 4.3 · tree-aware upload, attach and orphan recovery
//
// ── สองครึ่งที่แยกกันโดยเจตนา ──────────────────────────────────────────────────
//   1. ไบต์: uploadVaultFileChunked เดิม "ทุกขั้น" (ซอง/แผนการแบ่ง/chunk/retry/commit) ต่างเพียง routeBase →
//      /api/vault/tree/uploads ซึ่งเซิร์ฟเวอร์ตอบ blob ที่ lifecycle = UNREFERENCED (ยังไม่อยู่ในต้นไม้)
//   2. ความหมาย: attachBlob intent → session.commit() (vaultTreeSync) — ชื่อไฟล์, MIME, parentNodeId และ nodeId
//      ใหม่อยู่ใน manifest ที่เข้ารหัสฝั่ง client เท่านั้น; คำขอ CAS ส่งแค่ attachBlobIds ทึบ (NO-LEAK-4/5)
//
// ⚠️ ขนาด chunk, ความพร้อมกัน, จำนวน retry, การเข้ารหัส และเพดานไฟล์ไม่เปลี่ยน — ไฟล์นี้ไม่รู้จักค่าเหล่านั้นด้วยซ้ำ
// ⚠️ CAS แพ้ (conflict) = blob ยัง UNREFERENCED และ "กู้ได้" ผ่าน listOrphanBlobs/recoverOrphan — ไม่ลบ ไม่อัปโหลดซ้ำ
//    ไม่ rebase อัตโนมัติที่ชั้นนี้ (session เป็นผู้ตัดสิน; conflict ที่มาถึงตรงนี้คือคำตัดสินแล้ว)
// ⚠️ purgeUnlockedVaultState: AbortController ของการโอนถูกลงทะเบียนกับ unlockedState — ล็อก/ออกจากระบบ
//    ระหว่างอัปโหลด = การโอนหยุดผ่านเส้นทาง abort เดิม และไม่มี commit ใดถูกพยายามอีก (TUC-5)
import { uploadVaultFileChunked } from './vaultChunkedUpload.js'
import { decryptBlobMeta } from './vaultCrypto.js'
import { decryptVaultV2Meta } from './vaultChunkCrypto.js'

/** ครอบครัว endpoint ของ tree-aware upload (handler ชุดเดียวกับ /api/vault/uploads บนเซิร์ฟเวอร์) */
export const TREE_UPLOAD_ROUTE_BASE = '/api/vault/tree/uploads'

/** intent แนบ blob เข้าต้นไม้ — รูปทรงเดียวกับ intents.attachBlob ของ vaultTreeOps (Task 5.1) */
export function attachBlobIntent({ parentNodeId, name, mediaType, plainSize, blobRef }) {
  return { type: 'attachBlob', parentNodeId, name, mediaType, plainSize, blobRef: { formatVersion: blobRef.formatVersion, id: String(blobRef.id) } }
}

/** สัญญาณเดียวที่รวม signal ภายนอก + การ purge ของ unlocked state */
function transferSignal({ signal, unlockedState }) {
  const ctrl = new AbortController()
  if (signal?.aborted) ctrl.abort()
  else signal?.addEventListener('abort', () => ctrl.abort(), { once: true })
  unlockedState?.registerAbort?.(ctrl)
  return ctrl
}

/**
 * อัปโหลดไฟล์เข้า Vault แบบ tree-aware แล้วผูกเข้าโฟลเดอร์ผ่าน manifest ที่เข้ารหัส
 * @returns {Promise<
 *   { ok: true, stage: 'complete', blob, blobRef, generation, revisionId, nodeId }
 * | { ok: false, stage: 'attach-conflict', reason: 'conflict', orphan: blobRef, conflict, blob }
 * | { ok: false, stage: 'cancelled'|'paused'|'failed', reason, resume, orphan? }>}
 */
export async function uploadTreeFile({
  kek, file, parentNodeId, session, unlockedState = null, signal = null,
  plaintextChunkBytes, concurrency, resume = null, onStage, onProgress, fetchJson, sendUpload,
  upload = uploadVaultFileChunked,
}) {
  const ctrl = transferSignal({ signal, unlockedState })
  if (ctrl.signal.aborted) return { ok: false, stage: 'cancelled', reason: 'cancelled', resume: null }

  const res = await upload({ kek, file, plaintextChunkBytes, concurrency, resume, onStage, onProgress, signal: ctrl.signal, fetchJson, sendUpload, routeBase: TREE_UPLOAD_ROUTE_BASE })
  if (!res.ok) return res

  const blobRef = { formatVersion: res.blob?.formatVersion ?? 2, id: String(res.blob.id) }
  // ไบต์ถึงเซิร์ฟเวอร์แล้วแต่ยังไม่ผูก — ถ้าถูกล็อก/ยกเลิกตรงนี้ blob เป็น orphan ที่กู้ได้ ไม่ใช่ข้อมูลที่หาย
  if (ctrl.signal.aborted || unlockedState?.isPurged?.()) return { ok: false, stage: 'cancelled', reason: 'cancelled', resume: null, orphan: blobRef }

  onStage?.('attaching')
  const intent = attachBlobIntent({ parentNodeId, name: file.name, mediaType: file.type ?? '', plainSize: file.size, blobRef })
  const committed = await session.commit(intent, { signal: ctrl.signal })
  if (committed?.conflict) return { ok: false, stage: 'attach-conflict', reason: 'conflict', orphan: blobRef, conflict: committed.conflict, blob: res.blob, resume: null }
  onStage?.('complete')
  return { ok: true, stage: 'complete', blob: res.blob, blobRef, generation: committed.generation, revisionId: committed.revisionId, nodeId: committed.nodeId ?? null, resume: null }
}

const refKey = (r) => `${r.formatVersion}:${String(r.id)}`

/**
 * orphan = blob ที่เซิร์ฟเวอร์รายงานเป็น UNREFERENCED "และ" ไม่มีโหนดใดใน manifest อ้างถึง
 * (ช่วงสั้น ๆ ระหว่าง CAS แนบสำเร็จกับการรีเฟรชบัญชี blob อาจเห็นทั้งสองอย่างพร้อมกัน — ฝั่ง manifest ชนะ)
 * ซองถอดไม่ได้ (คนละ KEK / เสียหาย) ยังถูกคืนมาพร้อม undecryptable=true เพื่อให้ UI แสดง id ทึบตามจริง
 * @returns {Promise<Array<{ blobRef, name, mediaType, plainSize, orphanSince, orphanRetentionMs, undecryptable, blob }>>}
 */
export async function listOrphanBlobs({ kek, api, index, signal = null }) {
  const data = await api.listTreeBlobs({ lifecycle: 'UNREFERENCED', signal })
  const referenced = new Set()
  for (const n of index?.nodes?.values?.() ?? []) if (n?.blobRef) referenced.add(refKey(n.blobRef))
  const out = []
  for (const blob of data?.blobs ?? []) {
    if (blob?.lifecycle !== 'UNREFERENCED') continue
    const blobRef = { formatVersion: blob.formatVersion, id: String(blob.id) }
    if (referenced.has(refKey(blobRef))) continue
    let meta = null
    try {
      meta = blob.formatVersion === 1 ? await decryptBlobMeta(kek, blob) : blob.formatVersion === 2 ? await decryptVaultV2Meta(kek, blob) : null
    } catch { meta = null }
    const plainSize = meta && (Number.isSafeInteger(meta.plainSize) ? meta.plainSize : Number.isSafeInteger(meta.size) ? meta.size : null)
    out.push({
      blobRef,
      name: typeof meta?.name === 'string' ? meta.name : null,
      mediaType: typeof meta?.type === 'string' ? meta.type : null,
      plainSize: meta ? plainSize : null,
      orphanSince: blob.orphanSince ?? null,
      orphanRetentionMs: data.orphanRetentionMs ?? null,
      undecryptable: meta === null,
      blob,
    })
  }
  return out
}

/**
 * กู้ orphan: ผูกเข้าโฟลเดอร์ที่ผู้ใช้เลือกด้วยชื่อที่ผู้ใช้ยืนยัน (อาจแก้ชื่อได้) — ผ่าน session.commit เท่านั้น
 * @returns {Promise<{ generation, revisionId, nodeId } | { conflict, orphan: blobRef }>}
 */
export async function recoverOrphan({ session, blobRef, parentNodeId, name, mediaType = '', plainSize = null, signal = null }) {
  const intent = attachBlobIntent({ parentNodeId, name, mediaType, plainSize, blobRef })
  const committed = await session.commit(intent, { signal })
  if (committed?.conflict) return { conflict: committed.conflict, orphan: intent.blobRef }
  return { generation: committed.generation, revisionId: committed.revisionId, nodeId: committed.nodeId ?? null }
}
