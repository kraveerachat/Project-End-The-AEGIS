import React, { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Eye, EyeOff, Moon, Sun, X as XIcon } from 'lucide-react'

// One restrained reveal vocabulary, ported from the IDEA1 Production login.
// Motion never owns input availability or authentication.
const LOGIN_EASE = [0.32, 0.72, 0, 1]
const entranceVariants = { hidden: {}, show: { transition: { staggerChildren: 0.055 } } }
const revealVariants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.32, ease: LOGIN_EASE } },
}
const revealViewport = { once: true, amount: 0.15 }
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

// Only the last row describes a measured result (this login response). The
// other rows state architecture and are never presented as runtime-verified.
const LAYERS = [
  { id: 0, name: 'ADMIN RBAC', description: 'สิทธิ์ผู้ดูแลถูกตรวจที่ฝั่งเซิร์ฟเวอร์เสมอ' },
  { id: 1, name: 'CSRF PROTECTION', description: 'ทุกคำสั่งที่เปลี่ยนสถานะต้องมีโทเคน CSRF' },
  { id: 2, name: 'SECURE SESSION', description: 'คุกกี้ HttpOnly / SameSite ไม่เก็บโทเคนในเบราว์เซอร์' },
  { id: 3, name: 'SERVER-OWNED AUTH', description: 'เซิร์ฟเวอร์เป็นผู้ยืนยันตัวตน ไม่ใช่เบราว์เซอร์' },
]
const STATUS_TEXT = {
  info: 'โครงสร้างระบบ',
  idle: 'พร้อมรับการตรวจ',
  checking: 'กำลังตรวจสอบ',
  ok: 'ตอบรับสำเร็จ',
  fail: 'ไม่สำเร็จ',
}

function useReducedMotion() {
  const query = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)') : null)
  const [reduced, setReduced] = useState(() => query()?.matches ?? false)
  useEffect(() => {
    const media = query()
    if (!media) return undefined
    const onChange = () => setReduced(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return reduced
}

function themeAsset(theme) {
  const dark = theme === 'dark'
  return {
    logo: dark ? 'assets/logo/aegis-mark-light-ink.png' : 'assets/logo/aegis-mark-dark-ink.png',
    background: dark ? 'assets/BG_AEGIS02.png' : 'assets/BG_AEGIS01.png',
  }
}

function AegisMark({ size, theme, className }) {
  const [fallback, setFallback] = useState(false)
  const dark = theme === 'dark'
  const src = `${import.meta.env.BASE_URL}${themeAsset(theme).logo}`
  useEffect(() => { setFallback(false) }, [src])
  if (!fallback) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        className={className}
        style={{ width: size, height: size, objectFit: 'contain', filter: dark ? 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3))' : 'none' }}
        onError={() => setFallback(true)}
        draggable={false}
      />
    )
  }
  const stroke = dark ? '#ffffff' : '#0f172a'
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" className={className} aria-hidden="true">
      <g fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round">
        <path d="M24 3 L42 13 V30 L24 45 L6 30 V13 Z" strokeDasharray="4 3" />
        <path d="M24 10 L36 17 V28 L24 38 L12 28 V17 Z" strokeDasharray="2.5 3" opacity="0.7" />
        <path d="M24 17 L30 20.5 V27 L24 32 L18 27 V20.5 Z" strokeDasharray="1.5 2.5" opacity="0.45" />
      </g>
    </svg>
  )
}

function LayerRow({ layer, status, reduced }) {
  return (
    <motion.li variants={reduced ? undefined : revealVariants} data-layer-status={status} data-layer-id={layer.id} className="vault-layer-row">
      <span className="vault-layer-node" aria-hidden="true">
        {status === 'ok' ? (
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.2 3.2L13 4.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        ) : status === 'fail' ? <XIcon size={13} strokeWidth={2.5} /> : <span className="vault-layer-core" />}
      </span>
      <span className="vault-layer-copy">
        <span className="vault-layer-name">{layer.name}</span>
        <span className="vault-layer-description">{layer.description}</span>
      </span>
      <span className="vault-layer-status">{STATUS_TEXT[status]}</span>
    </motion.li>
  )
}

