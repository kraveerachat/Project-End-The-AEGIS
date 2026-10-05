// tests/fixtures/legacyGridConvergenceStub.js — test-only replacement for src/lib/vaultConvergence.js
//
// Every unlocked experience in production now returns before the legacy FLAT tile grid in Vault.jsx
// (TREE, migration, loading or unavailable). The legacy grid's V2 download path still ships, so this
// stub lets a screen test reach it: once unlocked, it reports an experience kind the screen does not
// branch on, which falls through to the legacy grid. Locked/setup decisions stay the real ones.
import { decideVaultExperience as realDecide, VAULT_EXPERIENCE } from '../../src/lib/vaultConvergence.js'

export { VAULT_EXPERIENCE }

export function decideVaultExperience(input = {}) {
  if (input.configured === true && input.unlocked === true) return { kind: 'LEGACY_GRID_TEST' }
  return realDecide(input)
}
