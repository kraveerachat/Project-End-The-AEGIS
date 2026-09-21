// Folder-level browser history for Files and Private Vault.
// Private Vault callers pass opaque node ids only. The visible URL is preserved,
// so decrypted names never enter paths, query strings, hashes, or document titles.

const STATE_KEY = '__aegisFolderNavigation'
const VERSION = 1

export function folderHistoryState(scope, nodeId, previousState = null) {
  const base = previousState && typeof previousState === 'object' ? previousState : {}
  return {
    ...base,
    [STATE_KEY]: {
      version: VERSION,
      scope: String(scope),
      nodeId: nodeId === null || nodeId === undefined ? null : String(nodeId),
    },
  }
}

export function readFolderHistory(state, scope) {
  const entry = state?.[STATE_KEY]
  if (!entry || entry.version !== VERSION || entry.scope !== String(scope)) return null
  if (entry.nodeId !== null && typeof entry.nodeId !== 'string') return null
  return { nodeId: entry.nodeId }
}

export function currentLocationUrl(location) {
  return `${location?.pathname ?? ''}${location?.search ?? ''}${location?.hash ?? ''}`
}

export function writeFolderHistory({ history, location, scope, nodeId, replace = false }) {
  if (!history) return
  const method = replace ? 'replaceState' : 'pushState'
  history[method](folderHistoryState(scope, nodeId, history.state), '', currentLocationUrl(location))
}

export function resolveFolderHistoryTarget(nodeId, validIds, rootId) {
  if (nodeId !== null && nodeId !== undefined && validIds?.has?.(String(nodeId))) return String(nodeId)
  return rootId
}
