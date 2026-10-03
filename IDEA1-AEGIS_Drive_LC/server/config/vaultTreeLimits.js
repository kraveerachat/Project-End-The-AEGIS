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
// ⚠️ D-1 separate encrypted preview index (plan 2026-10-02, PR-A): สาม flag ใหม่ ปิดโดยปริยาย เป็นโซ่เดียวกัน
//      VAULT_TREE_SCHEMA_AVAILABLE
//        └ VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE   ← ตั้งได้หลัง apply migration 012 เท่านั้น (บูต probe ตาราง + ค่า lifecycle)
//            └ VAULT_PREVIEW_INDEX_READ_ENABLED   ← ต้องมี VAULT_MEDIA_PREVIEW_ENABLED ด้วย
//                └ VAULT_PREVIEW_INDEX_WRITE_ENABLED   (capability VAULT_PREVIEW_INDEX_WRITE)
//    WRITE=true ต้องมี VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER ที่ตั้งไว้ชัด ๆ — ไม่มี runtime default
//    HG-G approved 8 GiB/owner, but approval does not supply the env value: ไม่ตั้ง = null และ writer บูตไม่ขึ้น (fail-closed)
//
// ⚠️ ไม่มี flag ใดเปิดการแก้ไขแบบ flat (POST/DELETE /api/vault/blobs) ให้เจ้าของที่ไม่ได้อยู่ใน FLAT
//    กลับมาได้ — การกั้นนั้นอยู่ที่ requireVaultProtocolState และอ่านจากสถานะของเจ้าของ ไม่ใช่จาก flag
//
// ค่าเพดานฝั่งเซิร์ฟเวอร์มาจากตาราง Task 0.3 ของ Limits Evidence note (provisional จน G1 PASS);
// tests/vaultTreeConfig.test.js CF-1 คือตัวตรึงค่าเริ่มต้น

export const VAULT_TREE_PROTOCOL_VERSION = 1

/** ตารางของ D-1 preview index ที่ boot probe ต้องพบเมื่อ VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE=true (ลำดับตรงกับ migration 012) */
export const PREVIEW_INDEX_TABLES = Object.freeze([
  'vault_preview_index_heads', 'vault_preview_index_generations', 'vault_preview_index_blob_refs',
])

/** ตารางที่ boot probe ต้องพบเมื่อ VAULT_TREE_SCHEMA_AVAILABLE=true (ลำดับตรงกับ migration 011) */
export const TREE_TABLES = Object.freeze([
  'vault_tree_state', 'vault_tree_frozen_inventory', 'vault_tree_key_envelope', 'vault_tree_heads',
  'vault_tree_revisions', 'vault_tree_blob_state', 'vault_tree_purge_candidates',
])

const MIB = 1_048_576
const GIB = 1024 * MIB
const DAY_MS = 86_400_000

/** Approval record only, never a runtime default. Stage 3 requires a separately authorized overlay. */
export const HG_G_RETAINED_BUDGET_APPROVAL = Object.freeze({
  date: '2026-10-03',
  source: 'HG_G_APPROVED / PR #310 / 89da7f84d7279871f6e10df5df3e6b78594e5ef8',
  bytes: 8_589_934_592,
})

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

