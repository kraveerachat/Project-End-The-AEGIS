import React from 'react'

const LOGO_BY_THEME = Object.freeze({
  dark: 'assets/logo/aegis-mark-light-ink.png',
  light: 'assets/logo/aegis-mark-dark-ink.png',
})

export function AegisLogo({ theme = 'dark', className = '', size, alt = 'AEGIS' }) {
  const activeTheme = theme === 'light' ? 'light' : 'dark'
  const dimension = Number.isFinite(size) ? size : undefined
  const src = `${import.meta.env.BASE_URL}${LOGO_BY_THEME[activeTheme]}`

  return (
    <img
      src={src}
      alt={alt}
      width={dimension}
      height={dimension}
      className={className}
      data-logo-theme={activeTheme}
      style={{ objectFit: 'contain' }}
      draggable={false}
    />
  )
}
