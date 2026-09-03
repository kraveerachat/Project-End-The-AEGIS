// src/exec.js — AEGIS host backup agent · the only process-spawning edge
//
// execFile with an argument ARRAY, never a shell string: nothing an Admin can
// set through Drive ever reaches this function (IDs are resolved to config
// values before any call), and even the config values are passed as discrete
// arguments that no shell interprets.
//
// Secrets never appear in argv. restic reads its repository password from
// RESTIC_PASSWORD_FILE and pg_dump reads the database password from PGPASSFILE;
// both are file paths, and the files are not readable by anyone but root and
// the agent's own user.
import { execFile as execFileCallback } from 'node:child_process'

export const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024

/**
 * @param {string} file absolute path of a binary named in the static config
 * @param {string[]} args
 * @param {{ env?: object, timeoutMs?: number, maxBuffer?: number, cwd?: string }} [options]
 * @returns {Promise<{ stdout: string, stderr: string, exitStatus: number }>}
 *   resolves on any exit status; rejects only when the process could not run
 */
export function runFixed(file, args, { env = {}, timeoutMs = 0, maxBuffer = DEFAULT_MAX_BUFFER, cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFileCallback(
      file,
      args,
      {
        // A minimal environment: PATH for restic's own helpers (ssh for sftp),
        // plus exactly what the caller passes. Nothing from the agent's own
        // environment leaks into the child.
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', ...env },
        timeout: timeoutMs,
        maxBuffer,
        cwd,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code === 'string') return reject(error) // ENOENT, EACCES, ...
        if (error && error.killed) return reject(Object.assign(new Error('process timed out'), { code: 'ETIMEDOUT' }))
        const exitStatus = error && Number.isInteger(error.code) ? error.code : 0
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitStatus })
      },
    )
  })
}
