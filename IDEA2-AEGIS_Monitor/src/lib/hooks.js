// src/lib/hooks.js — AEGIS Monitor (IDEA2)
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from './api.js'

/**
 * useApi — hook เดียวขับเคลื่อน "สี่สถานะ" ของทุกวิว:
 * loading → skeleton/hatch · error → ข้อความ + Retry · ว่าง → empty state · data → success
 * - ยกเลิก request เมื่อ unmount (AbortController)
 * - refreshMs: poll เงียบ ๆ; รีเฟรชล้มเหลว "คงข้อมูลเดิม" — จอที่มีข้อมูลไม่กระพริบเป็น error
 * @param {string|null} path
 */
export function useApi(path, { refreshMs = 0 } = {}) {
  const [state, setState] = useState({ loading: true, data: null, error: null })
  const [nonce, setNonce] = useState(0)
  const hasDataRef = useRef(false)

  useEffect(() => {
    if (!path) return
    const ctrl = new AbortController()
    let timer = 0

    const load = async (isRefresh) => {
      if (!isRefresh) {
        hasDataRef.current = false
        setState({ loading: true, data: null, error: null })
      }
      const res = await apiFetch(path, { signal: ctrl.signal })
      if (ctrl.signal.aborted) return
      if (res.ok) {
        hasDataRef.current = true
        setState({ loading: false, data: res.data, error: null })
      } else if (!isRefresh || !hasDataRef.current) {
        setState({ loading: false, data: null, error: res.errorKind ?? 'server' })
      }
      if (refreshMs > 0) timer = setTimeout(() => load(true), refreshMs)
    }

    load(false)
    return () => {
      ctrl.abort()
      clearTimeout(timer)
    }
  }, [path, nonce, refreshMs])

  const retry = useCallback(() => setNonce((n) => n + 1), [])
  return { ...state, retry }
}

/** True when the OS asks for reduced motion. Every animation must honor it. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}
