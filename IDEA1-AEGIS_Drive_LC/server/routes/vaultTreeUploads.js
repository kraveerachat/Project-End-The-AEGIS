// server/routes/vaultTreeUploads.js — AEGIS Drive (IDEA1) · PR #157 Task 4.1 · tree-aware Private Vault V2 upload family
//
// /api/vault/tree/uploads/* คือครอบครัว V2 upload "เดิมทุกไบต์" (handler ชุดเดียวกันจาก createVaultUploadHandlers)
// ที่ต่างจาก /api/vault/uploads/* เพียงสามข้อ ซึ่งทั้งหมดอยู่ในโรงงาน ไม่ใช่ที่นี่:
//   (ก) เปิดเฉพาะเจ้าของที่อยู่ในสถานะ TREE_V1 (นอกนั้น 409 TREE_STATE_CONFLICT) และเฉพาะเมื่อ flag ของโปรโตคอล
//       เปิด (ไม่งั้น 503 TREE_PROTOCOL_DISABLED) — safe reads (limits/status/cancel) ยังเปิดทุกสถานะ TREE
//   (ข) strict body: ชื่อ/parent/node/path/MIME หรือฟิลด์แปลกปลอมใด → 400 UNKNOWN_FIELD
//   (ค) commit บันทึก vault_tree_blob_state = UNREFERENCED ใน transaction เดียวกับแถว blob และตอบ lifecycle เพิ่ม
//
// ⚠️ ขนาด chunk, ความพร้อมกัน, จำนวน retry, เพดานไฟล์ และการเข้ารหัสฝั่ง client ไม่เปลี่ยนแม้แต่ค่าเดียว
//    (Global Constraints: transfer performance excluded; TU-5 / TU-SAME-1 แช่แข็ง snapshot ไว้)
// ⚠️ blob ที่ commit ที่นี่ "ยังไม่อยู่ในต้นไม้": การผูกเข้าต้นไม้เกิดใน manifest ที่เข้ารหัสฝั่ง client แล้วผ่าน
//    POST /api/vault/tree/head (attachBlobIds) → TREE_MANAGED; แพ้ CAS = ยังเป็น UNREFERENCED และกู้ได้ (ไม่ลบอัตโนมัติ)
// ⚠️ CSRF: mount ใต้ app.use('/api', csrfProtection, apiRouter) เหมือนครอบครัวเก่า
import { Router } from 'express'
import { requireAuth } from '../middleware/requireRole.js'
import { requireTreeProtocol } from './vaultTree.js'
import { createVaultUploadHandlers, mountVaultUploadHandlers } from './vaultUploads.js'

export const vaultTreeUploadsRouter = Router({ mergeParams: true })
// ประตู flag ก่อนทุกอย่าง (503 fail-closed) — แบบแผนเดียวกับ vaultTreeRouter
vaultTreeUploadsRouter.use(requireAuth, requireTreeProtocol)
mountVaultUploadHandlers(vaultTreeUploadsRouter, createVaultUploadHandlers({ mode: 'tree' }))
