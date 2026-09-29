// server/storage/vaultTreeMaintenance.js — AEGIS Drive (IDEA1) · PR #157 · งานบำรุงรักษาของ tree (Task 4.2 → Phase 8)
//
// ── สิ่งที่ไฟล์นี้ทำใน Tranche B1 (Task 4.2) ─────────────────────────────────
//    orphan revision GC: revision ที่แพ้ CAS (ORPHANED) หรือถูก stage แล้วไม่เคย CAS (CREATED/PUBLISHED ค้าง)
//    และ "เก่ากว่า orphanRevisionRetentionMs" → ลบไฟล์ ciphertext แล้วลบแถว (trigger ของ PG อนุญาตให้ลบเฉพาะ
//    ORPHANED/FORENSIC_DELETED — retireRevision เดินขอบ CREATED/PUBLISHED → ORPHANED ให้ก่อน)
//
// ── สิ่งที่ไฟล์นี้ "ไม่" ทำ และต้องไม่ทำใน PR นี้ ───────────────────────────────
//    ⚠️ ไม่ลบ blob ใดเลย — blob ที่ UNREFERENCED (อัปโหลดแล้วยังไม่ผูกเข้าต้นไม้ / แพ้ CAS) กู้ได้เสมอผ่าน
//       GET /api/vault/tree/blobs; ค่า orphanBlobRetentionMs เป็นเพียงคำอธิบายประกอบ (orphanSince/orphanRetentionMs)
//       ไม่ใช่กำหนดลบ (OR-3; design §9 "no automatic deletion in this PR")
//    ⚠️ forensic-retention expiry และ purge executor (DESTRUCTIVE_PURGE_ENABLED) เป็นของ Phase 8 — ช่องในผลลัพธ์
//       มีไว้แล้วเพื่อให้รูปทรงของ tally คงที่ แต่ตอนนี้เป็น 0 เสมอ
// ⚠️ fail-closed: flag ของโปรโตคอลปิด (หรือสคีมาไม่พร้อม) = ไม่แตะตาราง tree เลย (คืน tally ศูนย์)
// ⚠️ ลำดับ "ไฟล์ก่อนแถว" โดยเจตนา: revision กำพร้าไม่มีใครอ่าน (GET revisions เสิร์ฟเฉพาะ PUBLISHED/HEAD_COMMITTED/
//    SUPERSEDED) การเหลือแถวที่ชี้ไฟล์ที่หายไปจึงปลอดภัยกว่าไฟล์ที่ไม่มีแถวชี้ (รอบถัดไปเก็บซ้ำได้เอง)
import { VAULT_TREE_CONFIG } from '../config/vaultTreeLimits.js'
import * as tree from '../db/vaultTreeStore.js'
import { deleteManifestCiphertext } from './vaultManifestStore.js'

/**
 * รันหนึ่งรอบ — idempotent; ผลลัพธ์นับเฉพาะสิ่งที่ทำจริง
 * @returns {Promise<{ orphanRevisionsRemoved: number, forensicRevisionsRemoved: number, purgesExecuted: number }>}
 */
export async function runVaultTreeMaintenance({ now = Date.now(), config = VAULT_TREE_CONFIG } = {}) {
  const tally = { orphanRevisionsRemoved: 0, forensicRevisionsRemoved: 0, purgesExecuted: 0 }
  if (!config?.flags?.schemaAvailable || !config?.flags?.protocolEnabled) return tally

  const orphans = await tree.listOrphanRevisions({ olderThanMs: config.limits.orphanRevisionRetentionMs, now })
  for (const rev of orphans) {
    if (rev.storageKey) await deleteManifestCiphertext(rev.storageKey)
    const r = await tree.retireRevision(rev.revisionId)
    if (r.ok) tally.orphanRevisionsRemoved += 1
  }
  return tally
}
