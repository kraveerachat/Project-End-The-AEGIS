// server/db/vaultInventory.js — AEGIS Drive (IDEA1) · opaque V1+V2 Vault blob inventory of one owner
//
// รูปร่างเดียวกับ blobs ของ GET /api/vault (envelope ครบเพื่อให้ client ถอดชื่อเองหลังปลดล็อก,
// ไม่มี storageKey) — แยกออกมาให้ tree API (GET /api/vault/tree/blobs) และ migration fence
// ใช้ซ้ำโดยไม่แตะ handler เดิมของ GET /api/vault
import * as store from './store.js'
import * as vaultV2 from './vaultV2Store.js'
import { publicVaultV2Blob } from '../routes/vaultUploads.js'

/** @returns {Promise<Array<object>>} V1 + V2 envelopes ของเจ้าของ เรียงใหม่สุดก่อน */
export async function listVaultInventory(userId) {
  const [v1Blobs, v2Blobs] = await Promise.all([store.listVaultBlobs(userId), vaultV2.listVaultV2Blobs(userId)])
  return [
    ...v1Blobs.map((b) => ({
      id: b.id, formatVersion: 1, size: b.size, createdAt: b.createdAt,
      ivB64: b.ivB64, wrappedDekB64: b.wrappedDekB64, wrapIvB64: b.wrapIvB64, metaIvB64: b.metaIvB64, metaB64: b.metaB64,
    })),
    ...v2Blobs.map(publicVaultV2Blob),
  ].sort((a, b) => b.createdAt - a.createdAt)
}
