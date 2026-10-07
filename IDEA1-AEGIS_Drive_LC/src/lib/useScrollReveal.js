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

    const doc = root.ownerDocument ?? document
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

    // A screen's sections are not always in the DOM when the screen key
    // changes: the transition skeleton replaces the first render and the real
    // sections mount again as NEW nodes ~400ms later. Watching only the first
    // query stranded those later nodes under the armed from-state, so every
    // [data-reveal] node that appears while this screen is active is tracked.
    const targets = []
    const failsafes = []
    const watchNew = () => {
      let added = false
      for (const el of root.querySelectorAll('[data-reveal]')) {
        if (targets.includes(el)) continue
        targets.push(el)
        observer.observe(el)
        added = true
      }
      if (!added) return
      doc.documentElement.dataset.neoReveal = 'on'
      // Failsafe: whatever has not been reported on by now is shown regardless.
      failsafes.push(setTimeout(() => targets.forEach(reveal), 1200))
    }

    watchNew()
    let frame = 0
    const mutations = typeof window.MutationObserver === 'function'
      ? new window.MutationObserver(() => {
        if (frame) return
        frame = window.requestAnimationFrame(() => { frame = 0; watchNew() })
      })
      : null
    mutations?.observe(root, { childList: true, subtree: true })

    return () => {
      failsafes.forEach(clearTimeout)
      if (frame) window.cancelAnimationFrame(frame)
      mutations?.disconnect()
      observer.disconnect()
      // Leaving the attribute set would hide the next screen's sections until
      // its own observer caught up, so the from-state is disarmed on teardown.
      delete doc.documentElement.dataset.neoReveal
      for (const el of targets) delete el.dataset.revealed
    }
  }, [rootRef, key, enabled])
}
