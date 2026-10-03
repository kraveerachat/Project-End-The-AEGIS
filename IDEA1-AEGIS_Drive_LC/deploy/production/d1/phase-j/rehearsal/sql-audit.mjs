// D-1 Phase J replica: destructive-SQL audit over the replica PostgreSQL statement log (log_statement=all).
// Only statements between the D1REP_MARK RUNTIME_BEGIN / RUNTIME_END markers count; harness setup (schema, roles,
// migration 012 — the Stage 1 history) runs before RUNTIME_BEGIN and harness teardown after RUNTIME_END.
//   node sql-audit.mjs <pg.log> <superuser>
import fs from 'node:fs'

const [, , LOG, SUPER] = process.argv
const PROTECTED = /\b(vault_v2_blobs|vault_v2_blob_chunks|vault_tree_blob_state|vault_tree_revisions|vault_tree_heads|vault_preview_index_heads|vault_preview_index_generations|vault_preview_index_blob_refs)\b/i
const HEAD = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+ \S+ \[\d+\] (\S*)@(\S*) ([A-Z]+):\s+(.*)$/
const entries = []
for (const line of fs.readFileSync(LOG, 'utf8').split(/\r?\n/)) {
  const m = HEAD.exec(line)
  if (m) entries.push({ user: m[1], level: m[3], text: m[4] })
  else if (entries.length && /^\s/.test(line)) entries.at(-1).text += `\n${line}`
}
const stmts = entries.filter((e) => e.level === 'LOG' && /^(statement|execute [^:]*):/.test(e.text))
  .map((e) => ({ user: e.user, sql: e.text.replace(/^(statement|execute [^:]*):\s*/, '') }))
const idx = (mark) => stmts.findIndex((s) => s.sql.includes(`D1REP_MARK ${mark}`))
const begin = idx('RUNTIME_BEGIN'); const end = idx('RUNTIME_END'); const frozen = idx('INDEX_FROZEN')
if (begin < 0 || end < 0 || frozen < 0 || !(begin < frozen && frozen < end)) { console.log(`SQL_CAPTURE_VERIFY=FAIL (markers ${begin}/${frozen}/${end})`); process.exit(1) }
const win = stmts.slice(begin + 1, end)
const afterFrozen = stmts.slice(frozen + 1, end)
const find = (list, re, extra = () => true) => list.filter((s) => re.test(s.sql) && extra(s))
// Statement-shape matching (not bare keywords): a read-only query that merely mentions 'DELETE' in a string
// literal (e.g. has_table_privilege(..., 'DELETE')) or names a table is not a write.
const T = PROTECTED.source.replace(/^\\b\(|\)\\b$/g, '')
const DELETE_PROTECTED = new RegExp(`\\bDELETE\\s+FROM\\s+(ONLY\\s+)?"?(${T})\\b`, 'i')
const PI_WRITE = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(ONLY\s+)?"?vault_preview_index_\w+/i
const ev = {
  statementsInWindow: win.length,
  byUser: Object.fromEntries([...new Set(win.map((s) => s.user))].map((u) => [u, win.filter((s) => s.user === u).length])),
  dropOrTruncate: find(win, /^\s*(DROP|TRUNCATE)\b|\bTRUNCATE\s+(TABLE\s+)?(ONLY\s+)?"?[a-z_]/im),
  deleteOnProtected: find(win, DELETE_PROTECTED),
  purgeCandidateInsert: find(win, /INSERT\s+INTO\s+"?vault_tree_purge_candidates/i),
  ddl: find(win, /^\s*(ALTER|CREATE|DROP|COMMENT|GRANT|REVOKE)\b/im),
  superuserNonRead: win.filter((s) => s.user === SUPER && !/^\s*(SELECT|SHOW|BEGIN|COMMIT|ROLLBACK|SET\s)/i.test(s.sql)),
  previewIndexWritesAfterFreeze: find(afterFrozen, PI_WRITE),
  indexLifecycleWritesAfterFreeze: find(afterFrozen, /\bUPDATE\s+"?vault_tree_blob_state\b[\s\S]*\bSET\b[\s\S]*lifecycle\s*=\s*'INDEX_/i),
  otherDeletes: find(win, /\bDELETE\s+FROM\b/i, (s) => !DELETE_PROTECTED.test(s.sql)).map((s) => `${s.user}: ${s.sql.replace(/\s+/g, ' ').slice(0, 120)}`),
}
const bad = ['dropOrTruncate', 'deleteOnProtected', 'purgeCandidateInsert', 'ddl', 'superuserNonRead', 'previewIndexWritesAfterFreeze', 'indexLifecycleWritesAfterFreeze']
  .filter((k) => ev[k].length)
for (const k of bad) console.log(`VIOLATION ${k}: ${JSON.stringify(ev[k].slice(0, 5))}`)
console.log(`SQL_AUDIT ${JSON.stringify({ ...ev, otherDeletes: [...new Set(ev.otherDeletes)], ...Object.fromEntries(bad.map((k) => [k, ev[k].length])) })}`)
const live = win.length > 500 && (ev.byUser.drive_app ?? 0) > 200
console.log(`NO_DOWNMIGRATION=${ev.ddl.length || ev.dropOrTruncate.length ? 'NO' : 'YES'}`)
console.log(`NO_DESTRUCTIVE_D1_DELETE=${ev.deleteOnProtected.length ? 'NO' : 'YES'}`)
console.log(`NO_PURGE=${ev.purgeCandidateInsert.length ? 'NO' : 'YES'}`)
console.log(`SQL_CAPTURE_VERIFY=${!bad.length && live ? 'PASS' : 'FAIL'} (window ${win.length} statements, drive_app ${ev.byUser.drive_app ?? 0})`)
process.exit(!bad.length && live ? 0 : 1)