export function LoginPage({ onLogin, onLoginComplete = () => {}, theme = document.documentElement.dataset.theme || 'dark', onThemeChange }) {
  const reduced = useReducedMotion()
  const reveal = reduced ? {} : { variants: revealVariants }
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState('idle')
  const [gateStatus, setGateStatus] = useState('idle')
  const [shake, setShake] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const busyRef = useRef(false)
  const shakeTimer = useRef(null)
  const passwordRef = useRef(null)
  const refocus = useRef(false)
  // Below-the-fold rows reveal on scroll like IDEA1; without IntersectionObserver they simply show.
  const layerReveal = reduced ? {} : typeof IntersectionObserver === 'undefined' ? { animate: 'show' } : { whileInView: 'show', viewport: revealViewport }
  const background = `${import.meta.env.BASE_URL}${themeAsset(theme).background}`
  const statuses = ['info', 'info', 'info', gateStatus]

  useEffect(() => () => clearTimeout(shakeTimer.current), [])

  // Inputs are disabled while checking, so focus falls to the page; return it to the password field once they re-enable.
  useEffect(() => {
    if (!busy && refocus.current) {
      refocus.current = false
      passwordRef.current?.focus()
    }
  }, [busy])

  async function submit(event) {
    event.preventDefault()
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    setPhase('checking')
    setGateStatus('checking')
    const minimum = sleep(reduced ? 0 : 250)
    try {
      await onLogin({ username: username.trim(), password })
    } catch (loginError) {
      await minimum
      setPhase('error')
      setGateStatus('fail')
      setError(loginError?.message || 'เข้าสู่ระบบไม่สำเร็จ')
      if (!reduced) {
        setShake(true)
        clearTimeout(shakeTimer.current)
        shakeTimer.current = setTimeout(() => setShake(false), 300)
      }
      refocus.current = true
      setBusy(false)
      busyRef.current = false
      return
    }
    await minimum
    setPassword('')
    setPhase('success')
    setGateStatus('ok')
    await sleep(reduced ? 0 : 180)
    setLeaving(true)
    await sleep(reduced ? 0 : 240)
    onLoginComplete()
  }

  return (
    <div className="vault-shell" data-theme-surface={theme}>
      <div className="vault-gate-bg" style={{ '--gate-image': `url("${background}")` }} aria-hidden="true" />
      <div className="vault-gate-halo" aria-hidden="true" />
      <div className="vault-dot-field" aria-hidden="true" />
      <div className="vault-ambient-beam" aria-hidden="true" />

      {onThemeChange && (
        <motion.div {...reveal} initial={reduced ? false : 'hidden'} animate="show" data-login-motion="controls" className="vault-top-controls">
          <button type="button" className="vault-theme-toggle" aria-label={theme === 'dark' ? 'ใช้ธีมสว่าง' : 'ใช้ธีมมืด'} onClick={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}
          </button>
        </motion.div>
      )}

      <main className="vault-field" data-security-field data-motion={reduced ? 'reduced' : 'full'} data-phase={phase}>
        <div className="vault-field-aura" data-field-aura aria-hidden="true" />
        <motion.div
          variants={reduced ? undefined : entranceVariants}
          initial={reduced ? false : 'hidden'}
          animate={{ scale: leaving && !reduced ? 1.015 : 1, opacity: leaving && !reduced ? 0 : 1 }}
          transition={{ duration: reduced ? 0 : 0.24, ease: LOGIN_EASE }}
          className="vault-card"
        >
          <div className="vault-brand-panel">
            <motion.div variants={reduced ? undefined : entranceVariants} initial={reduced ? false : 'hidden'} animate="show" className="vault-brand-lockup">
              <motion.div {...reveal} data-login-motion="mark" className="vault-mark-stage">
                <span className="vault-mark-backlight" aria-hidden="true" />
                <AegisMark size={180} theme={theme} className="vault-mark" />
              </motion.div>
              <div className="vault-brand-text">
                <motion.h1 {...reveal} data-login-motion="wordmark" lang="en" className="vault-brand-name">AEGIS</motion.h1>
                <motion.p {...reveal} data-login-motion="tagline" lang="en" className="vault-brand-tag">IDEA3 · SECURITY CENTER</motion.p>
              </div>
            </motion.div>
          </div>

          <div className="vault-form-panel">
            <motion.div variants={reduced ? undefined : entranceVariants} initial={reduced ? false : 'hidden'} animate="show">
              <motion.h2 {...reveal} data-login-motion="title" className="vault-title">เข้าสู่ Security Center</motion.h2>
              <motion.p {...reveal} data-login-motion="subtitle" className="vault-subtitle">ใช้บัญชีผู้ดูแลระบบที่กำหนดจากฝั่งเซิร์ฟเวอร์</motion.p>

              <motion.form variants={reduced ? undefined : entranceVariants} onSubmit={submit} className={`vault-form${shake ? ' shake-x' : ''}`}>
                <motion.div {...reveal} data-login-motion="username">
                  <label htmlFor="login-username" className="vault-label">ชื่อผู้ดูแลระบบ</label>
                  <input id="login-username" className="vault-input" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" placeholder="ชื่อผู้ดูแลระบบของคุณ" maxLength={80} disabled={busy} required aria-describedby={error ? 'login-error' : undefined} />
                </motion.div>

                <motion.div {...reveal} data-login-motion="password">
                  <label htmlFor="login-password" className="vault-label">รหัสผ่าน</label>
                  <div className="vault-password">
                    <input id="login-password" ref={passwordRef} className="vault-input vault-input--password" type={visible ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" placeholder="รหัสผ่านของคุณ" maxLength={200} disabled={busy} required aria-describedby={error ? 'login-error' : undefined} />
                    <motion.button
                      type="button"
                      className="vault-password-toggle"
                      aria-label={visible ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
                      aria-pressed={visible}
                      onClick={() => setVisible((value) => !value)}
                      whileTap={reduced ? undefined : { scale: 0.96 }}
                      transition={{ duration: reduced ? 0 : 0.12, ease: LOGIN_EASE }}
                    >
                      {visible ? <EyeOff size={16} strokeWidth={1.75} aria-hidden="true" /> : <Eye size={16} strokeWidth={1.75} aria-hidden="true" />}
                    </motion.button>
                  </div>
                </motion.div>

                <motion.div {...reveal} initial={false} data-login-motion="submit">
                  <button className="vault-submit" type="submit" disabled={busy}>{busy ? 'กำลังตรวจสอบ…' : 'เข้าสู่ Security Center'}</button>
                </motion.div>

                <div className="vault-error-slot">
                  {error && <p id="login-error" role="alert" className="vault-error">{error}</p>}
                </div>
              </motion.form>
            </motion.div>

            <motion.ul
              variants={reduced ? undefined : entranceVariants}
              initial={reduced ? false : 'hidden'}
              {...layerReveal}
              data-login-motion="layers"
              className="vault-layers"
              aria-label="สถาปัตยกรรมความปลอดภัย"
            >
              {LAYERS.map((layer, index) => <LayerRow key={layer.id} layer={layer} status={statuses[index]} reduced={reduced} />)}
            </motion.ul>
          </div>
        </motion.div>
      </main>
    </div>
  )
}
