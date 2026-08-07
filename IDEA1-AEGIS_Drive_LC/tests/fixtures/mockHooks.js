import { useCallback } from 'react'

export function useApi(path) {
  const state = globalThis.__AEGIS_API_FIXTURES__?.[path] ?? {
    loading: false,
    data: null,
    error: null,
  }
  const retry = useCallback(() => {}, [])
  return { ...state, retry }
}

export function useNow() {
  return Date.UTC(2026, 7, 7, 9, 0, 0)
}

export function useReducedMotion() {
  return true
}

export function useCountUp(target) {
  return target
}
