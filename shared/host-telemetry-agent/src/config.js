// src/config.js — AEGIS host telemetry agent · configuration boundary
//
// Two things live here and nothing else: the approved production constants, and
// the one input that can influence a filesystem path (the interface name).
//
// The interface is deliberately explicit. An agent that auto-selects "the first
// NIC that is up" publishes throughput for a link nobody named, and the number
// silently changes meaning when the host's topology changes. Naming it also
// keeps the /sys read surface to exactly two files.
import path from 'node:path'

/** The NIC verified as UP on the production host during preflight. */
export const DEFAULT_INTERFACE = 'enp1s0'

/** Socket lives in a RuntimeDirectory owned by the agent's own service user. */
export const DEFAULT_SOCKET_PATH = '/run/aegis-telemetry/telemetry.sock'

/**
 * 0660: owner (aegis-telemetry) and group (GID 29100, which Drive joins via
 * group_add) may read; everyone else on the host may not. World-readable would
 * hand host metrics to every unprivileged local account.
 */
export const SOCKET_MODE = 0o660

/** ~5s: long enough for a meaningful CPU window, short enough to stay under
 *  Drive's 15s stale threshold with room for one missed cycle. */
export const DEFAULT_INTERVAL_MS = 5000

const SYS_CLASS_NET = '/sys/class/net'
const MAX_INTERFACE_LENGTH = 15 // Linux IFNAMSIZ is 16 including the NUL

// Linux interface names in practice: letters, digits, and the separators used
// by predictable naming (enp1s0, eth0.100, br-ext). No slash, no dot-only, no
// whitespace, no NUL — so the name can never climb out of /sys/class/net.
const INTERFACE_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9_.:-]*[A-Za-z0-9])?$/

/**
 * Validate an explicitly configured interface name.
 *
 * @param {unknown} value
 * @returns {string | null} the trimmed name, or null when it is unusable
 */
export function resolveInterfaceName(value) {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (!name || name.length > MAX_INTERFACE_LENGTH) return null
  if (name === '.' || name === '..') return null
  if (!INTERFACE_PATTERN.test(name)) return null
  return name
}

/**
 * The exactly two /sys files the agent is allowed to read for an interface.
 *
 * @param {string} interfaceName
 * @returns {{ rx: string, tx: string }}
 */
export function networkStatisticsPaths(interfaceName) {
  const name = resolveInterfaceName(interfaceName)
  if (!name) throw new Error('unusable telemetry interface name')
  const base = path.posix.join(SYS_CLASS_NET, name, 'statistics')
  return { rx: path.posix.join(base, 'rx_bytes'), tx: path.posix.join(base, 'tx_bytes') }
}

/**
 * Resolve the agent's runtime configuration from the environment.
 *
 * Anything unusable throws at boot rather than degrading quietly: a telemetry
 * agent that starts with a nonsense interval or a wrong interface is worse than
 * one that refuses to start, because its output looks authoritative.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadAgentConfig(env = process.env) {
  const interfaceName = resolveInterfaceName(env.AEGIS_TELEMETRY_INTERFACE ?? DEFAULT_INTERFACE)
  if (!interfaceName) throw new Error('AEGIS_TELEMETRY_INTERFACE is not a usable interface name')

  const rawInterval = env.AEGIS_TELEMETRY_INTERVAL_MS
  let intervalMs = DEFAULT_INTERVAL_MS
  if (rawInterval !== undefined && rawInterval !== '') {
    intervalMs = Number(rawInterval)
    // Floor 1s keeps the agent off the CPU it is measuring; ceiling 15s keeps
    // every published snapshot younger than Drive's stale threshold.
    if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 15_000) {
      throw new Error('AEGIS_TELEMETRY_INTERVAL_MS must be an integer interval between 1000 and 15000')
    }
  }

  const socketPath = String(env.AEGIS_TELEMETRY_SOCKET ?? DEFAULT_SOCKET_PATH).trim()
  if (!socketPath) throw new Error('AEGIS_TELEMETRY_SOCKET must not be empty')

  const network = networkStatisticsPaths(interfaceName)

  return {
    interfaceName,
    socketPath,
    socketMode: SOCKET_MODE,
    intervalMs,
    sources: {
      procStat: '/proc/stat',
      memInfo: '/proc/meminfo',
      uptime: '/proc/uptime',
      networkRx: network.rx,
      networkTx: network.tx,
    },
  }
}
