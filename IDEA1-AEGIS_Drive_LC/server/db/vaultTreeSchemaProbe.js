// server/db/vaultTreeSchemaProbe.js — AEGIS Drive (IDEA1) · Private Vault encrypted hierarchy · boot probe
//
// ใช้ตอนบูตเมื่อ VAULT_TREE_SCHEMA_AVAILABLE=true: ถามฐานข้อมูลว่าตาราง tree ทั้งเจ็ดมีอยู่จริง
// (to_regclass) — ไม่สร้าง ไม่แก้ ไม่อ่านแถวใด ๆ ในโหมด in-memory (ไม่มี DATABASE_URL) ถือว่าครบ
// เพราะ store ในหน่วยความจำไม่มีตารางให้หาย
import { query, usingPostgres } from './connection.js'
import { TREE_TABLES, PREVIEW_INDEX_TABLES, PREVIEW_INDEX_LIFECYCLE_VALUES } from '../config/vaultTreeLimits.js'

export async function probeTreeSchema() {
  if (!usingPostgres) return { missing: [] }
  const missing = []
  for (const table of TREE_TABLES) {
    const { rows } = await query('SELECT to_regclass($1) AS oid', [`public.${table}`])
    if (!rows[0]?.oid) missing.push(table)
  }
  return { missing }
}

/**
 * D-1 boot probe (VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE=true): the three migration-012 tables exist AND the
 * vault_tree_blob_state lifecycle CHECK accepts INDEX_STAGED/INDEX_MANAGED. Reads the catalog only; changes nothing.
 * In-memory mode has nothing that can be missing.
 * @param {{ q?: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>, pg?: boolean }} [o] injectable for tests
 */
export async function probePreviewIndexSchema({ q = query, pg = usingPostgres } = {}) {
  if (!pg) return { missing: [], lifecycleValuesOk: true }
  const missing = []
  for (const table of PREVIEW_INDEX_TABLES) {
    const { rows } = await q('SELECT to_regclass($1) AS oid', [`public.${table}`])
    if (!rows[0]?.oid) missing.push(table)
  }
  const { rows } = await q(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = to_regclass('public.vault_tree_blob_state') AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%lifecycle%'`,
  )
  const lifecycleValuesOk = rows.length === 1 && PREVIEW_INDEX_LIFECYCLE_VALUES.every((v) => rows[0].def.includes(`'${v}'`))
  return { missing, lifecycleValuesOk }
}
