// src/config.js — AEGIS host backup agent · configuration boundary
//
// Two layers, deliberately separate:
//
//   static config   /etc/aegis/backup-agent.json — root-owned, read-only to the
//                   agent. Names the binaries, the source paths, the database
//                   connection, the credential FILES, and the allowlist of
//                   targets an Admin may choose from. Nothing in Drive can
//                   change it.
//
//   policy          <stateDir>/policy.json — agent-owned. The four things an
//                   Admin may set through Drive: which allowlisted target is
//                   active, which schedule preset, which retention preset, and
//                   whether the schedule is enabled. Every value is an ID from a
//                   fixed set; there is no free-form path, host, or command.
//
// A browser therefore never supplies a path. It supplies an ID, and the agent
// resolves the ID against a file only root can write.
import path from 'node:path'

import { RETENTION_IDS, SCHEDULE_IDS } from './schedule.js'

export const CONFIG_SCHEMA_VERSION = 1
export const DEFAULT_CONFIG_PATH = '/etc/aegis/backup-agent.json'
export const DEFAULT_SOCKET_PATH = '/run/aegis-backup/backup.sock'
export const DEFAULT_STATE_DIR = '/var/lib/aegis-backup'
export const SOCKET_MODE = 0o660

/** Target kinds the agent understands. Anything else is rejected at load. */
export const TARGET_TYPES = Object.freeze(['external-mount', 'off-host-sftp', 'off-host-rest'])

/** The subdirectories of the Data Lake that hold durable, recoverable data. */
export const DEFAULT_SOURCE_INCLUDE = Object.freeze(['uploads', 'versions', 'vault', 'avatars'])

/** Bounds for the write-freeze lease Drive honours (seconds). */
export const LEASE_BOUNDS = Object.freeze({ min: 60, max: 3600, default: 900 })
export const ACK_TIMEOUT_BOUNDS = Object.freeze({ min: 10, max: 600, default: 120 })
export const MAX_AGE_BOUNDS = Object.freeze({ min: 1, max: 24 * 14, default: 36 })
export const VERIFY_INTERVAL_BOUNDS = Object.freeze({ min: 1, max: 90, default: 7 })

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const absolutePath = (value) => typeof value === 'string' && path.posix.isAbsolute(value) && !value.includes('\0')

export const isTargetId = (value) => typeof value === 'string' && ID_PATTERN.test(value)

function boundedInt(value, bounds, name) {
  if (value === undefined) return bounds.default
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(`${name} must be an integer between ${bounds.min} and ${bounds.max}`)
  }
  return value
}

function validateTarget(raw, index) {
  if (!isPlainObject(raw)) throw new Error(`targets[${index}] must be an object`)
  if (!isTargetId(raw.id)) throw new Error(`targets[${index}].id must be a short lowercase identifier`)
  if (typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > 64) {
    throw new Error(`targets[${index}].label must be a short label`)
  }
  if (!TARGET_TYPES.includes(raw.type)) throw new Error(`targets[${index}].type must be one of ${TARGET_TYPES.join(', ')}`)

  const target = { id: raw.id, label: raw.label.trim(), type: raw.type }
  if (raw.type === 'external-mount') {
    if (!absolutePath(raw.mountPoint)) throw new Error(`targets[${index}].mountPoint must be an absolute path`)
    if (!absolutePath(raw.repositoryPath)) throw new Error(`targets[${index}].repositoryPath must be an absolute path`)
    if (!raw.repositoryPath.startsWith(raw.mountPoint.replace(/\/+$/, '') + '/')) {
      throw new Error(`targets[${index}].repositoryPath must live inside its mountPoint`)
    }
    target.mountPoint = raw.mountPoint
    target.repository = raw.repositoryPath
  } else {
    // restic repository strings for remote backends: sftp:user@host:/path or rest:https://...
    const prefix = raw.type === 'off-host-sftp' ? 'sftp:' : 'rest:'
    if (typeof raw.repository !== 'string' || !raw.repository.startsWith(prefix) || raw.repository.length > 512) {
      throw new Error(`targets[${index}].repository must start with ${prefix}`)
    }
    // A credential belongs in a file, never in the repository URL.
    if (/:\/\/[^/]*:[^/@]*@/.test(raw.repository)) throw new Error(`targets[${index}].repository must not embed a password`)
    target.repository = raw.repository
  }
  return target
}

/**
 * Validate the static configuration document.
 *
 * @param {unknown} raw parsed JSON
 * @returns {object} normalized static config
 */
