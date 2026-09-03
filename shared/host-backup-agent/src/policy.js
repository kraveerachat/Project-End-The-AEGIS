// src/policy.js — AEGIS host backup agent · the Admin-editable settings
//
// Four values, all IDs or booleans, persisted in the agent's own state
// directory. The static config decides what is allowed; this file records
// what was chosen.
import fspDefault from 'node:fs/promises'
import path from 'node:path'

import { DEFAULT_POLICY, validatePolicy } from './config.js'

export const POLICY_FILE_NAME = 'policy.json'

export function createPolicyStore({ stateDir, config, fs = fspDefault }) {
  const file = path.posix.join(stateDir, POLICY_FILE_NAME)
  let current = null

  async function load() {
    if (current) return current
    try {
      current = validatePolicy(JSON.parse(await fs.readFile(file, 'utf8')), config)
    } catch {
      // Missing, corrupt, or referencing a target that has since been removed
      // from the allowlist: fall back to "nothing selected" rather than keep a
      // policy pointing at something that no longer exists.
      current = { ...DEFAULT_POLICY }
    }
    return current
  }

  return {
    get: load,
    async set(raw) {
      const next = validatePolicy(raw, config)
      const tmp = `${file}.tmp-${process.pid}`
      await fs.writeFile(tmp, JSON.stringify(next), { encoding: 'utf8', mode: 0o640 })
      await fs.rename(tmp, file)
      current = next
      return next
    },
  }
}
