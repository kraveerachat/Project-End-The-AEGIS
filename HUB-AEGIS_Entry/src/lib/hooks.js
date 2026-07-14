import { useEffect, useState } from 'react'

/** Reactive media query — the vault split flips direction on `md`. */
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setMatches(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/** True when the OS asks for reduced motion. Every animation must honor it. */
export function useReducedMotion() {
  return useMediaQuery('(prefers-reduced-motion: reduce)')
}
