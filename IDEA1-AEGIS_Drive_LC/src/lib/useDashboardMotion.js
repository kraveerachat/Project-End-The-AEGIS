import { useEffect } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

// Critically damped spring: settles without the overshoot/bounce that would
// make an operational console feel unstable.
const settle = (progress) => (1 - (1 + 7 * progress) * Math.exp(-7 * progress)) / (1 - 8 * Math.exp(-7))

/** Dashboard-only motion. No reading is synthesized or delayed by this hook. */
export function useDashboardMotion(rootRef, enabled, reducedMotion) {
  useEffect(() => {
    const root = rootRef.current
    if (!enabled || !root || reducedMotion) return undefined

    const scroller = root.closest('main')
    const finePointer = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches === true
    const cleanups = []
    gsap.registerPlugin(ScrollTrigger)

    const context = gsap.context(() => {
      const entryCards = root.querySelectorAll('.dashboard-kpi-grid .ui-card, .dashboard-primary-grid .ui-card')
      gsap.fromTo(entryCards,
        { autoAlpha: 0, y: 14 },
        { autoAlpha: 1, y: 0, duration: 0.48, stagger: 0.065, ease: 'power3.out', clearProps: 'transform,opacity,visibility' })

      if (finePointer) {
        root.querySelectorAll('.ui-card').forEach((card) => {
          const rotateX = gsap.quickTo(card, 'rotationX', { duration: 0.34, ease: settle })
          const rotateY = gsap.quickTo(card, 'rotationY', { duration: 0.34, ease: settle })
          const onMove = (event) => {
            const rect = card.getBoundingClientRect()
            const x = (event.clientX - rect.left) / rect.width
            const y = (event.clientY - rect.top) / rect.height
            card.style.setProperty('--pointer-x', `${Math.round(x * 100)}%`)
            card.style.setProperty('--pointer-y', `${Math.round(y * 100)}%`)
            rotateX((0.5 - y) * 2)
            rotateY((x - 0.5) * 2)
          }
          const onEnter = () => gsap.to(card, { y: -3, duration: 0.22, ease: 'power3.out', overwrite: 'auto' })
          const onLeave = () => {
            rotateX(0)
            rotateY(0)
            gsap.to(card, { y: 0, duration: 0.36, ease: settle, overwrite: 'auto' })
          }
          card.addEventListener('pointermove', onMove, { passive: true })
          card.addEventListener('pointerenter', onEnter)
          card.addEventListener('pointerleave', onLeave)
          cleanups.push(() => {
            card.removeEventListener('pointermove', onMove)
            card.removeEventListener('pointerenter', onEnter)
            card.removeEventListener('pointerleave', onLeave)
          })
        })
      }

      // These sections are below the primary operational scan line. Create
      // the tween only on entry so a failed trigger never leaves content hidden.
      if (scroller) {
        root.querySelectorAll('.dashboard-secondary-grid, .dashboard-recents-grid').forEach((section) => {
          ScrollTrigger.create({
            trigger: section,
            scroller,
            start: 'top 92%',
            once: true,
            onEnter: () => gsap.fromTo(section,
              { autoAlpha: 0, y: 12 },
              { autoAlpha: 1, y: 0, duration: 0.42, ease: 'power3.out', overwrite: 'auto' }),
          })
        })
      }
    }, root)

    return () => {
      cleanups.forEach((cleanup) => cleanup())
      context.revert()
    }
  }, [rootRef, enabled, reducedMotion])
}
