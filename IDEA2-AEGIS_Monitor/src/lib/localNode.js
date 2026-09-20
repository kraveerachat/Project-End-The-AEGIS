import { apiFetch } from './api.js'

const AGENT_URL = 'http://127.0.0.1:8078/v1/browser-association/assert'
const ATTEMPT_TIMEOUT_MS = 10_000
const RETRY_MS = 5_000
const MAX_AGENT_RESPONSE_BYTES = 16 * 1024

async function readAgentAssertion(response) {
  const contentLength = response.headers?.get?.('content-length')
  if (contentLength !== null && contentLength !== undefined) {
    const normalized = contentLength.trim()
    if (!/^(0|[1-9][0-9]*)$/.test(normalized)) throw new Error('Agent response length is invalid')
    const declaredBytes = Number(normalized)
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > MAX_AGENT_RESPONSE_BYTES) {
      throw new Error('Agent response exceeds the public assertion limit')
    }
  }

  const reader = response.body?.getReader?.()
  if (reader) {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let totalBytes = 0
    let text = ''
    let completed = false
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!(value instanceof Uint8Array)) throw new Error('Agent response chunk is invalid')
        totalBytes += value.byteLength
        if (totalBytes > MAX_AGENT_RESPONSE_BYTES) {
          throw new Error('Agent response exceeds the public assertion limit')
        }
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
      const parsed = JSON.parse(text)
      completed = true
      return parsed
    } finally {
      if (!completed) {
        try { await reader.cancel() } catch { /* best-effort response cleanup */ }
      }
    }
  }

  if (typeof response.text !== 'function') return response.json()
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > MAX_AGENT_RESPONSE_BYTES) {
    throw new Error('Agent response exceeds the public assertion limit')
  }
  return JSON.parse(text)
}

export function maintainLocalNodeAssociation({
  session,
  apiFetch: monitorFetch = apiFetch,
  loopbackFetch = globalThis.fetch,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  autoStart = true,
} = {}) {
  let stopped = false
  let scheduledTimer = null
  let activeController = null
  let inFlight = null

  const eligible = session?.role === 'CCTV-Operator'

  function clearScheduled() {
    if (scheduledTimer !== null) clearTimeoutFn(scheduledTimer)
    scheduledTimer = null
  }

  function schedule(delayMs) {
    if (stopped || !eligible) return
    clearScheduled()
    scheduledTimer = setTimeoutFn(() => {
      scheduledTimer = null
      void associateNow()
    }, Math.max(0, delayMs))
  }

  async function runAttempt() {
    if (stopped || !eligible) return 'ineligible'
    clearScheduled()
    const controller = new AbortController()
    activeController = controller
    const deadline = setTimeoutFn(() => controller.abort('local-node-association-timeout'), ATTEMPT_TIMEOUT_MS)
    try {
      const challenge = await monitorFetch('/api/local-node/challenge', {
        method: 'POST',
        body: {},
        signal: controller.signal,
      })
      if (!challenge?.ok || !challenge.data) throw new Error('challenge unavailable')

      const agentResponse = await loopbackFetch(AGENT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(challenge.data),
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      })
      if (!agentResponse?.ok) throw new Error('Agent unavailable')
      const assertion = await readAgentAssertion(agentResponse)

      const verified = await monitorFetch('/api/local-node/verify', {
        method: 'POST',
        body: assertion,
        signal: controller.signal,
        suppressAuthHandler: true,
      })
      const expiresAt = Number(verified?.data?.expiresAt)
      const renewAfterMs = Number(verified?.data?.renewAfterMs)
      if (
        !verified?.ok
        || !Number.isSafeInteger(expiresAt) || expiresAt <= 0
        || !Number.isSafeInteger(renewAfterMs) || renewAfterMs < 0
        || renewAfterMs > 5 * 60 * 1000
      ) {
        throw new Error('association rejected')
      }
      schedule(renewAfterMs)
      return 'associated'
    } catch {
      if (!stopped) schedule(RETRY_MS)
      return stopped ? 'ineligible' : 'retry'
    } finally {
      clearTimeoutFn(deadline)
      if (activeController === controller) activeController = null
    }
  }

  function associateNow() {
    if (inFlight) return inFlight
    inFlight = runAttempt().finally(() => { inFlight = null })
    return inFlight
  }

  function stop() {
    stopped = true
    clearScheduled()
    activeController?.abort('local-node-association-stopped')
    activeController = null
  }

  if (autoStart && eligible) queueMicrotask(() => { if (!stopped) void associateNow() })
  return Object.freeze({ stop, associateNow })
}
