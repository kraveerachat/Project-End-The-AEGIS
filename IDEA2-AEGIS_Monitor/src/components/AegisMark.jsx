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
 * language renders instead.
 */
export function AegisMark({ size = 32, dark, className = '' }) {
  const [fallback, setFallback] = useState(false)
  const isDarkTheme = useIsDarkMode()
  const isDark = dark !== undefined ? dark : isDarkTheme
  const src = import.meta.env.BASE_URL + (isDark ? 'assets/logo/aegis-mark-light-ink.png' : 'assets/logo/aegis-mark-dark-ink.png')

  if (!fallback) {
    return (
      <img
        src={src}
        alt="AEGIS Emblem"
        aria-hidden
        width={size}
        height={size}
        className={`select-none ${className}`}
        style={{
          width: size,
          height: size,
          objectFit: 'contain',
          filter: isDark ? 'drop-shadow(0 0 8px rgba(0, 229, 255, 0.35))' : 'none',
        }}
        onError={() => setFallback(true)}
        draggable={false}
      />
    )
  }

  const stroke = isDark ? '#ffffff' : '#0f172a'
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" className={`select-none ${className}`} aria-hidden>
      <g fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round">
        <path d="M24 3 L42 13 V30 L24 45 L6 30 V13 Z" strokeDasharray="4 3" />
        <path d="M24 10 L36 17 V28 L24 38 L12 28 V17 Z" strokeDasharray="2.5 3" opacity="0.7" />
        <path d="M24 17 L30 20.5 V27 L24 32 L18 27 V20.5 Z" strokeDasharray="1.5 2.5" opacity="0.45" />
      </g>
    </svg>
  )
}

/** Mark + wordmark lockup matching CCTV-Operator layout style. */
export function AegisLockup({ markSize = 36, dark, title = 'AEGIS Drive_LC', sub = 'SECURE NAS · NEXT-GEN HUD' }) {
  return (
    <div className="flex items-center gap-3 min-w-max shrink-0 whitespace-nowrap">
      <div className="shrink-0 flex items-center justify-center" style={{ width: markSize, height: markSize }}>
        <AegisMark size={markSize} dark={dark} />
      </div>
      <div className="min-w-max shrink-0">
        <div lang="en" className="font-bold text-[16px] tracking-[0.02em] text-ink leading-tight whitespace-nowrap">
          {title}
        </div>
        {sub && (
          <div className="text-[10px] font-semibold text-ink-3 uppercase tracking-[0.14em] mt-0.5 whitespace-nowrap">
            {sub}
          </div>
        )}
      </div>
    </div>
  )
}
