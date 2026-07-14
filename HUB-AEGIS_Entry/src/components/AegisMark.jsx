import { useState, useEffect } from 'react'

function useIsDarkMode() {
  const [isDark, setIsDark] = useState(() => {
    const theme = document.documentElement.dataset.theme
    if (theme === 'dark') return true
    if (theme === 'light') return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  useEffect(() => {
    const observer = new MutationObserver(() => {
      const theme = document.documentElement.dataset.theme
      if (theme === 'dark') {
        setIsDark(true)
      } else if (theme === 'light') {
        setIsDark(false)
      } else {
        setIsDark(window.matchMedia('(prefers-color-scheme: dark)').matches)
      }
    })

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })

    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handleMq = (e) => {
      const theme = document.documentElement.dataset.theme
      if (theme !== 'dark' && theme !== 'light') {
        setIsDark(e.matches)
      }
    }
    mq.addEventListener('change', handleMq)

    return () => {
      observer.disconnect()
      mq.removeEventListener('change', handleMq)
    }
  }, [])

  return isDark
}

/**
 * The AEGIS mark — a hexagonal shield in dash-dither strokes.
 * Prefers the pre-generated PNG in /public/assets/logo/; until those files
 * are dropped in, a built-in SVG placeholder with the same dash-dither
 * language renders instead (onError swap). Square, never stretched, never
 * on a colored background, never with a shadow or glow.
 */
export function AegisMark({ size = 28, dark, className = '' }) {
  const [fallback, setFallback] = useState(false)
  const isDarkTheme = useIsDarkMode()
  const isDark = dark !== undefined ? dark : isDarkTheme
  const src = isDark ? '/assets/logo/aegis-mark-light-ink.png' : '/assets/logo/aegis-mark-dark-ink.png'


  if (!fallback) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden
        width={size}
        height={size}
        className={`select-none ${className}`}
        style={{ width: size, height: size, objectFit: 'contain' }}
        onError={() => setFallback(true)}
        draggable={false}
      />
    )
  }

  // Placeholder: hexagonal shield rendered as dashed strokes — same
  // dash-dither grammar as the real mark, drawn in the current ink.
  const stroke = isDark ? '#ffffff' : 'var(--ink)'
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={`select-none ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <g fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round">
        <path d="M24 3 L42 13 V30 L24 45 L6 30 V13 Z" strokeDasharray="4 3" />
        <path d="M24 10 L36 17 V28 L24 38 L12 28 V17 Z" strokeDasharray="2.5 3" opacity="0.7" />
        <path d="M24 17 L30 20.5 V27 L24 32 L18 27 V20.5 Z" strokeDasharray="1.5 2.5" opacity="0.45" />
      </g>
    </svg>
  )
}
