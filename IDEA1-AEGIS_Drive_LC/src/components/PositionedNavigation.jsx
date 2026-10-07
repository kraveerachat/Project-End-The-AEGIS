import { useLayoutEffect, useRef } from 'react'
import { ICONS } from './Sidebar.jsx'

// Layout offset of `node` inside `root`, ignoring CSS transforms, so the
// active pod's own lift never feeds back into where the cradle sits.
function offsetWithin(node, root) {
  let x = 0
  let y = 0
  for (let el = node; el && el !== root; el = el.offsetParent) {
    x += el.offsetLeft
    y += el.offsetTop
  }
  return { x, y }
}

/** Routes arrive already filtered by the server's role-specific menu. */
export function PositionedNavigation({ t, nav, screen, go, position }) {
  const items = nav.some((item) => item.id === 'settings')
    ? nav
    : [...nav, { id: 'settings', icon: 'settings', labelKey: 'navSettings' }]
  const listRef = useRef(null)

  // Presentation only: the Neo Dark cradle follows the current item's icon.
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return undefined
    const measure = () => {
      const pod = list.querySelector('.positioned-navigation__item.is-active .positioned-navigation__pod')
      if (!pod || pod.offsetWidth === 0) {
        list.dataset.cradle = 'none'
        return
      }
      const { x, y } = offsetWithin(pod, list)
      list.style.setProperty('--nav-cradle-x', `${x + pod.offsetWidth / 2}px`)
      list.style.setProperty('--nav-cradle-y', `${y + pod.offsetHeight / 2}px`)
      // The first placement snaps into place; later route changes glide.
      list.dataset.cradle = list.dataset.cradle === 'placed' || list.dataset.cradle === 'ready' ? 'ready' : 'placed'
    }
    measure()
    // Test DOMs may lack rAF; the synchronous measure above already placed it.
    const settle = typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame(measure) : 0
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(list)
    return () => {
      if (settle) window.cancelAnimationFrame(settle)
      observer?.disconnect()
    }
  }, [screen, items.length])

  return (
    <nav
      data-position={position}
      aria-label={t('productName')}
      className={`positioned-navigation positioned-navigation--${position} hidden lg:flex`}
    >
      <div ref={listRef} className="positioned-navigation__items">
        <span className="positioned-navigation__cradle" aria-hidden="true" />
        {items.map((item) => {
          const Icon = ICONS[item.icon] ?? ICONS.gauge
          const label = t(item.labelKey)
          return (
            <button
              key={item.id}
              type="button"
              title={label}
              aria-label={label}
              aria-current={screen === item.id ? 'page' : undefined}
              className={`positioned-navigation__item ${screen === item.id ? 'is-active' : ''}`}
              onClick={() => go(item.id)}
            >
              <span className="positioned-navigation__pod"><Icon size={17} strokeWidth={1.65} aria-hidden /></span>
              <span className="positioned-navigation__label">{label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
