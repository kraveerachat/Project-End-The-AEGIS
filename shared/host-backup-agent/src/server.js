// src/server.js — AEGIS host backup agent · IPC surface
//
// One Unix socket, five routes, JSON in and out, no TCP anywhere. The socket
// is 0660 in a RuntimeDirectory owned by the agent's user, and Drive joins the
// agent's group to reach it — the same shape as the telemetry agent, with a
// DIFFERENT user, group and socket so a Drive that can read host metrics is
// not thereby able to trigger a backup, and vice versa.
//
// Every response is rebuilt from an allowlist. The status body carries IDs,
// enums, numbers and ISO timestamps. It never carries a path to a credential
// file, a repository password, a command line, or tool output.
import fspDefault from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'

import { SOCKET_MODE } from './config.js'
import { PROTECTION, isProtected } from './targets.js'
import { RETENTION_IDS, SCHEDULE_IDS, nextRunAfter } from './schedule.js'
import { PHASES } from './job.js'

export const STATUS_SCHEMA_VERSION = 1
export const ROUTES = Object.freeze({
  STATUS: '/internal/backup/status',
  RUN: '/internal/backup/run',
  VERIFY: '/internal/backup/verify',
  QUIESCED: '/internal/backup/quiesced',
  POLICY: '/internal/backup/policy',
})
export const MAX_BODY_BYTES = 4096
export const HISTORY_LIMIT = 50

/** Backup configuration states, as the contract names them. */
export const BACKUP_STATES = Object.freeze([
  'NOT_CONFIGURED', 'SAME_FAILURE_DOMAIN', 'TARGET_UNAVAILABLE', 'READY', 'RUNNING',
])

/** Derive the configuration state from policy + classification + runner state. */
export function deriveBackupState({ target, classification, running }) {
  if (running) return 'RUNNING'
  if (!target) return 'NOT_CONFIGURED'
  if (!classification) return 'TARGET_UNAVAILABLE'
  if (classification.protection === PROTECTION.SAME_FAILURE_DOMAIN) return 'SAME_FAILURE_DOMAIN'
  if (!isProtected(classification.protection)) return 'TARGET_UNAVAILABLE'
  return 'READY'
}

function defaultProbe(socketPath) {
  return new Promise((resolve) => {
    const socket = net.connect({ path: socketPath })
    const done = (answer) => { socket.destroy(); resolve(answer) }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(500, () => done(false))
  })
}

