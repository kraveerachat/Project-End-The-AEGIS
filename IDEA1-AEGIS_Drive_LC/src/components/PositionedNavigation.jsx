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
  const shownScreen = useRef(null)

  // Presentation only. In Neo Dark the top rail's cradle is the suspended tab
  // under the current cell (the bottom bar's pod draws its own ring instead).
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return undefined
    const measure = () => {
      // While the top tab retracts it stays where it was.
      if (list.dataset.tabPhase === 'up') return
      const item = list.querySelector('.positioned-navigation__item.is-active')
      const anchor = position === 'top' ? item : item?.querySelector('.positioned-navigation__pod')
      if (!anchor || anchor.offsetWidth === 0) {
        list.dataset.cradle = 'none'
        return
      }
      const { x, y } = offsetWithin(anchor, list)
      list.style.setProperty('--nav-cradle-x', `${x + anchor.offsetWidth / 2}px`)
      list.style.setProperty('--nav-cradle-y', `${y + anchor.offsetHeight / 2}px`)
      list.style.setProperty('--nav-cradle-w', `${anchor.offsetWidth}px`)
      // The first placement snaps into place; later route changes animate.
      list.dataset.cradle = list.dataset.cradle === 'placed' || list.dataset.cradle === 'ready' ? 'ready' : 'placed'
    }

    // Top route change, three phases: the old tab retracts into the rail (up),
    // the retracted tab slides to the new cell (move), then it descends (down).
    // Reduced motion switches directly.
    const timers = []
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (position === 'top' && !reduce && list.dataset.cradle === 'ready' && shownScreen.current !== screen) {
      list.dataset.tabPhase = 'up'
      timers.push(window.setTimeout(() => {
        list.dataset.tabPhase = 'move'
        measure()
        timers.push(window.setTimeout(() => { list.dataset.tabPhase = 'down' }, 200))
      }, 160))
    } else {
      list.dataset.tabPhase = 'down'
      measure()
    }
    shownScreen.current = screen

    // Test DOMs may lack rAF; the synchronous measure above already placed it.
    const settle = typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame(measure) : 0
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(list)
    return () => {
      if (timers.length) {
        timers.forEach((id) => window.clearTimeout(id))
        list.dataset.tabPhase = 'down'
      }
      if (settle) window.cancelAnimationFrame(settle)
      observer?.disconnect()
    }
  }, [screen, items.length, position])

  return (
    <nav
      data-position={position}
      aria-label={t('productName')}
      className={`positioned-navigation positioned-navigation--${position} hidden lg:flex`}
    >
      <div ref={listRef} className="positioned-navigation__items">
        <span className="positioned-navigation__cradle" aria-hidden="true">
          <span className="positioned-navigation__shoulder" data-side="start" />
          <span className="positioned-navigation__shoulder" data-side="end" />
        </span>
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
