// server/db/vaultTreeSchemaProbe.js — AEGIS Drive (IDEA1) · Private Vault encrypted hierarchy · boot probe
//
// ใช้ตอนบูตเมื่อ VAULT_TREE_SCHEMA_AVAILABLE=true: ถามฐานข้อมูลว่าตาราง tree ทั้งเจ็ดมีอยู่จริง
// (to_regclass) — ไม่สร้าง ไม่แก้ ไม่อ่านแถวใด ๆ ในโหมด in-memory (ไม่มี DATABASE_URL) ถือว่าครบ
// เพราะ store ในหน่วยความจำไม่มีตารางให้หาย
import { query, usingPostgres } from './connection.js'
import { TREE_TABLES } from '../config/vaultTreeLimits.js'

export async function probeTreeSchema() {
  if (!usingPostgres) return { missing: [] }
  const missing = []
  for (const table of TREE_TABLES) {
    const { rows } = await query('SELECT to_regclass($1) AS oid', [`public.${table}`])
    if (!rows[0]?.oid) missing.push(table)
  }
  return { missing }
}
