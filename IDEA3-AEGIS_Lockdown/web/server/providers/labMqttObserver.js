import { spawn as nodeSpawn } from 'node:child_process'
import { statSync as nodeStatSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

/**
 * LAB-only, strictly read-only MQTT observer.
 *
 * It runs one `mosquitto_sub` child that subscribes to exactly `aegis/status` on the fixed loopback LAB broker, using
 * the owner-only credential options file (`-o`). It never publishes, never reads or logs the credential file, never
 * puts a secret on a command line, and exposes only allowlisted, validated fields. Freshness is the LOCAL reception
 * time; the ESP32 payload carries no trusted timestamp. The ESP32 status is NOT the Core safe_status_projection, so
 * nothing here can mark Core, relay, ACK, signed heartbeat or LAN isolation as healthy.
 */
export const LAB_MQTT_BROKER_HOST = '127.0.0.1'
export const LAB_MQTT_BROKER_PORT = 1883
export const LAB_MQTT_TOPIC = 'aegis/status'
const MAX_LINE_BYTES = 2_048
const MAX_PAYLOAD_CHARS = 512
const RESTART_MIN_MS = 1_000
const RESTART_MAX_MS = 30_000

// Firmware state vocabulary is not recorded in this repository, so the state is shape-validated (not enumerated) and is
// only ever shown as "reported by ESP32".
const statusSchema = z.object({
  state: z.string().regex(/^[A-Z][A-Z0-9_]{0,23}$/),
  reason: z.string().regex(/^[a-z0-9_]{1,32}$/),
  rssi: z.number().int().min(-127).max(0),
  heap: z.number().int().min(0).max(4_194_304),
  profile: z.number().int().min(0).max(255),
  time_ok: z.boolean(),
}).strict()

export const LAB_MQTT_PROVENANCE = Object.freeze({
  source: 'LAB_MQTT_OBSERVER',
  topic: LAB_MQTT_TOPIC,
  readOnly: true,
  timestampBasis: 'LOCAL_RECEPTION_TIME',
  coreProjection: false,
  physicalRelayVerified: false,
  signedHeartbeatVerified: false,
})

const REJECTION_KEYS = ['retained', 'malformed', 'unsupported']

/**
 * Parse one `mosquitto_sub -F %j` line. Returns { ok: true, value } or { ok: false, reason }.
 */
export function parseObserverLine(line) {
  if (typeof line !== 'string' || line.length === 0 || line.length > MAX_LINE_BYTES) return { ok: false, reason: 'malformed' }
  let envelope
  try {
    envelope = JSON.parse(line)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return { ok: false, reason: 'malformed' }
  if (envelope.topic !== LAB_MQTT_TOPIC) return { ok: false, reason: 'unsupported' }
  if (envelope.retain !== 0 && envelope.retain !== false) return { ok: false, reason: 'retained' }
  if (typeof envelope.payload !== 'string' || envelope.payload.length > MAX_PAYLOAD_CHARS) return { ok: false, reason: 'malformed' }
  let payload
  try {
    payload = JSON.parse(envelope.payload)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const parsed = statusSchema.safeParse(payload)
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: 'unsupported' }
}

function emptyRejections() {
  return Object.fromEntries(REJECTION_KEYS.map((key) => [key, 0]))
}

function unknownView(extra) {
  return {
    enabled: true,
    observer: 'STOPPED',
    evidenceState: 'UNKNOWN',
    freshness: 'UNKNOWN',
    reportedState: null,
    rssi: null,
    freeHeap: null,
    profile: null,
    timeOk: null,
    lastReceivedAt: null,
    ageMs: null,
    rejected: emptyRejections(),
    provenance: LAB_MQTT_PROVENANCE,
    ...extra,
  }
}

/** View used when the feature is off or a Demo session is active; the UI renders nothing for it. */
export function labMqttDisabledView() {
  return { ...unknownView({ enabled: false, observer: 'DISABLED' }) }
}

function optionsFileProblem(optionsFile, statSync) {
  if (typeof optionsFile !== 'string' || !path.isAbsolute(optionsFile)) return 'path'
  try {
    const stat = statSync(optionsFile)
    if (!stat.isFile()) return 'type'
    if ((stat.mode & 0o077) !== 0) return 'permissions'
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return 'owner'
  } catch {
    return 'missing'
  }
  return null
}

export function createLabMqttObserver({
  optionsFile,
  maxAgeMs = 120_000,
  clock = () => new Date(),
  spawn = nodeSpawn,
  statSync = nodeStatSync,
  binary = 'mosquitto_sub',
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let child = null
  let running = false
  let stopped = true
  let misconfigured = false
  let restartTimer = null
  let backoff = RESTART_MIN_MS
  let last = null
  let rejected = emptyRejections()

  function accept(line) {
    const result = parseObserverLine(line)
    if (!result.ok) {
      rejected[result.reason] += 1
      return
    }
    last = { value: result.value, receivedAtMs: clock().getTime() }
    backoff = RESTART_MIN_MS
  }

  function attach(proc) {
    let buffer = ''
    let discarding = false
    proc.stdout.setEncoding?.('utf8')
    proc.stdout.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (discarding) discarding = false
        else accept(line)
      }
      if (buffer.length > MAX_LINE_BYTES) {
        buffer = ''
        discarding = true
        rejected.malformed += 1
      }
    })
    const onEnd = () => {
      if (child !== proc) return
      child = null
      running = false
      scheduleRestart()
    }
    proc.on('error', onEnd)
    proc.on('close', onEnd)
  }

  function scheduleRestart() {
    if (stopped || restartTimer) return
    restartTimer = setTimer(() => {
      restartTimer = null
      launch()
    }, backoff)
    restartTimer.unref?.()
    backoff = Math.min(backoff * 2, RESTART_MAX_MS)
  }

  function launch() {
    if (stopped || child) return
    if (optionsFileProblem(optionsFile, statSync)) {
      misconfigured = true
      return
    }
    misconfigured = false
    // Credentials come only from the owner-only options file. Subscribe-only: no publish binary or flag is used.
    const args = [
      '-o', optionsFile,
      '-h', LAB_MQTT_BROKER_HOST,
      '-p', String(LAB_MQTT_BROKER_PORT),
      '-t', LAB_MQTT_TOPIC,
      '-q', '0',
      '-k', '30',
      '-F', '%j',
    ]
    try {
      child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } })
    } catch {
      child = null
      scheduleRestart()
      return
    }
    running = true
    attach(child)
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      launch()
    },
    stop() {
      stopped = true
      if (restartTimer) clearTimer(restartTimer)
      restartTimer = null
      const proc = child
      child = null
      running = false
      proc?.kill?.('SIGTERM')
    },
    snapshot() {
      const base = { rejected: { ...rejected } }
      if (misconfigured) return unknownView({ ...base, observer: 'MISCONFIGURED' })
      if (!running || !last) return unknownView({ ...base, observer: running ? 'RUNNING' : 'STOPPED', lastReceivedAt: last ? new Date(last.receivedAtMs).toISOString() : null })
      const ageMs = Math.max(0, clock().getTime() - last.receivedAtMs)
      const lastReceivedAt = new Date(last.receivedAtMs).toISOString()
      if (ageMs > maxAgeMs) return unknownView({ ...base, observer: 'RUNNING', freshness: 'STALE', lastReceivedAt, ageMs })
      const { state, rssi, heap, profile, time_ok: timeOk } = last.value
      return unknownView({
        ...base,
        observer: 'RUNNING',
        evidenceState: 'OBSERVED',
        freshness: 'FRESH',
        reportedState: state,
        rssi,
        freeHeap: heap,
        profile,
        timeOk,
        lastReceivedAt,
        ageMs,
      })
    },
  }
}
