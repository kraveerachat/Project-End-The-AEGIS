// collectors/disk-health.js — AEGIS host disk-health collector · the one privileged edge
//
// Why this is NOT inside src/: the telemetry agent runs with an empty capability
// bounding set, a private /dev, and a test that forbids child_process anywhere
// under src/. SMART needs the opposite of all three — raw ioctl access to one
// block device (CAP_SYS_RAWIO) — so it cannot live in that process without
// dismantling the boundary that makes the agent safe to run.
//
// This collector is therefore a separate, short-lived systemd oneshot on a
// timer (deploy/aegis-disk-health.{service,timer}). It runs exactly one fixed
// binary with fixed arguments against exactly one operator-configured device,
// reduces the output to the allowlisted evidence shape in smart.js, and writes
// that as one small JSON file. The unprivileged agent then READS that file —
// which keeps the agent a file-reads-only process — and publishes it on
// /internal/disk-health.
//
// Nothing here can be steered by a request: there is no socket, no argument
// parsing, no path derived from anything but the environment systemd set.
import { execFile as execFileCallback } from 'node:child_process'
import fspDefault from 'node:fs/promises'
import path from 'node:path'

import { evidenceFromSmartctl } from './smart.js'

/** The disk-health evidence contract version. */
export const DISK_HEALTH_SCHEMA_VERSION = 1

/** Where the evidence file is written; a StateDirectory owned by the collector. */
export const DEFAULT_OUTPUT_PATH = '/var/lib/aegis-disk-health/disk-health.json'

/** The one binary this collector may execute. Absolute on purpose: no PATH lookup. */
export const DEFAULT_SMARTCTL_PATH = '/usr/sbin/smartctl'

/**
 * Fixed argument list. `--json` selects machine output; the three flags read
 * identity, overall health, and the attribute table. Nothing here writes to,
 * tests, or reconfigures the device (no -t, no -s, no -X).
 */
export const SMARTCTL_ARGS = Object.freeze(['--json', '--info', '--health', '--attributes'])

/** A bounded run: smartctl on a healthy SATA/NVMe device answers in well under a second. */
export const SMARTCTL_TIMEOUT_MS = 20_000

/** smartctl JSON for one device is a few KiB; 1 MiB is pure headroom. */
export const MAX_SMARTCTL_OUTPUT_BYTES = 1024 * 1024

/**
 * Block-device names this collector will accept. Whole devices only, never a
 * partition, never a path: the operator names `sda`, and `/dev/` is prepended
 * here. That makes "read an arbitrary /dev path" impossible by construction.
 */
const DEVICE_PATTERN = /^(sd[a-z]{1,2}|vd[a-z]{1,2}|nvme[0-9]{1,2}n[0-9]{1,2}|mmcblk[0-9]{1,2})$/

/**
 * Validate an operator-supplied device name.
 *
 * @param {unknown} value
 * @returns {string | null} bare device name, or null when unusable
 */
export function resolveDeviceName(value) {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (!DEVICE_PATTERN.test(name)) return null
  return name
}

/** `/dev/<name>` for a validated name; throws otherwise. */
export function devicePathFor(name) {
  const resolved = resolveDeviceName(name)
  if (!resolved) throw new Error('unusable disk-health device name')
  return path.posix.join('/dev', resolved)
}

/**
 * Resolve the collector configuration from the environment; unusable values
 * refuse to run rather than measure the wrong device.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadCollectorConfig(env = process.env) {
  const device = resolveDeviceName(env.AEGIS_DISK_HEALTH_DEVICE)
  if (!device) throw new Error('AEGIS_DISK_HEALTH_DEVICE must name a whole block device such as sda or nvme0n1')

  const smartctlPath = String(env.AEGIS_DISK_HEALTH_SMARTCTL ?? DEFAULT_SMARTCTL_PATH).trim()
  if (!path.posix.isAbsolute(smartctlPath)) throw new Error('AEGIS_DISK_HEALTH_SMARTCTL must be an absolute path')

  const outputPath = String(env.AEGIS_DISK_HEALTH_OUTPUT ?? DEFAULT_OUTPUT_PATH).trim()
  if (!path.posix.isAbsolute(outputPath)) throw new Error('AEGIS_DISK_HEALTH_OUTPUT must be an absolute path')

  return { device, devicePath: devicePathFor(device), smartctlPath, outputPath }
}

/**
 * Default executor: resolves with stdout and the exit status even when the
 * status is non-zero, because smartctl reports health findings THROUGH the
 * exit status (bit 3 = disk failing) while still printing valid JSON.
 */
function defaultExecFile(file, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFileCallback(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_SMARTCTL_OUTPUT_BYTES, windowsHide: true },
      (error, stdout) => {
        if (error && typeof error.code === 'string') return reject(error) // ENOENT, EACCES, ...
        if (error && error.killed) return reject(Object.assign(new Error('smartctl timed out'), { code: 'ETIMEDOUT' }))
        const exitStatus = error && Number.isInteger(error.code) ? error.code : 0
        resolve({ stdout: String(stdout ?? ''), exitStatus })
      },
    )
  })
}

/**
 * Run smartctl once and reduce its output to evidence.
 *
 * Never throws for a device-side or tool-side problem: those become
 * `{ available: false, reason }` so the evidence file always states WHY there
 * is no health reading. Only a configuration error escapes.
 *
 * @param {object} config from loadCollectorConfig()
 * @param {{ execFile?: Function, now?: () => number }} [deps]
 */
export async function collectDiskHealth(config, { execFile = defaultExecFile, now = Date.now } = {}) {
  const measuredAt = new Date(now()).toISOString()
  const envelope = (disk) => ({
    schemaVersion: DISK_HEALTH_SCHEMA_VERSION,
    measuredAt,
    device: config.device,
    disk,
  })

  let run
  try {
    run = await execFile(config.smartctlPath, [...SMARTCTL_ARGS, config.devicePath], { timeoutMs: SMARTCTL_TIMEOUT_MS })
  } catch (err) {
    if (err?.code === 'ENOENT') return envelope({ available: false, reason: 'smartctl-absent' })
    if (err?.code === 'EACCES' || err?.code === 'EPERM') return envelope({ available: false, reason: 'smartctl-not-executable' })
    if (err?.code === 'ETIMEDOUT') return envelope({ available: false, reason: 'smartctl-timeout' })
    return envelope({ available: false, reason: 'smartctl-failed' })
  }

  if (Buffer.byteLength(run.stdout) > MAX_SMARTCTL_OUTPUT_BYTES) {
    return envelope({ available: false, reason: 'unsupported-output' })
  }

  let parsed
  try {
    parsed = JSON.parse(run.stdout)
  } catch {
    return envelope({ available: false, reason: 'unsupported-output' })
  }

  return envelope(evidenceFromSmartctl(parsed, { exitStatus: run.exitStatus }))
}

/**
 * Write the evidence atomically: a reader (the agent, on its own 5 s cycle)
 * must see either the previous complete file or the new complete file, never
 * a half-written one.
 *
 * @param {string} outputPath
 * @param {object} evidence
 * @param {{ fs?: object }} [deps]
 */
export async function writeEvidenceFile(outputPath, evidence, { fs = fspDefault } = {}) {
  const tmp = `${outputPath}.tmp-${process.pid}`
  const body = JSON.stringify(evidence)
  await fs.writeFile(tmp, body, { encoding: 'utf8', mode: 0o640 })
  await fs.rename(tmp, outputPath)
}
