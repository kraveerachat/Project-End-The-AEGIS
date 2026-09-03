// src/pgdump.js — AEGIS host backup agent · PostgreSQL metadata dump
//
// The Data Lake bytes are useless without the `files`, `file_versions`,
// `vault_*`, `users` and `shares` rows that say what they are and who owns
// them. pg_dump in custom format gives one transaction-consistent snapshot of
// the whole aegis_drive database; pg_restore --list is the cheapest proof that
// the dump is a readable archive and not a truncated file.
//
// The password is read by libpq from PGPASSFILE. It is never an argument and
// never an environment variable value.
import { runFixed } from './exec.js'

export const DUMP_TIMEOUT_MS = 30 * 60 * 1000
export const DUMP_FILE_NAME = 'aegis_drive.pgdump'

/**
 * @param {object} options
 * @param {string} options.binary pg_dump
 * @param {{ host: string, port: number, database: string, user: string, passwordFile: string }} options.connection
 * @param {string} options.outputFile
 * @param {Function} [options.exec]
 */
export async function dumpDatabase({ binary, connection, outputFile, exec = runFixed }) {
  const args = [
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    '--compress=6',
    '--host', connection.host,
    '--port', String(connection.port),
    '--username', connection.user,
    '--dbname', connection.database,
    '--file', outputFile,
  ]
  const result = await exec(binary, args, { env: { PGPASSFILE: connection.passwordFile }, timeoutMs: DUMP_TIMEOUT_MS })
  return { ok: result.exitStatus === 0 }
}

/**
 * Prove a dump file is a readable pg_dump archive.
 *
 * @param {object} options
 * @param {string} options.binary pg_restore
 * @param {string} options.file
 * @param {Function} [options.exec]
 */
export async function verifyDumpReadable({ binary, file, exec = runFixed }) {
  const result = await exec(binary, ['--list', file], { timeoutMs: 5 * 60 * 1000 })
  if (result.exitStatus !== 0) return { ok: false, entries: 0 }
  // The TOC lists one line per object; an archive with no TABLE DATA is not a usable dump.
  const lines = result.stdout.split('\n').filter((line) => /^\d+;/.test(line.trim()))
  const hasTableData = lines.some((line) => line.includes('TABLE DATA'))
  return { ok: lines.length > 0 && hasTableData, entries: lines.length }
}