export function validateStaticConfig(raw) {
  if (!isPlainObject(raw)) throw new Error('backup config must be a JSON object')
  if (raw.schemaVersion !== CONFIG_SCHEMA_VERSION) throw new Error(`backup config schemaVersion must be ${CONFIG_SCHEMA_VERSION}`)

  const socketPath = raw.socketPath === undefined ? DEFAULT_SOCKET_PATH : raw.socketPath
  if (!absolutePath(socketPath)) throw new Error('socketPath must be absolute')
  const stateDir = raw.stateDir === undefined ? DEFAULT_STATE_DIR : raw.stateDir
  if (!absolutePath(stateDir)) throw new Error('stateDir must be absolute')

  if (!isPlainObject(raw.source) || !absolutePath(raw.source.datalakePath)) throw new Error('source.datalakePath must be absolute')
  const include = raw.source.include === undefined ? [...DEFAULT_SOURCE_INCLUDE] : raw.source.include
  if (!Array.isArray(include) || include.length === 0 || !include.every((name) => /^[a-z][a-z0-9_-]{0,31}$/.test(name))) {
    throw new Error('source.include must list plain subdirectory names')
  }

  const pg = raw.postgres
  if (!isPlainObject(pg)) throw new Error('postgres must be an object')
  if (typeof pg.host !== 'string' || !/^[A-Za-z0-9.-]{1,253}$/.test(pg.host)) throw new Error('postgres.host must be a hostname or address')
  const port = pg.port === undefined ? 5432 : pg.port
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('postgres.port must be a TCP port')
  if (typeof pg.database !== 'string' || !/^[A-Za-z0-9_]{1,63}$/.test(pg.database)) throw new Error('postgres.database must be an identifier')
  if (typeof pg.user !== 'string' || !/^[A-Za-z0-9_]{1,63}$/.test(pg.user)) throw new Error('postgres.user must be an identifier')
  if (!absolutePath(pg.passwordFile)) throw new Error('postgres.passwordFile must be an absolute path (a pgpass-format file)')
  if ('password' in pg) throw new Error('postgres.password must not be inline — use passwordFile')

  const restic = raw.restic
  if (!isPlainObject(restic)) throw new Error('restic must be an object')
  const resticBinary = restic.binary === undefined ? '/usr/bin/restic' : restic.binary
  if (!absolutePath(resticBinary)) throw new Error('restic.binary must be absolute')
  if (!absolutePath(restic.passwordFile)) throw new Error('restic.passwordFile must be an absolute path')
  if ('password' in restic) throw new Error('restic.password must not be inline — use passwordFile')

  const tools = isPlainObject(raw.tools) ? raw.tools : {}
  const pgDumpBinary = tools.pgDump === undefined ? '/usr/bin/pg_dump' : tools.pgDump
  const pgRestoreBinary = tools.pgRestore === undefined ? '/usr/bin/pg_restore' : tools.pgRestore
  if (!absolutePath(pgDumpBinary) || !absolutePath(pgRestoreBinary)) throw new Error('tools.pgDump / tools.pgRestore must be absolute')

  if (!Array.isArray(raw.targets)) throw new Error('targets must be an array (it may be empty)')
  const targets = raw.targets.map(validateTarget)
  const ids = new Set(targets.map((t) => t.id))
  if (ids.size !== targets.length) throw new Error('targets must have unique ids')

  const limits = isPlainObject(raw.limits) ? raw.limits : {}
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    socketPath,
    socketMode: SOCKET_MODE,
    stateDir,
    source: { datalakePath: raw.source.datalakePath, include },
    postgres: { host: pg.host, port, database: pg.database, user: pg.user, passwordFile: pg.passwordFile },
    restic: { binary: resticBinary, passwordFile: restic.passwordFile },
    tools: { pgDump: pgDumpBinary, pgRestore: pgRestoreBinary },
    targets,
    limits: {
      quiesceLeaseSeconds: boundedInt(limits.quiesceLeaseSeconds, LEASE_BOUNDS, 'limits.quiesceLeaseSeconds'),
      quiesceAckTimeoutSeconds: boundedInt(limits.quiesceAckTimeoutSeconds, ACK_TIMEOUT_BOUNDS, 'limits.quiesceAckTimeoutSeconds'),
      maxBackupAgeHours: boundedInt(limits.maxBackupAgeHours, MAX_AGE_BOUNDS, 'limits.maxBackupAgeHours'),
      verifyIntervalDays: boundedInt(limits.verifyIntervalDays, VERIFY_INTERVAL_BOUNDS, 'limits.verifyIntervalDays'),
    },
  }
}

/** The default policy: nothing selected, nothing scheduled. */
export const DEFAULT_POLICY = Object.freeze({
  activeTargetId: null,
  scheduleId: 'disabled',
  retentionId: 'keep-7d-4w',
  enabled: false,
})

/**
 * Validate a policy document against the allowlists. Unknown keys are refused;
 * an unknown target ID is refused; the result is always a complete policy.
 *
 * @param {unknown} raw
 * @param {{ targets: Array<{ id: string }> }} config
 */
export function validatePolicy(raw, config) {
  if (!isPlainObject(raw)) throw new Error('policy must be an object')
  const allowed = ['activeTargetId', 'scheduleId', 'retentionId', 'enabled']
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw new Error(`policy.${key} is not a recognised setting`)
  }
  const policy = { ...DEFAULT_POLICY, ...raw }
  if (policy.activeTargetId !== null) {
    if (!isTargetId(policy.activeTargetId)) throw new Error('policy.activeTargetId must be a target id or null')
    if (!config.targets.some((t) => t.id === policy.activeTargetId)) throw new Error('policy.activeTargetId is not an allowlisted target')
  }
  if (!SCHEDULE_IDS.includes(policy.scheduleId)) throw new Error('policy.scheduleId is not an allowed schedule')
  if (!RETENTION_IDS.includes(policy.retentionId)) throw new Error('policy.retentionId is not an allowed retention policy')
  if (typeof policy.enabled !== 'boolean') throw new Error('policy.enabled must be a boolean')
  return policy
}

/**
 * Load the static config from disk.
 *
 * @param {{ env?: NodeJS.ProcessEnv, readFile?: (p: string, enc: string) => Promise<string> }} [deps]
 */
export async function loadStaticConfig({ env = process.env, readFile } = {}) {
  const configPath = String(env.AEGIS_BACKUP_CONFIG ?? DEFAULT_CONFIG_PATH).trim()
  if (!absolutePath(configPath)) throw new Error('AEGIS_BACKUP_CONFIG must be an absolute path')
  const read = readFile ?? (await import('node:fs/promises')).readFile
  let text
  try {
    text = await read(configPath, 'utf8')
  } catch (err) {
    throw new Error(`cannot read backup config ${configPath}: ${err.code ?? err.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`backup config ${configPath} is not valid JSON`)
  }
  return validateStaticConfig(parsed)
}
