// server/config/vaultTreeLimits.js — AEGIS Drive (IDEA1) · Private Vault encrypted hierarchy · flags + server limits
//
// ⚠️ แบบแผนเดียวกับ mediaLimits.js: อ่านครั้งเดียวตอนบูต ค่าผิด = โยน error ทันที ไม่ clamp เงียบ ๆ
//    ผลลัพธ์ถูกแช่แข็งลึกเพื่อให้ route/store อ่านวัตถุเดียวกัน
//
// ⚠️ flag ทั้งหกเป็น "fail-closed + เป็นโซ่" (design §23, plan "Rollout flags"):
//      VAULT_TREE_SCHEMA_AVAILABLE
//        └ VAULT_TREE_PROTOCOL_ENABLED
//            ├ VAULT_TREE_GENESIS_MIGRATION_ENABLED
//            ├ VAULT_TREE_UI_ENABLED
//            │   └ VAULT_MEDIA_PREVIEW_ENABLED
//            └ VAULT_DESTRUCTIVE_PURGE_ENABLED   ← ต้องเป็น false ในการ rollout ครั้งแรกของ Production
//    flag ปลายเปิดโดยที่ต้นทางปิด = บูตไม่ขึ้น — ไม่มีการ "เปิดเงียบ ๆ" และไม่มีการเดา
//
// ⚠️ ไม่มี flag ใดเปิดการแก้ไขแบบ flat (POST/DELETE /api/vault/blobs) ให้เจ้าของที่ไม่ได้อยู่ใน FLAT
//    กลับมาได้ — การกั้นนั้นอยู่ที่ requireVaultProtocolState และอ่านจากสถานะของเจ้าของ ไม่ใช่จาก flag
//
// ค่าเพดานฝั่งเซิร์ฟเวอร์มาจากตาราง Task 0.3 ของ Limits Evidence note (provisional จน G1 PASS);
// tests/vaultTreeConfig.test.js CF-1 คือตัวตรึงค่าเริ่มต้น

export const VAULT_TREE_PROTOCOL_VERSION = 1

/** ตารางที่ boot probe ต้องพบเมื่อ VAULT_TREE_SCHEMA_AVAILABLE=true (ลำดับตรงกับ migration 011) */
export const TREE_TABLES = Object.freeze([
  'vault_tree_state', 'vault_tree_frozen_inventory', 'vault_tree_key_envelope', 'vault_tree_heads',
  'vault_tree_revisions', 'vault_tree_blob_state', 'vault_tree_purge_candidates',
])

const MIB = 1_048_576
const DAY_MS = 86_400_000

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/** ไม่มี key = false; มี key = ต้องเป็น 'true' หรือ 'false' เป๊ะ ๆ (ค่าว่าง/yes/1 = ตั้งค่าผิด) */
function readFlag(env, name) {
  if (env[name] === undefined) return false
  const raw = String(env[name])
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`${name} must be exactly true or false`)
}

function readInteger(env, name, fallback, { min, max }) {
  if (env[name] === undefined) return fallback
  const raw = String(env[name]).trim()
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is not a safe integer`)
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`)
  return value
}

/**
 * อ่าน flag + เพดานทั้งชุด — โยนทันทีเมื่อค่าผิดหรือโซ่ flag ขาด
 * @param {Record<string, string|undefined>} [env]
 */
