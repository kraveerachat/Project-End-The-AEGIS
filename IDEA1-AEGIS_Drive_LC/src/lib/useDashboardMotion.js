import { useEffect } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

// Critically damped spring: settles without the overshoot/bounce that would
// make an operational console feel unstable.
const settle = (progress) => (1 - (1 + 7 * progress) * Math.exp(-7 * progress)) / (1 - 8 * Math.exp(-7))

/**
 * Dashboard-only motion. No reading is synthesized or delayed by this hook:
 * every value is already rendered; motion only moves it into place.
 *
 * Entrance reads top → bottom, left → right: page heading, the four KPI cards,
 * then the analytics row. The two lower rows reveal on scroll (or immediately
 * when already in view). Hover is a small lift plus pointer-following edge
 * light written to CSS variables; there is no 3D tilt.
 */
export function useDashboardMotion(rootRef, enabled, reducedMotion, classic = false) {
  useEffect(() => {
    const root = rootRef.current
    if (!enabled || !root || reducedMotion) return undefined

    const scroller = root.closest('main')
    const finePointer = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches === true
    const cleanups = []
    gsap.registerPlugin(ScrollTrigger)

    const context = gsap.context(() => {
      const heading = root.ownerDocument.querySelector('.dashboard-page-header')
      if (heading) {
        gsap.fromTo(heading, { autoAlpha: 0, y: classic ? 5 : 8 }, { autoAlpha: 1, y: 0, duration: classic ? 0.22 : 0.36, ease: 'power3.out', clearProps: 'transform,opacity,visibility' })
      }
      const kpis = root.querySelectorAll('.dashboard-kpi-row > .ui-card')
      gsap.fromTo(kpis,
        { autoAlpha: 0, y: classic ? 5 : 14 },
        { autoAlpha: 1, y: 0, duration: classic ? 0.23 : 0.46, delay: 0.06, stagger: classic ? 0.03 : 0.06, ease: 'power3.out', clearProps: 'transform,opacity,visibility' })
      const analytics = root.querySelectorAll('.dashboard-analytics-grid > *')
      gsap.fromTo(analytics,
        { autoAlpha: 0, y: classic ? 6 : 16 },
        { autoAlpha: 1, y: 0, duration: classic ? 0.26 : 0.5, delay: classic ? 0.12 : 0.24, stagger: classic ? 0.04 : 0.07, ease: 'power3.out', clearProps: 'transform,opacity,visibility' })

      if (finePointer && !classic) {
        root.querySelectorAll('.ui-card').forEach((card) => {
          if (card.parentElement?.closest('.ui-card')) return
          let frame = 0
          let point = null
          const flush = () => {
            frame = 0
            if (!point) return
            card.style.setProperty('--pointer-x', `${point.x}%`)
            card.style.setProperty('--pointer-y', `${point.y}%`)
          }
          const onMove = (event) => {
            const rect = card.getBoundingClientRect()
            point = {
              x: Math.round(((event.clientX - rect.left) / rect.width) * 100),
              y: Math.round(((event.clientY - rect.top) / rect.height) * 100),
            }
            if (!frame) frame = requestAnimationFrame(flush)
          }
          const onEnter = () => gsap.to(card, { y: -2, duration: 0.22, ease: 'power3.out', overwrite: 'auto' })
          const onLeave = () => gsap.to(card, { y: 0, duration: 0.36, ease: settle, overwrite: 'auto' })
          card.addEventListener('pointermove', onMove, { passive: true })
          card.addEventListener('pointerenter', onEnter)
          card.addEventListener('pointerleave', onLeave)
          cleanups.push(() => {
            if (frame) cancelAnimationFrame(frame)
            card.removeEventListener('pointermove', onMove)
            card.removeEventListener('pointerenter', onEnter)
            card.removeEventListener('pointerleave', onLeave)
          })
        })
      }

      // Below the primary scan line. The tween is created only on entry, so a
      // trigger that never fires leaves content in its visible default.
      if (scroller) {
        root.querySelectorAll('.dashboard-ops-grid, .dashboard-links-row').forEach((section) => {
          ScrollTrigger.create({
            trigger: section,
            scroller,
            start: 'top 94%',
            once: true,
            onEnter: () => gsap.fromTo(section.children,
              { autoAlpha: 0, y: classic ? 5 : 12 },
              { autoAlpha: 1, y: 0, duration: classic ? 0.24 : 0.44, stagger: classic ? 0.03 : 0.06, ease: 'power3.out', overwrite: 'auto', clearProps: 'transform,opacity,visibility' }),
          })
        })
      }
    }, root)

    return () => {
      cleanups.forEach((cleanup) => cleanup())
      context.revert()
    }
  }, [rootRef, enabled, reducedMotion, classic])
}
