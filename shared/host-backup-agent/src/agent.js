// src/agent.js — AEGIS host backup agent · assembly
//
// Construction is side-effect free: nothing binds, nothing is scheduled, no
// binary is probed until start() is called, so the wiring can be asserted in
// a test without a socket, a repository, or a database.
import fspDefault from 'node:fs/promises'
import path from 'node:path'

import { loadStaticConfig } from './config.js'
import { createHistoryStore } from './history.js'
import { createJobRunner } from './job.js'
import { createPolicyStore } from './policy.js'
import { createRestic } from './restic.js'
import { nextRunAfter } from './schedule.js'
import { createBackupServer } from './server.js'
import { classifyTarget, defaultTargetDeps } from './targets.js'

/** How often the scheduler re-evaluates "is it time yet". */
export const SCHEDULER_TICK_MS = 60 * 1000

/**
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {object} [options.config] a pre-validated config (tests); otherwise loaded from disk
 * @param {object} [options.fs]
 * @param {object} [options.targetDeps] readMountInfo/sys for classification
 * @param {Function} [options.exec]
 * @param {() => number} [options.now]
 * @param {Function} [options.setTimer]
 * @param {Function} [options.clearTimer]
 */
export async function createAgent({
  env = process.env, config: presetConfig, fs = fspDefault, targetDeps, exec, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  const config = presetConfig ?? await loadStaticConfig({ env, readFile: fs.readFile })
  const deps = targetDeps ?? await defaultTargetDeps()

  const classify = (target) => classifyTarget(target, { datalakePath: config.source.datalakePath, ...deps })
  const policyStore = createPolicyStore({ stateDir: config.stateDir, config, fs })
  const history = createHistoryStore({ stateDir: config.stateDir, fs })
  const resticFor = (target) => createRestic({
    binary: config.restic.binary,
    passwordFile: config.restic.passwordFile,
    repository: target.repository,
    cacheDir: path.posix.join(config.stateDir, 'cache'),
    ...(exec ? { exec } : {}),
  })
  const runner = createJobRunner({ config, policyStore, history, resticFor, classify, now, fs, setTimer, clearTimer })

  const tools = { resticPresent: null, pgDumpPresent: null }
  const server = createBackupServer({
    config, policyStore, history, runner, classify, now, tools, fs,
    onPolicyChanged: () => { scheduledFor = null },
  })

  let schedulerHandle = null
  let scheduledFor = null

  async function schedulerTick() {
    const policy = await policyStore.get()
    if (!policy.enabled || !policy.activeTargetId) { scheduledFor = null; return }
    if (scheduledFor === null) {
      const jobs = await history.list()
      const lastSuccess = jobs.find((j) => j.kind === 'backup' && j.status === 'SUCCESS')
      scheduledFor = nextRunAfter(policy.scheduleId, now(), { lastRunMs: lastSuccess ? Date.parse(lastSuccess.startedAt) : null })
    }
    if (scheduledFor !== null && now() >= scheduledFor) {
      scheduledFor = null
      await runner.requestBackup({ trigger: 'schedule' })
    }
  }

  async function probeTools() {
    const present = async (file) => {
      try { await fs.access(file); return true } catch { return false }
    }
    tools.resticPresent = await present(config.restic.binary)
    tools.pgDumpPresent = (await present(config.tools.pgDump)) && (await present(config.tools.pgRestore))
  }

  return {
    config,
    policyStore,
    history,
    runner,
    server,
    schedulerTick,
    async start() {
      await fs.mkdir(config.stateDir, { recursive: true, mode: 0o750 })
      await probeTools()
      await server.start()
      schedulerHandle = setTimer(() => { schedulerTick().catch((err) => console.error('[aegis-backup] scheduler tick failed:', err.message)) }, SCHEDULER_TICK_MS)
      if (typeof schedulerHandle?.unref === 'function') schedulerHandle.unref()
    },
    async stop() {
      if (schedulerHandle !== null) { clearTimer(schedulerHandle); schedulerHandle = null }
      await server.stop()
    },
  }
}