export function vaultTreeConfigFromEnv(env = process.env) {
  const flags = {
    schemaAvailable: readFlag(env, 'VAULT_TREE_SCHEMA_AVAILABLE'),
    protocolEnabled: readFlag(env, 'VAULT_TREE_PROTOCOL_ENABLED'),
    genesisMigrationEnabled: readFlag(env, 'VAULT_TREE_GENESIS_MIGRATION_ENABLED'),
    treeUiEnabled: readFlag(env, 'VAULT_TREE_UI_ENABLED'),
    mediaPreviewEnabled: readFlag(env, 'VAULT_MEDIA_PREVIEW_ENABLED'),
    destructivePurgeEnabled: readFlag(env, 'VAULT_DESTRUCTIVE_PURGE_ENABLED'),
  }
  const chain = [
    ['protocolEnabled', 'VAULT_TREE_PROTOCOL_ENABLED', 'schemaAvailable', 'VAULT_TREE_SCHEMA_AVAILABLE'],
    ['genesisMigrationEnabled', 'VAULT_TREE_GENESIS_MIGRATION_ENABLED', 'protocolEnabled', 'VAULT_TREE_PROTOCOL_ENABLED'],
    ['treeUiEnabled', 'VAULT_TREE_UI_ENABLED', 'protocolEnabled', 'VAULT_TREE_PROTOCOL_ENABLED'],
    ['mediaPreviewEnabled', 'VAULT_MEDIA_PREVIEW_ENABLED', 'treeUiEnabled', 'VAULT_TREE_UI_ENABLED'],
    ['destructivePurgeEnabled', 'VAULT_DESTRUCTIVE_PURGE_ENABLED', 'protocolEnabled', 'VAULT_TREE_PROTOCOL_ENABLED'],
  ]
  for (const [flag, name, needs, needsName] of chain) {
    if (flags[flag] && !flags[needs]) throw new Error(`${name}=true requires ${needsName}=true (fail-closed flag chain)`)
  }
  const limits = {
    maxManifestCiphertextBytes: readInteger(env, 'VAULT_TREE_MAX_MANIFEST_CIPHERTEXT_BYTES', 16 * MIB + 16, { min: 4_096 + 16, max: 64 * MIB + 16 }),
    migrationLeaseMs: readInteger(env, 'VAULT_TREE_MIGRATION_LEASE_MS', 600_000, { min: 1_000, max: DAY_MS }),
    orphanRevisionRetentionMs: readInteger(env, 'VAULT_TREE_ORPHAN_REVISION_RETENTION_MS', DAY_MS, { min: 60_000, max: 365 * DAY_MS }),
    orphanBlobRetentionMs: readInteger(env, 'VAULT_TREE_ORPHAN_BLOB_RETENTION_MS', 30 * DAY_MS, { min: DAY_MS, max: 3_650 * DAY_MS }),
    forensicRevisionRetentionMs: readInteger(env, 'VAULT_TREE_FORENSIC_REVISION_RETENTION_MS', 30 * DAY_MS, { min: 60_000, max: 3_650 * DAY_MS }),
    purgeRetentionMs: readInteger(env, 'VAULT_TREE_PURGE_RETENTION_MS', 7 * DAY_MS, { min: 1_000, max: 365 * DAY_MS }),
    maxAttachBlobIdsPerCas: readInteger(env, 'VAULT_TREE_MAX_ATTACH_PER_CAS', 256, { min: 1, max: 256 }),
    maxPurgeBlobIdsPerRequest: readInteger(env, 'VAULT_TREE_MAX_PURGE_PER_REQUEST', 256, { min: 1, max: 256 }),
  }
  return deepFreeze({ protocolVersion: VAULT_TREE_PROTOCOL_VERSION, flags, limits })
}

/**
 * boot probe: เมื่อ schemaAvailable=true ต้องพบทุกตารางใน TREE_TABLES ไม่งั้นบูตล้มโดยระบุชื่อตารางที่หาย
 * เมื่อ false ไม่เรียก probe เลย (ฐานข้อมูลอาจยังไม่มีตาราง — และนั่นถูกต้อง)
 * @param {ReturnType<typeof vaultTreeConfigFromEnv>} config
 * @param {() => Promise<{missing:string[]}>} probe
 */
export async function verifyTreeSchema(config, probe) {
  if (!config.flags.schemaAvailable) return { probed: false, missing: [] }
  const { missing } = await probe()
  if (missing.length) throw new Error(`VAULT_TREE_SCHEMA_AVAILABLE=true but tree tables are missing: ${missing.join(', ')}`)
  return { probed: true, missing: [] }
}

/** ค่าที่ process นี้ใช้จริง — อ่านครั้งเดียว */
export const VAULT_TREE_CONFIG = vaultTreeConfigFromEnv()
