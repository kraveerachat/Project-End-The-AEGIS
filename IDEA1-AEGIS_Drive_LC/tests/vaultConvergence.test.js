import test from 'node:test'
import assert from 'node:assert/strict'

import { decideVaultExperience, VAULT_EXPERIENCE } from '../src/lib/vaultConvergence.js'

const allTreeFlags = Object.freeze({
  schemaAvailable: true,
  protocolEnabled: true,
  genesisMigrationEnabled: true,
  treeUiEnabled: true,
})

const ready = Object.freeze({
  configured: true,
  unlocked: true,
  inventoryReady: true,
  blobCount: 0,
  flags: allTreeFlags,
})

test('unconfigured Vault selects setup', () => {
  assert.deepEqual(decideVaultExperience({ configured: false }), { kind: VAULT_EXPERIENCE.SETUP })
})

test('configured locked Vault selects the locked surface', () => {
  assert.deepEqual(decideVaultExperience({ configured: true, unlocked: false }), { kind: VAULT_EXPERIENCE.LOCKED })
})

test('empty unlocked FLAT Vault selects automatic zero-item genesis', () => {
  assert.deepEqual(decideVaultExperience({ ...ready, protocolState: 'FLAT' }), { kind: VAULT_EXPERIENCE.AUTO_EMPTY_GENESIS })
})

test('nonempty unlocked FLAT Vault requires explicit Human migration', () => {
  assert.deepEqual(decideVaultExperience({ ...ready, blobCount: 2, protocolState: 'FLAT' }), {
    kind: VAULT_EXPERIENCE.EXPLICIT_MIGRATION,
    requiresHumanAction: true,
  })
})

test('MIGRATING_TREE_V1 selects migration recovery', () => {
  assert.deepEqual(decideVaultExperience({ ...ready, protocolState: 'MIGRATING_TREE_V1' }), { kind: VAULT_EXPERIENCE.RESUME_MIGRATION })
})

test('TREE_V1 selects the single tree screen', () => {
  assert.deepEqual(decideVaultExperience({ ...ready, protocolState: 'TREE_V1' }), { kind: VAULT_EXPERIENCE.TREE })
})

test('inventory must be ready before an unlocked FLAT Vault can be classified as empty', () => {
  assert.deepEqual(decideVaultExperience({ ...ready, inventoryReady: false, protocolState: 'FLAT' }), { kind: VAULT_EXPERIENCE.LOADING })
  assert.deepEqual(decideVaultExperience({ ...ready, inventoryReady: undefined, protocolState: 'FLAT' }), { kind: VAULT_EXPERIENCE.LOADING })
})

test('the complete tree feature chain must be available', () => {
  for (const flag of Object.keys(allTreeFlags)) {
    assert.deepEqual(decideVaultExperience({
      ...ready,
      protocolState: 'TREE_V1',
      flags: { ...allTreeFlags, [flag]: false },
    }), { kind: VAULT_EXPERIENCE.UNAVAILABLE }, flag)
  }
})

test('role cannot change the operational Vault experience', () => {
  const input = { ...ready, blobCount: 2, protocolState: 'FLAT' }
  const expected = decideVaultExperience(input)
  assert.deepEqual(decideVaultExperience({ ...input, role: 'Admin' }), expected)
  assert.deepEqual(decideVaultExperience({ ...input, role: 'DataLake-User' }), expected)
})

test('nonempty FLAT Vault never selects an automatic state', () => {
  const result = decideVaultExperience({ ...ready, blobCount: 1, protocolState: 'FLAT' })
  assert.notEqual(result.kind, VAULT_EXPERIENCE.AUTO_EMPTY_GENESIS)
  assert.equal(result.requiresHumanAction, true)
})
