// collectors/twingate-health.js — AEGIS Twingate connector collector · the second privileged edge
//
// Why this is NOT inside src/: reaching the Docker daemon means talking to
// /var/run/docker.sock, and that socket is root-equivalent — anything that can
// reach it can start a privileged container and own the host. The telemetry
// agent must never hold it, and neither must Drive. So the same shape as the
// disk-health collector is used here: a short-lived systemd oneshot on a timer
// holds the group membership for a few hundred milliseconds, reduces what it
// learns to a tiny allowlisted evidence file, and exits. The unprivileged agent
// then READS that file and republishes it on /internal/twingate-connector.
//
// What this measures, precisely: whether the LOCAL container named below is
// running on this host and what Docker's own healthcheck says about it. That is
// all. It is NOT the Twingate control plane's opinion of the connector — the
// control plane is not consulted anywhere in this file, no Twingate API is
// called, and no Twingate credential is read. Drive states that distinction on
// screen rather than blurring the two into one "Online".
//
// Nothing here can be steered by a request: there is no socket, no argument
// parsing, and the Docker command and its format template are fixed constants
// in this file. The container name comes from the unit's Environment= and is
// pattern-checked before it is ever passed to Docker.
import { execFile as execFileCallback } from 'node:child_process'
import fspDefault from 'node:fs/promises'
import path from 'node:path'

import { TWINGATE_HEALTH_SCHEMA_VERSION, connectorFromDockerProjection } from './twingate.js'

export {
  TWINGATE_HEALTH_SCHEMA_VERSION, RUNTIME_STATE, CONNECTOR_HEALTH, TWINGATE_UNAVAILABLE_REASONS,
  runtimeStateFrom, connectorHealthFrom, normalizeStartedAt, normalizeRestartCount,
  connectorFromDockerProjection,
} from './twingate.js'

/** Where the evidence file is written; a StateDirectory owned by the collector. */
export const DEFAULT_OUTPUT_PATH = '/var/lib/aegis-twingate-health/twingate-health.json'

/** The one binary this collector may execute. Absolute on purpose: no PATH lookup. */
export const DEFAULT_DOCKER_PATH = '/usr/bin/docker'

/** The production connector container on the AEGIS host. */
export const DEFAULT_CONTAINER_NAME = 'twingate-aegis-connector-02'

/** A bounded run: `docker inspect` against a local daemon answers in well under a second. */
export const DOCKER_TIMEOUT_MS = 10_000

/** The projected document is a few hundred bytes; 256 KiB is pure headroom. */
export const MAX_DOCKER_OUTPUT_BYTES = 256 * 1024

/**
 * The Go template Docker renders instead of a full container document.
 *
 * This is the single most important line in the file. `docker inspect` without
 * a format returns EVERYTHING about the container — `Config.Env` (which holds
 * TWINGATE_ACCESS_TOKEN and TWINGATE_REFRESH_TOKEN), `Mounts`, `NetworkSettings`
 * with addresses and MAC, labels, and `State.Health.Log` with the raw stdout of
 * the last five healthcheck runs. None of that may exist in this process, let
 * alone reach the evidence file, so it is never requested: Docker itself does
 * the projection and hands back six scalars.
 *
 * `{{if .State.Health}}` is required, not defensive styling — `.State.Health`
 * is a nil pointer on a container with no HEALTHCHECK, and dereferencing it
 * would make Docker exit non-zero and turn "this connector has no healthcheck"
 * into "inspect failed".
 */
export const DOCKER_FORMAT = [
  '{',
  '"status":{{json .State.Status}},',
  '"running":{{json .State.Running}},',
  '"restarting":{{json .State.Restarting}},',
  '"startedAt":{{json .State.StartedAt}},',
  '"restartCount":{{json .RestartCount}},',
  '"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}',
  '}',
].join('')

/**
 * Fixed argument list. `inspect` is read-only; `--type container` stops a name
 * collision from resolving to an image. Nothing here starts, stops, restarts,
 * executes into, or reconfigures anything.
 */
export const DOCKER_ARGS = Object.freeze(['inspect', '--type', 'container', '--format', DOCKER_FORMAT])

/** Docker container names: an initial alphanumeric, then a limited alphabet. */
const CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/

