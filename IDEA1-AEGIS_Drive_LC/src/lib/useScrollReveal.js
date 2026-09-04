import { useEffect } from 'react'

/* Scroll reveal for the Neo interface.
 *
 * The rule this is built around: **a reveal must enhance an already-visible
 * default, never gate content behind a transition that might not run.** A
 * class-driven fade that never fires ships a blank page — transitions are
 * throttled in background tabs, IntersectionObserver may be absent, and a
 * headless renderer or a failed chunk means no JS at all.
 *
 * So the from-state lives entirely under `:root[data-neo-reveal="on"]`, and
 * this hook is the only thing that sets that attribute. It sets it only after
 * confirming, in this order:
 *
 *   1. the Neo interface is active (Classic keeps its accepted baseline),
 *   2. the user has not asked for reduced motion,
 *   3. IntersectionObserver actually exists.
 *
 * If any check fails the attribute is never written and every section renders
 * plainly visible. And even when it is armed, a timeout force-reveals whatever
 * the observer has not reported on, so a wedged observer degrades to "already
 * shown" rather than "permanently hidden".
 *
 * @param {{ current: HTMLElement|null }} rootRef scroll container to search
 * @param {unknown} key                          re-run when the screen changes
 * @param {boolean} enabled                      Neo is the active interface
 */
export function useScrollReveal(rootRef, key, enabled) {
  useEffect(() => {
    const root = rootRef?.current
    if (!enabled || !root) return undefined
    if (typeof window === 'undefined' || typeof window.IntersectionObserver !== 'function') return undefined
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return undefined
    }

    const targets = [...root.querySelectorAll('[data-reveal]')]
    if (targets.length === 0) return undefined

    const doc = root.ownerDocument ?? document
    doc.documentElement.dataset.neoReveal = 'on'

    const reveal = (el) => { el.dataset.revealed = 'true' }

    const observer = new window.IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        reveal(entry.target)
        observer.unobserve(entry.target)
      }
      // The margin EXPANDS the root downward, so a section is revealed just
      // before it scrolls into view. On a dense status screen an operator should
      // never arrive at a card that is still fading in.
    }, { root, rootMargin: '0px 0px 12% 0px', threshold: 0.01 })

    for (const el of targets) observer.observe(el)

    // Failsafe: whatever has not been reported on by now is shown regardless.
    const failsafe = setTimeout(() => targets.forEach(reveal), 1200)

    return () => {
      clearTimeout(failsafe)
      observer.disconnect()
      // Leaving the attribute set would hide the next screen's sections until
      // its own observer caught up, so the from-state is disarmed on teardown.
      delete doc.documentElement.dataset.neoReveal
      for (const el of targets) delete el.dataset.revealed
    }
  }, [rootRef, key, enabled])
}