async function prepareSocketPath(socketPath, { fs, probe }) {
  let stats
  try {
    stats = await fs.stat(socketPath)
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  if (!stats.isSocket()) throw new Error(`refusing to start: ${socketPath} exists and is not a socket`)
  if (await probe(socketPath)) throw new Error(`refusing to start: ${socketPath} is already in use by a live agent`)
  await fs.unlink(socketPath)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    let bytes = 0
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { status: 413 }))
        req.destroy()
        return
      }
      body += chunk
    })
    req.on('end', () => {
      if (!body.trim()) return resolve({})
      try {
        const parsed = JSON.parse(body)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
        resolve(parsed)
      } catch {
        reject(Object.assign(new Error('malformed json'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.policyStore
 * @param {object} deps.history
 * @param {object} deps.runner
 * @param {(target: object) => Promise<object>} deps.classify
 * @param {() => number} [deps.now]
 * @param {{ resticPresent: boolean, pgDumpPresent: boolean }} [deps.tools]
 * @param {object} [deps.fs]
 * @param {Function} [deps.probe]
 * @param {Function} [deps.onPolicyChanged]
 */
export function createBackupServer({
  config, policyStore, history, runner, classify, now = Date.now,
  tools = { resticPresent: null, pgDumpPresent: null }, fs = fspDefault, probe = defaultProbe, onPolicyChanged,
}) {
  const send = (res, status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    })
    res.end(body)
  }

  async function buildStatus() {
    const policy = await policyStore.get()
    const { target, classification } = await runner.classifyActive(policy)
    const live = runner.status()
    const jobs = (await history.list()).slice(0, HISTORY_LIMIT)
    const lastBackup = jobs.find((j) => j.kind === 'backup' && j.status !== 'RUNNING')
    const lastSuccess = jobs.find((j) => j.kind === 'backup' && j.status === 'SUCCESS')
    const nextRun = policy.enabled && target
      ? nextRunAfter(policy.scheduleId, now(), { lastRunMs: lastSuccess ? Date.parse(lastSuccess.startedAt) : null })
      : null

    const targets = []
    for (const t of config.targets) {
      const c = t.id === target?.id ? classification : await classify(t)
      targets.push({ id: t.id, label: t.label, type: t.type, protection: c?.protection ?? PROTECTION.UNKNOWN })
    }

    return {
      schemaVersion: STATUS_SCHEMA_VERSION,
      measuredAt: new Date(now()).toISOString(),
      engine: 'restic',
      tools: { resticPresent: tools.resticPresent ?? null, pgDumpPresent: tools.pgDumpPresent ?? null },
      policy: { ...policy },
      allowed: { scheduleIds: [...SCHEDULE_IDS], retentionIds: [...RETENTION_IDS] },
      limits: { ...config.limits },
      targets,
      target: target
        ? { id: target.id, label: target.label, type: target.type, protection: classification?.protection ?? PROTECTION.UNKNOWN }
        : null,
      state: deriveBackupState({ target, classification, running: live.running }),
      job: live.job,
      nextRun: nextRun === null ? null : new Date(nextRun).toISOString(),
      lastBackupAt: lastBackup?.finishedAt ?? null,
      history: jobs,
    }
  }

  const server = http.createServer(async (req, res) => {
    const requestPath = (req.url ?? '').split('?')[0]
    try {
      if (requestPath === ROUTES.STATUS) {
        if (req.method !== 'GET') return send(res, 405, { error: 'method-not-allowed' })
        return send(res, 200, await buildStatus())
      }
      if (!Object.values(ROUTES).includes(requestPath)) return send(res, 404, { error: 'not-found' })
      if (req.method !== 'POST') return send(res, 405, { error: 'method-not-allowed' })

      const body = await readJsonBody(req)
      if (requestPath === ROUTES.RUN) {
        const result = await runner.requestBackup({ trigger: 'manual' })
        return send(res, result.ok ? 202 : 409, { ok: result.ok, jobId: result.jobId ?? result.job?.jobId ?? null, reason: result.reason ?? null })
      }
      if (requestPath === ROUTES.VERIFY) {
        const result = await runner.requestVerify({ trigger: 'manual' })
        return send(res, result.ok ? 202 : 409, { ok: result.ok, jobId: result.jobId ?? result.job?.jobId ?? null, reason: result.reason ?? null })
      }
      if (requestPath === ROUTES.QUIESCED) {
        if (typeof body.jobId !== 'string') return send(res, 400, { error: 'job-id-required' })
        const result = runner.acknowledgeQuiesce(body.jobId)
        return send(res, result.ok ? 200 : 409, result)
      }
      if (requestPath === ROUTES.POLICY) {
        let policy
        try {
          policy = await policyStore.set(body)
        } catch (err) {
          return send(res, 400, { error: 'invalid-policy', reason: err.message })
        }
        onPolicyChanged?.(policy)
        return send(res, 200, { ok: true, policy })
      }
      return send(res, 404, { error: 'not-found' })
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 500
      return send(res, status, { error: status === 500 ? 'internal' : err.message })
    }
  })
  server.on('clientError', (_err, socket) => { socket.destroy() })

  return {
    async start() {
      await prepareSocketPath(config.socketPath, { fs, probe })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.socketPath, () => { server.removeListener('error', reject); resolve() })
      })
      if (process.platform !== 'win32') await fs.chmod(config.socketPath, config.socketMode ?? SOCKET_MODE)
    },
    async stop() {
      if (server.listening) await new Promise((resolve) => server.close(resolve))
      if (process.platform !== 'win32') {
        await fs.unlink(config.socketPath).catch((err) => { if (err.code !== 'ENOENT') throw err })
      }
    },
    address: () => server.address(),
    buildStatus,
  }
}

export { PHASES }
