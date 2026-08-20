import { useEffect, useState } from 'react'

/** Shared asset contract for every theme-aware AEGIS surface. */
export function themeAssetsFor(theme) {
  const dark = theme === 'dark'
  return {
    logo: dark ? 'assets/logo/aegis-mark-light-ink.png' : 'assets/logo/aegis-mark-dark-ink.png',
    welcome: dark ? 'assets/BG_AEGIS02.png' : 'assets/BG_AEGIS01.png',
  }
}

/**
 * The AEGIS mark — a hexagonal shield in dash-dither strokes.
 * Prefers the pre-generated PNG in /public/assets/logo/; until those files
 * are dropped in, a built-in SVG placeholder with the same dash-dither
 * language renders instead.
 */
export function AegisMark({ size = 32, theme = 'light', className = '' }) {
  const [fallback, setFallback] = useState(false)
  const isDark = theme === 'dark'
  const src = import.meta.env.BASE_URL + themeAssetsFor(theme).logo

  useEffect(() => {
    setFallback(false)
  }, [src])

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
          filter: isDark ? 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3))' : 'none',
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
export function AegisLockup({ markSize = 36, theme = 'light', title = 'AEGIS Drive_LC', sub = 'SECURE NAS · NEXT-GEN HUD' }) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <div className="shrink-0 flex items-center justify-center" style={{ width: markSize, height: markSize }}>
        <AegisMark size={markSize} theme={theme} />
      </div>
      <div className="min-w-0">
        <div lang="en" className="font-bold text-[16px] tracking-[0.02em] text-ink leading-tight truncate">
          {title}
        </div>
        {sub && (
          <div className="text-[10px] font-semibold text-ink-3 uppercase tracking-[0.14em] mt-0.5 truncate">
            {sub}
          </div>
        )}
      </div>
    </div>
  )
}