/** จำนวนเต็มที่ "ไม่มีค่า default": ไม่มี key = null (ผู้เรียกตัดสินว่า null ใช้ได้ไหม) */
function readOptionalInteger(env, name, { min, max }) {
  if (env[name] === undefined) return null
  return readInteger(env, name, null, { min, max })
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
    previewIndexSchemaAvailable: readFlag(env, 'VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE'),
    previewIndexReadEnabled: readFlag(env, 'VAULT_PREVIEW_INDEX_READ_ENABLED'),
    previewIndexWriteEnabled: readFlag(env, 'VAULT_PREVIEW_INDEX_WRITE_ENABLED'),
  }
  const chain = [
    ['protocolEnabled', 'VAULT_TREE_PROTOCOL_ENABLED', 'schemaAvailable', 'VAULT_TREE_SCHEMA_AVAILABLE'],
    ['genesisMigrationEnabled', 'VAULT_TREE_GENESIS_MIGRATION_ENABLED', 'protocolEnabled', 'VAULT_TREE_PROTOCOL_ENABLED'],
    ['treeUiEnabled', 'VAULT_TREE_UI_ENABLED', 'protocolEnabled', 'VAULT_TREE_PROTOCOL_ENABLED'],
    ['mediaPreviewEnabled', 'VAULT_MEDIA_PREVIEW_ENABLED', 'treeUiEnabled', 'VAULT_TREE_UI_ENABLED'],
    ['destructivePurgeEnabled', 'VAULT_DESTRUCTIVE_PURGE_ENABLED', 'protocolEnabled', 'VAULT_TREE_PROTOCOL_ENABLED'],
    ['previewIndexSchemaAvailable', 'VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE', 'schemaAvailable', 'VAULT_TREE_SCHEMA_AVAILABLE'],
    ['previewIndexReadEnabled', 'VAULT_PREVIEW_INDEX_READ_ENABLED', 'previewIndexSchemaAvailable', 'VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE'],
    ['previewIndexReadEnabled', 'VAULT_PREVIEW_INDEX_READ_ENABLED', 'mediaPreviewEnabled', 'VAULT_MEDIA_PREVIEW_ENABLED'],
    ['previewIndexWriteEnabled', 'VAULT_PREVIEW_INDEX_WRITE_ENABLED', 'previewIndexReadEnabled', 'VAULT_PREVIEW_INDEX_READ_ENABLED'],
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
    // D-1 preview index — attach/envelope defaults approved KEEP at HG-G; superseded-per-CAS KEEP_UNMEASURED.
    maxPreviewIndexAttachPerCas: readInteger(env, 'VAULT_PREVIEW_INDEX_MAX_ATTACH_PER_CAS', 64, { min: 1, max: 256 }),
    maxPreviewIndexSupersededPerCas: readInteger(env, 'VAULT_PREVIEW_INDEX_MAX_SUPERSEDED_PER_CAS', 64, { min: 0, max: 256 }),
    maxPreviewIndexEnvelopeBatch: readInteger(env, 'VAULT_PREVIEW_INDEX_MAX_ENVELOPE_BATCH', 32, { min: 1, max: 128 }),
    // งบพื้นที่ที่ index เก็บค้างไว้ต่อเจ้าของ (INDEX_STAGED + INDEX_MANAGED ciphertext) — ไม่มีค่า default: ไม่ตั้ง = null
    maxPreviewIndexRetainedBytesPerOwner: readOptionalInteger(env, 'VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER', { min: MIB, max: 64 * GIB }),
  }
  if (flags.previewIndexWriteEnabled && limits.maxPreviewIndexRetainedBytesPerOwner === null) {
    throw new Error('VAULT_PREVIEW_INDEX_WRITE_ENABLED=true requires VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER (no approved default; fail-closed)')
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

/** ค่า lifecycle ที่ migration 012 เพิ่มเข้า CHECK ของ vault_tree_blob_state */
export const PREVIEW_INDEX_LIFECYCLE_VALUES = Object.freeze(['INDEX_STAGED', 'INDEX_MANAGED'])

/**
 * boot probe ของ D-1: เมื่อ previewIndexSchemaAvailable=true ต้องพบทุกตารางใน PREVIEW_INDEX_TABLES และ CHECK ของ
 * lifecycle ต้องรับ INDEX_STAGED/INDEX_MANAGED แล้ว — ไม่งั้นบูตล้ม; เมื่อ false ไม่เรียก probe เลย
 * @param {ReturnType<typeof vaultTreeConfigFromEnv>} config
 * @param {() => Promise<{missing:string[], lifecycleValuesOk:boolean}>} probe
 */
export async function verifyPreviewIndexSchema(config, probe) {
  if (!config.flags.previewIndexSchemaAvailable) return { probed: false, missing: [] }
  const { missing, lifecycleValuesOk } = await probe()
  if (missing.length) throw new Error(`VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE=true but preview-index tables are missing: ${missing.join(', ')}`)
  if (!lifecycleValuesOk) throw new Error(`VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE=true but vault_tree_blob_state.lifecycle does not accept ${PREVIEW_INDEX_LIFECYCLE_VALUES.join('/')} (apply migration 012)`)
  return { probed: true, missing: [] }
}

/** ค่าที่ process นี้ใช้จริง — อ่านครั้งเดียว */
export const VAULT_TREE_CONFIG = vaultTreeConfigFromEnv()
