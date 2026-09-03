// src/restic.js — AEGIS host backup agent · restic wrapper
//
// Why restic: an encrypted, deduplicated, content-addressed repository with a
// built-in integrity check (`restic check`), verified restore, and retention
// pruning — all of it battle-tested and all of it driven by discrete arguments.
// The alternative, an rsync mirror, has no integrity check and no way to say
// "this snapshot is complete"; a `cp` that exited 0 is not evidence.
//
// Every method here runs the ONE configured binary with a fixed argument
// shape and parses restic's own `--json` output. No output is ever forwarded
// to Drive; only the parsed, allowlisted numbers are.
import { runFixed } from './exec.js'

/** Generous ceilings; a backup of the 60 GiB Data Lake to USB is minutes, not hours. */
export const BACKUP_TIMEOUT_MS = 6 * 60 * 60 * 1000
export const CHECK_TIMEOUT_MS = 2 * 60 * 60 * 1000
export const QUICK_TIMEOUT_MS = 5 * 60 * 1000

/** Parse restic's JSON-lines output into objects, ignoring non-JSON lines. */
export function parseJsonLines(text) {
  const objects = []
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      objects.push(JSON.parse(trimmed))
    } catch {
      /* progress noise — ignored */
    }
  }
  return objects
}

/** Reduce `restic backup --json` output to the numbers the contract carries. */
export function summarizeBackupOutput(stdout) {
  const summary = parseJsonLines(stdout).find((o) => o.message_type === 'summary')
  if (!summary) return null
  const num = (v) => (Number.isFinite(v) && v >= 0 ? v : null)
  return {
    snapshotId: typeof summary.snapshot_id === 'string' ? summary.snapshot_id.slice(0, 64) : null,
    bytesScanned: num(summary.total_bytes_processed),
    bytesBackedUp: num(summary.data_added),
    filesNew: num(summary.files_new),
    filesChanged: num(summary.files_changed),
    filesUnmodified: num(summary.files_unmodified),
  }
}

/**
 * @param {object} options
 * @param {string} options.binary
 * @param {string} options.passwordFile
 * @param {string} options.repository
 * @param {string} options.cacheDir
 * @param {Function} [options.exec] runFixed-compatible, injectable for tests
 */
export function createRestic({ binary, passwordFile, repository, cacheDir, exec = runFixed }) {
  if (!binary || !passwordFile || !repository || !cacheDir) throw new Error('restic wrapper needs binary, passwordFile, repository and cacheDir')

  const env = {
    RESTIC_REPOSITORY: repository,
    RESTIC_PASSWORD_FILE: passwordFile,
    RESTIC_CACHE_DIR: cacheDir,
  }
  const run = (args, timeoutMs) => exec(binary, args, { env, timeoutMs })

  return {
    /** Is the repository initialised? (`cat config` succeeds only on a real repo.) */
    async isInitialized() {
      const result = await run(['cat', 'config', '--json'], QUICK_TIMEOUT_MS)
      return result.exitStatus === 0
    },

    async init() {
      const result = await run(['init', '--json'], QUICK_TIMEOUT_MS)
      return { ok: result.exitStatus === 0 }
    },

    /** Drop a stale lock left by a killed run. Safe on an unlocked repo. */
    async unlock() {
      const result = await run(['unlock'], QUICK_TIMEOUT_MS)
      return { ok: result.exitStatus === 0 }
    },

    /**
     * @param {string[]} paths absolute paths to back up
     * @param {{ tag?: string }} [options]
     */
    async backup(paths, { tag = 'aegis-drive' } = {}) {
      const result = await run(['backup', '--json', '--tag', tag, '--one-file-system', ...paths], BACKUP_TIMEOUT_MS)
      const summary = summarizeBackupOutput(result.stdout)
      return { ok: result.exitStatus === 0 && summary !== null && summary.snapshotId !== null, summary }
    },

    /** Structural repository check, optionally reading a bounded subset of data. */
    async check({ readDataSubset = null } = {}) {
      const args = ['check']
      if (readDataSubset) args.push(`--read-data-subset=${readDataSubset}`)
      const result = await run(args, CHECK_TIMEOUT_MS)
      return { ok: result.exitStatus === 0 }
    },

    async forget(forgetArgs) {
      const result = await run(['forget', '--prune', '--json', '--tag', 'aegis-drive', '--group-by', 'tags', ...forgetArgs], CHECK_TIMEOUT_MS)
      return { ok: result.exitStatus === 0 }
    },

    /** Top-level paths inside a snapshot, from `restic ls --json`. */
    async listSnapshot(snapshot = 'latest') {
      const result = await run(['ls', '--json', snapshot], QUICK_TIMEOUT_MS)
      if (result.exitStatus !== 0) return { ok: false, paths: [] }
      const paths = parseJsonLines(result.stdout)
        .filter((o) => o.struct_type === 'node' || o.message_type === 'node')
        .map((o) => o.path)
        .filter((p) => typeof p === 'string')
      return { ok: true, paths }
    },

    /** Restore a subset of a snapshot into an isolated directory. */
    async restoreTo(targetDir, { snapshot = 'latest', include = [] } = {}) {
      const args = ['restore', snapshot, '--target', targetDir]
      for (const pattern of include) args.push('--include', pattern)
      const result = await run(args, CHECK_TIMEOUT_MS)
      return { ok: result.exitStatus === 0 }
    },

    /** Latest snapshot id and time, from `restic snapshots --json`. */
    async latestSnapshot() {
      const result = await run(['snapshots', '--json', '--latest', '1', '--tag', 'aegis-drive'], QUICK_TIMEOUT_MS)
      if (result.exitStatus !== 0) return null
      let parsed
      try {
        parsed = JSON.parse(result.stdout)
      } catch {
        return null
      }
      const last = Array.isArray(parsed) && parsed.length ? parsed[parsed.length - 1] : null
      if (!last || typeof last.short_id !== 'string') return null
      const timeMs = Date.parse(last.time)
      return { snapshotId: last.short_id, time: Number.isFinite(timeMs) ? new Date(timeMs).toISOString() : null }
    },
  }
}
