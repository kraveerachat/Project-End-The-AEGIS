export const VAULT_EXPERIENCE = Object.freeze({
  SETUP: 'SETUP',
  LOCKED: 'LOCKED',
  LOADING: 'LOADING',
  UNAVAILABLE: 'UNAVAILABLE',
  AUTO_EMPTY_GENESIS: 'AUTO_EMPTY_GENESIS',
  EXPLICIT_MIGRATION: 'EXPLICIT_MIGRATION',
  RESUME_MIGRATION: 'RESUME_MIGRATION',
  TREE: 'TREE',
})

const TREE_FEATURE_CHAIN = Object.freeze([
  'schemaAvailable',
  'protocolEnabled',
  'genesisMigrationEnabled',
  'treeUiEnabled',
])

export function decideVaultExperience({
  configured,
  unlocked,
  inventoryReady,
  blobCount,
  protocolState,
  flags,
} = {}) {
  if (configured === false) return { kind: VAULT_EXPERIENCE.SETUP }
  if (configured !== true) return { kind: VAULT_EXPERIENCE.LOADING }
  if (unlocked === false) return { kind: VAULT_EXPERIENCE.LOCKED }
  if (unlocked !== true) return { kind: VAULT_EXPERIENCE.LOADING }

  if (!TREE_FEATURE_CHAIN.every((flag) => flags?.[flag] === true)) {
    return { kind: VAULT_EXPERIENCE.UNAVAILABLE }
  }

  if (inventoryReady !== true) return { kind: VAULT_EXPERIENCE.LOADING }

  if (protocolState === 'FLAT') {
    if (blobCount === 0) return { kind: VAULT_EXPERIENCE.AUTO_EMPTY_GENESIS }
    return { kind: VAULT_EXPERIENCE.EXPLICIT_MIGRATION, requiresHumanAction: true }
  }
  if (protocolState === 'MIGRATING_TREE_V1') return { kind: VAULT_EXPERIENCE.RESUME_MIGRATION }
  if (protocolState === 'TREE_V1') return { kind: VAULT_EXPERIENCE.TREE }
  return { kind: VAULT_EXPERIENCE.UNAVAILABLE }
}
