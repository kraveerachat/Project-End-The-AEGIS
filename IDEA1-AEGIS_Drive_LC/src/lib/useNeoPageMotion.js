import { useEffect } from 'react'

const PANEL_SELECTOR = '.ui-card'
const MAX_ENTRANCE_PANELS = 10

/**
 * Neo motion for every screen except Dashboard (which owns useDashboardMotion).
 *
 * - Pointer edge light: one delegated, passive pointermove on <main>, throttled
 *   to one write per animation frame. It only sets two CSS custom properties on
 *   the hovered panel; no React state changes per pointer move.
 * - Entrance: once the screen has rendered, the top-level panels that are in
 *   view rise into place. Content is visible by default; GSAP sets the
 *   from-state and clears it on completion, so a failed tween never hides data.
 *
 * Both collapse under prefers-reduced-motion. No value is synthesized here.
 */
export function useNeoPageMotion(mainRef, screen, ready, enabled, reducedMotion) {
  useEffect(() => {
    const main = mainRef.current
    if (!enabled || !main || reducedMotion) return undefined
    if (window.matchMedia?.('(hover: hover) and (pointer: fine)').matches !== true) return undefined

    let frame = 0
    let pending = null
    const flush = () => {
      frame = 0
      if (!pending) return
      const { card, x, y } = pending
      pending = null
      card.style.setProperty('--pointer-x', `${x}%`)
      card.style.setProperty('--pointer-y', `${y}%`)
    }
    const onMove = (event) => {
      const card = event.target instanceof Element ? event.target.closest(PANEL_SELECTOR) : null
      if (!card || !main.contains(card)) return
      const rect = card.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      pending = {
        card,
        x: Math.round(((event.clientX - rect.left) / rect.width) * 100),
        y: Math.round(((event.clientY - rect.top) / rect.height) * 100),
      }
      if (!frame) frame = requestAnimationFrame(flush)
    }
    main.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      main.removeEventListener('pointermove', onMove)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [mainRef, enabled, reducedMotion])

  useEffect(() => {
    const main = mainRef.current
    if (!enabled || !ready || !main || reducedMotion) return undefined

    let context = null
    let tween = null
    let cancelled = false
    // Failsafe: a throttled/background tab may stop ticking frames. Whatever
    // state the entrance is in by now, panels are shown at full opacity.
    const failsafe = setTimeout(() => tween?.progress(1), 1200)
    // GSAP loads lazily (it is shared with the Dashboard chunk), so the shell's
    // initial bundle does not carry the animation engine.
    const frame = requestAnimationFrame(async () => {
      const viewportBottom = main.getBoundingClientRect().bottom
      const panels = [...main.querySelectorAll(PANEL_SELECTOR)]
        .filter((card) => !card.parentElement?.closest(PANEL_SELECTOR))
        .filter((card) => card.getBoundingClientRect().top < viewportBottom)
        .slice(0, MAX_ENTRANCE_PANELS)
      if (panels.length === 0) return
      const { gsap } = await import('gsap')
      if (cancelled) return
      context = gsap.context(() => {
        tween = gsap.fromTo(panels,
          { autoAlpha: 0, y: 12 },
          { autoAlpha: 1, y: 0, duration: 0.42, stagger: 0.055, ease: 'power3.out', clearProps: 'transform,opacity,visibility' })
      }, main)
    })
    return () => {
      cancelled = true
      clearTimeout(failsafe)
      cancelAnimationFrame(frame)
      context?.revert()
    }
  }, [mainRef, screen, ready, enabled, reducedMotion])
}
