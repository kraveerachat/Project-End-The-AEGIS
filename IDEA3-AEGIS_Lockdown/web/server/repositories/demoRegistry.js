import { createMemoryRepository } from './memoryRepository.js'

/**
 * Session-scoped, memory-only repositories for Demo Mode.
 *
 * A presenter's acknowledgements, notes, dry-runs and policy edits made while Demo Mode is active are
 * simulated. They must never reach the durable Live repository, so each Admin session gets its own
 * throw-away in-memory repository that is discarded on deactivation, re-activation, logout and eviction.
 * The registry is bounded so abandoned sessions cannot grow memory without limit.
 */
export const DEMO_REGISTRY_LIMIT = 32

export function createDemoRegistry({ clock = () => new Date(), limit = DEMO_REGISTRY_LIMIT } = {}) {
  const repositories = new Map()

  function drop(sessionId) {
    const repository = repositories.get(sessionId)
    if (!repository) return
    repository.close()
    repositories.delete(sessionId)
  }

  return {
    forSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('Demo repository requires a session id')
      const existing = repositories.get(sessionId)
      if (existing) {
        // Refresh recency so the least recently used session is the one evicted.
        repositories.delete(sessionId)
        repositories.set(sessionId, existing)
        return existing
      }
      while (repositories.size >= limit) drop(repositories.keys().next().value)
      const created = createMemoryRepository({ clock })
      repositories.set(sessionId, created)
      return created
    },
    reset(sessionId) {
      drop(sessionId)
    },
    size() {
      return repositories.size
    },
  }
}
