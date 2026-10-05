import { ICONS } from './Sidebar.jsx'

/** Routes arrive already filtered by the server's role-specific menu. */
export function PositionedNavigation({ t, nav, screen, go, position }) {
  const items = nav.some((item) => item.id === 'settings')
    ? nav
    : [...nav, { id: 'settings', icon: 'settings', labelKey: 'navSettings' }]

  return (
    <nav
      data-position={position}
      aria-label={t('productName')}
      className={`positioned-navigation positioned-navigation--${position} hidden lg:flex`}
    >
      <div className="positioned-navigation__items">
        {items.map((item) => {
          const Icon = ICONS[item.icon] ?? ICONS.gauge
          const label = t(item.labelKey)
          return (
            <button
              key={item.id}
              type="button"
              title={label}
              aria-label={position === 'bottom' ? label : undefined}
              aria-current={screen === item.id ? 'page' : undefined}
              className={`positioned-navigation__item ${screen === item.id ? 'is-active' : ''}`}
              onClick={() => go(item.id)}
            >
              <Icon size={17} strokeWidth={1.65} aria-hidden />
              <span>{label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
