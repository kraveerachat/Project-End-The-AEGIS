// server/routes/vaultTree.js — AEGIS Drive (IDEA1) · Private Vault encrypted hierarchy · opaque tree API
//
// เซิร์ฟเวอร์ในโปรโตคอลนี้เป็นแค่ "ผู้เก็บก้อนทึบ + ผู้ประสาน CAS": มันตรวจ auth, ownership,
// สถานะโปรโตคอล/flag, ขนาด, ไวยากรณ์ของ id ทึบ, idempotency และเงื่อนไข CAS เท่านั้น
// ⚠️ ไม่มี route ใดรับหรือคืนชื่อ, parent, path, MIME, node id, breadcrumb หรือโครงต้นไม้
//    (design §6, §11) และไฟล์นี้ต้องไม่ import กฎของ tree ฝั่ง client (SRV-NOIMPORT-1)
//
// Task 2.1: ประตู flag + โครง router (503 TREE_PROTOCOL_DISABLED เมื่อโปรโตคอลปิด)
// Task 2.2+: state/head/revisions/key-envelope/blobs/migration/genesis/purge

import express from 'express'
import { requireAuth } from '../middleware/requireRole.js'

/** รหัสข้อผิดพลาดของ tree API — ทุก 4xx/5xx ตอบ { error, code } และไม่ echo ค่าที่ client ส่งมา (นอกจาก id ทึบ) */
export const TREE_ERROR = Object.freeze({
  TREE_PROTOCOL_DISABLED: 'TREE_PROTOCOL_DISABLED',
  TREE_STATE_CONFLICT: 'TREE_STATE_CONFLICT',
  TREE_MIGRATION_IN_PROGRESS: 'TREE_MIGRATION_IN_PROGRESS',
  UPGRADE_REQUIRED: 'UPGRADE_REQUIRED',
})

const NO_STORE = { 'Cache-Control': 'no-store' }

/** อ่าน config ที่ createApp แช่แข็งไว้ (tests inject ผ่าน createApp({ vaultTreeConfig })) */
export const treeConfigOf = (req) => req.app.get('vaultTreeConfig')

/**
 * ประตู flag: โปรโตคอลปิด (หรือสคีมาไม่พร้อม) = 503 fail-closed
 * ⚠️ ประตูนี้ "ไม่" เปิดการแก้ไขแบบ flat กลับให้ใคร — ดู requireVaultProtocolState (Task 2.5)
 */
export function requireTreeProtocol(req, res, next) {
  const cfg = treeConfigOf(req)
  if (!cfg?.flags?.schemaAvailable || !cfg?.flags?.protocolEnabled) {
    return res.status(503).set(NO_STORE).json({ error: 'Private Vault tree protocol is not enabled', code: TREE_ERROR.TREE_PROTOCOL_DISABLED })
  }
  return next()
}

export const vaultTreeRouter = express.Router()
vaultTreeRouter.use(requireAuth, requireTreeProtocol)
// routes are added in Task 2.2+; with the protocol enabled and no route matched, the
// existing /api not-found handler answers 404 (never a stub that looks like success)
