// tests/vaultTreeStore.test.js — AEGIS Drive (IDEA1) · PR #157 Task 2.2 · opaque tree store, in-memory mode
//
// ⚠️ spec เดียวกับที่รันกับ PostgreSQL จริงใน tests/vaultTreePostgres.test.js — โหมดหน่วยความจำพิสูจน์
//    "รูปร่างและความหมาย" ไม่ใช่ concurrency (นั่นพิสูจน์ได้เฉพาะกับ PG)
import test from 'node:test'
delete process.env.DATABASE_URL
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'

const store = await import('../server/db/vaultTreeStore.js')
const { usingPostgres } = await import('../server/db/connection.js')
if (usingPostgres) throw new Error('this file must run in memory mode')
const { defineStoreSpec } = await import('./helpers/vaultTreeStoreSpec.mjs')

defineStoreSpec({ test, store, userA: '2', userB: '1', reset: () => store.__resetVaultTreeForTests() })