/**
 * Validate an operator-supplied container name.
 *
 * The name is the ONLY part of the Docker command that is not a constant in
 * this file, so it is pattern-checked before it can become an argument. A name
 * that does not match refuses the run rather than inspecting something else.
 *
 * @param {unknown} value
 * @returns {string | null} the name, or null when unusable
 */
export function resolveContainerName(value) {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (!CONTAINER_NAME_PATTERN.test(name)) return null
  return name
}

/**
 * Resolve the collector configuration from the environment; unusable values
 * refuse to run rather than inspect the wrong container.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadCollectorConfig(env = process.env) {
  const container = resolveContainerName(env.AEGIS_TWINGATE_CONTAINER ?? DEFAULT_CONTAINER_NAME)
  if (!container) throw new Error('AEGIS_TWINGATE_CONTAINER must be a Docker container name')

  const dockerPath = String(env.AEGIS_TWINGATE_DOCKER ?? DEFAULT_DOCKER_PATH).trim()
  if (!path.posix.isAbsolute(dockerPath)) throw new Error('AEGIS_TWINGATE_DOCKER must be an absolute path')

  const outputPath = String(env.AEGIS_TWINGATE_OUTPUT ?? DEFAULT_OUTPUT_PATH).trim()
  if (!path.posix.isAbsolute(outputPath)) throw new Error('AEGIS_TWINGATE_OUTPUT must be an absolute path')

  return { container, dockerPath, outputPath }
}

/**
 * Default executor: resolves with stdout, the exit status, and whether stderr
 * said the object does not exist.
 *
 * stderr is reduced to ONE BOOLEAN here and discarded. Docker's error text
 * names the daemon socket and echoes the object it looked for; none of that may
 * survive into a document Drive renders.
 */
function defaultExecFile(file, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFileCallback(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_DOCKER_OUTPUT_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && typeof error.code === 'string') return reject(error) // ENOENT, EACCES, ...
        if (error && error.killed) return reject(Object.assign(new Error('docker inspect timed out'), { code: 'ETIMEDOUT' }))
        const exitStatus = error && Number.isInteger(error.code) ? error.code : 0
        resolve({
          stdout: String(stdout ?? ''),
          exitStatus,
          notFound: /no such (object|container)/i.test(String(stderr ?? '')),
        })
      },
    )
  })
}

/**
 * Inspect the connector once and reduce the result to evidence.
 *
 * Never throws for a Docker-side or container-side problem: those become
 * `{ available: false, reason }` so the evidence file always states WHY there is
 * no reading. Only a configuration error escapes.
 *
 * @param {object} config from loadCollectorConfig()
 * @param {{ execFile?: Function, now?: () => number }} [deps]
 */
export async function collectTwingateHealth(config, { execFile = defaultExecFile, now = Date.now } = {}) {
  const measuredAt = new Date(now()).toISOString()
  const envelope = (connector) => ({
    schemaVersion: TWINGATE_HEALTH_SCHEMA_VERSION,
    measuredAt,
    connector,
  })

  let run
  try {
    run = await execFile(config.dockerPath, [...DOCKER_ARGS, config.container], { timeoutMs: DOCKER_TIMEOUT_MS })
  } catch (err) {
    // A missing or unusable Docker CLI and a daemon this unit cannot reach are
    // the same fact for an operator: Docker is not answering here.
    if (err?.code === 'ENOENT' || err?.code === 'EACCES' || err?.code === 'EPERM') {
      return envelope({ available: false, reason: 'docker-unavailable' })
    }
    return envelope({ available: false, reason: 'inspect-failed' })
  }

  if (run.exitStatus !== 0) {
    return envelope({ available: false, reason: run.notFound ? 'connector-not-found' : 'inspect-failed' })
  }
  if (Buffer.byteLength(run.stdout) > MAX_DOCKER_OUTPUT_BYTES) {
    return envelope({ available: false, reason: 'inspect-failed' })
  }

  let parsed
  try {
    parsed = JSON.parse(run.stdout)
  } catch {
    return envelope({ available: false, reason: 'inspect-failed' })
  }

  return envelope(connectorFromDockerProjection(parsed))
}

/**
 * Write the evidence atomically: a reader (the agent, on its own cycle) must
 * see either the previous complete file or the new complete file, never a
 * half-written one.
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
