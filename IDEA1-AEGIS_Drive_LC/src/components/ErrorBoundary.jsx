import { Component } from 'react'
import { makeT } from '../lib/strings.js'

function activeLanguage() {
  const language = typeof document === 'undefined' ? 'en' : document.documentElement.lang.toLowerCase()
  if (language.startsWith('th')) return 'th'
  if (language.startsWith('zh')) return 'zh'
  return 'en'
}

/**
 * ErrorBoundary — ตาข่ายสุดท้ายกัน "จอขาว" ระหว่างเดโม่บนฮาร์ดแวร์จริง
 * render error ใด ๆ ที่หลุดมาถึงราก → จอเดียวที่อ่านรู้เรื่อง + ปุ่มโหลดใหม่
 * รายละเอียด error ลง console เท่านั้น — ไม่โชว์ stack trace บนจอ (info disclosure)
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { crashed: false }
  }

  static getDerivedStateFromError() {
    return { crashed: true }
  }

  componentDidCatch(error, info) {
    console.error('[aegis-drive] render crash:', error, info)
  }

  render() {
    if (!this.state.crashed) return this.props.children
    const t = makeT(activeLanguage())
    return (
      <div className="h-full flex items-center justify-center bg-canvas px-6">
        <div
          role="alert"
          className="bg-card rounded-[var(--r-card)] px-10 py-9 max-w-[420px] w-full flex flex-col items-center text-center gap-3"
          style={{ boxShadow: 'var(--elev-2)' }}
        >
          <span className="flex items-center justify-center size-12 rounded-full bg-danger-soft">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 9v4M12 17h.01" />
              <circle cx="12" cy="12" r="10" />
            </svg>
          </span>
          <p className="text-[16px] font-semibold text-ink">{t('errorBoundaryTitle')}</p>
          <p className="text-[13px] text-ink-2 leading-relaxed">
            {t('errorBoundaryBody')}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-2 inline-flex items-center justify-center h-10 px-5 rounded-full bg-accent text-white text-[14px] font-semibold cursor-pointer"
          >
            {t('errorBoundaryReload')}
          </button>
        </div>
      </div>
    )
  }
}
