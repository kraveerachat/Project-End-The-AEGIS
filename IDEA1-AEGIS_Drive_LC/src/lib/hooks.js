import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from './api.js'

/**
 * useApi — หนึ่ง hook ขับเคลื่อน "สี่สถานะ" ของทุกจอ:
 *   loading → skeleton · error → ข้อความ + ปุ่ม Retry · data ว่าง → empty state · data → success
 *
 * - ยกเลิก request อัตโนมัติเมื่อ component unmount (AbortController)
 * - refreshMs > 0: poll เงียบ ๆ — ถ้ารีเฟรชล้มเหลว "คงข้อมูลเดิมไว้" ไม่เด้ง error ทับจอ
 *   (จอที่มีข้อมูลอยู่แล้วห้ามกระพริบเป็น error เพราะ network สะดุดหนึ่งจังหวะ)
 * - retry(): ลองใหม่ด้วยมือ — ปุ่ม Retry ของ ErrorState เรียกอันนี้
 *
 * @param {string|null} path  null = ยังไม่พร้อมยิง (จอจะอยู่สถานะ loading)
 * @param {{ refreshMs?: number }} opts
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

/**
 * Counts from the previous value to `target` over `dur` ms, ease-out.
 * Numbers always count, never snap — except under prefers-reduced-motion,
 * where they jump straight to the final value.
 */
export function useCountUp(target, dur = 700, decimals = 0) {
  const reduced = useReducedMotion()
  const [value, setValue] = useState(target)
  const fromRef = useRef(target)
  const rafRef = useRef(0)

  useEffect(() => {
    if (reduced) {
      fromRef.current = target
      setValue(target)
      return
    }
    const from = fromRef.current
    if (from === target) return
    const t0 = performance.now()
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur)
      const eased = 1 - Math.pow(1 - p, 3) // ease-out cubic
      setValue(from + (target - from) * eased)
      if (p < 1) rafRef.current = requestAnimationFrame(tick)
      else fromRef.current = target
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [target, dur, reduced])

  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/** Re-renders every `ms` — for live countdowns and relative timestamps. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}
