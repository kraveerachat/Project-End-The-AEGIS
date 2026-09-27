import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Eye, EyeOff, X as XIcon } from 'lucide-react'
import { login } from '../lib/auth.js'
import { useReducedMotion } from '../lib/hooks.js'
import { Toggle, Segmented, SparkleButton, ThemeToggle } from '../components/ui.jsx'
import { AegisMark, themeAssetsFor } from '../components/AegisMark.jsx'
import { LANGS } from '../lib/strings.js'

const LAYERS = [
  { id: 0, nameKey: 'layerNetwork', descKey: 'layerNetworkDesc' },
  { id: 1, nameKey: 'layerApp', descKey: 'layerAppDesc' },
  { id: 2, nameKey: 'layerStorage', descKey: 'layerStorageDesc' },
  { id: 3, nameKey: 'layerMeta', descKey: 'layerMetaDesc' },
]

const layersContainerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.08,
      delayChildren: 0.15,
    },
  },
}

const layerItemVariants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.25, ease: 'easeOut' } },
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * แปลงผลที่ล้มเหลวของ login() → คีย์ข้อความที่ "ตรงกับสาเหตุจริง"
 *
 * ⚠️ กฎเดียวที่ห้ามผิด: `loginFailed` ("ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง") ใช้ได้
 *    เฉพาะเมื่อเซิร์ฟเวอร์ "ตรวจรหัสผ่านจริงแล้วปฏิเสธ" เท่านั้น = 401 (และ 429
 *    ที่เป็นผลสะสมจากการตรวจที่ล้มเหลวมาก่อน) ทุกกรณีที่เหลือคือคำขอที่ไม่เคย
 *    ไปถึงขั้นตอนตรวจรหัสผ่าน — บอกผู้ใช้ว่า "รหัสผิด" คือการโกหกและพาไปแก้ผิดจุด
 *    (ผู้ใช้จะนั่งพิมพ์รหัสใหม่ ทั้งที่สิ่งที่ต้องทำคือโหลดหน้าใหม่)
 */
function loginErrorKey({ status, errorKind }) {
  if (status === 429) return 'lockout'          // ถูกจำกัดอัตรา — ข้อความมีตัวนับแยกอยู่แล้ว
  if (errorKind === 'csrf') return 'loginBlockedCsrf'
  if (errorKind === 'timeout') return 'loginTimeout'
  if (errorKind === 'network') return 'loginNetwork'
  if (status === 401) return 'loginFailed'      // ← ทางเดียวที่พูดเรื่องรหัสผ่านได้
  return 'loginServerError'                     // 403 อื่น ๆ / 5xx / อะไรที่ไม่รู้จัก
}

function LayerRow({ t, layer, status }) {
  const isOk = status === 'ok'
  const isFail = status === 'fail'
  const statusKey = isOk ? 'layerStatusVerified' : isFail ? 'layerStatusFailed'
    : status === 'checking' ? 'layerStatusChecking'
      : status === 'unavailable' ? 'layerStatusUnavailable'
      : status === 'idle' ? 'layerStatusReady' : 'layerStatusArchitecture'

  return (
    <motion.div variants={layerItemVariants} data-layer-status={status} className="login-layer-row">
      <span className="login-layer-node" aria-hidden="true">
        {isOk ? (
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M3 8.5l3.2 3.2L13 4.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : isFail ? <XIcon size={13} strokeWidth={2.5} /> : <span className="login-layer-core" />}
      </span>
      <span className="login-layer-copy">
        <span className="login-layer-name">{t(layer.nameKey)}</span>
        <span className="login-layer-description">{t(layer.descKey)}</span>
      </span>
      <span className="login-layer-status">{t(statusKey)}</span>
    </motion.div>
  )
}

export function Login({ t, lang, setLang, theme, resolvedTheme = theme, setTheme, onAuthed }) {
  const reduced = useReducedMotion()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  // ⚠️ เก็บเป็น "คีย์ข้อความ" ไม่ใช่ boolean โดยเจตนา — boolean คือต้นเหตุของบั๊กเดิม:
  //    เมื่อมีแค่ error=true จอนี้ไม่เหลือทางเลือกอื่นนอกจากเดาว่า "รหัสผ่านผิด"
  //    ทั้งที่ความล้มเหลวส่วนใหญ่ไม่เคยไปถึงขั้นตอนตรวจรหัสผ่านด้วยซ้ำ
  const [errorKey, setErrorKey] = useState(null)
  const [lockSec, setLockSec] = useState(0)
  const [shake, setShake] = useState(false)
  const [leaving, setLeaving] = useState(false)
  // Only Layer 1 represents a measured result from /api/login. Other layers
  // describe architecture; a login response cannot verify storage or network.
  const [statuses, setStatuses] = useState(['info', 'idle', 'info', 'info'])
  const [fieldPhase, setFieldPhase] = useState('idle')
  const busyRef = useRef(false)
  const shakeTimerRef = useRef(null)
  const welcomeAsset = import.meta.env.BASE_URL + themeAssetsFor(resolvedTheme).welcome

  useEffect(() => () => clearTimeout(shakeTimerRef.current), [])

  const setLayer = (i, s) =>
    setStatuses((prev) => prev.map((v, idx) => (idx === i ? s : v)))

  async function submit() {
    if (busyRef.current || !username || !password) return
    busyRef.current = true
    setBusy(true)
    setErrorKey(null)
    setStatuses(['info', 'checking', 'info', 'info'])
    setFieldPhase('checking')

    const step = reduced ? 0 : 250
    const authPromise = login({ username, password, remember })
    await sleep(step)
    const res = await authPromise

    if (!res.ok) {
      const locked = res.status === 429
      setLayer(1, res.status === 401 || res.status === 429 ? 'fail' : 'unavailable')
      setFieldPhase('error')
      setShake(true)
      setErrorKey(loginErrorKey(res))
      setLockSec(locked ? Math.ceil((res.lockedMs ?? 0) / 1000) : 0)
      clearTimeout(shakeTimerRef.current)
      shakeTimerRef.current = setTimeout(() => setShake(false), 300)
      setBusy(false)
      busyRef.current = false
      return
    }

    setLockSec(0)
    setLayer(1, 'ok')
    setFieldPhase('success')
    await sleep(reduced ? 0 : 180)
    setLeaving(true)
    await sleep(reduced ? 0 : 240)
    onAuthed({ user: res.user, menu: res.menu })
  }

  return (
    <div className="login-shell min-h-screen w-full flex flex-col items-center justify-center p-4 md:p-6 bg-canvas text-ink font-sans relative overflow-hidden transition-colors duration-[var(--dur-base)]">
      <div
        className="gate-bg absolute inset-0 pointer-events-none"
        style={{ '--gate-image': `url("${welcomeAsset}")` }}
        aria-hidden
      />
      <div className="gate-halo absolute inset-0 pointer-events-none" aria-hidden />
      <div className="login-dot-field absolute inset-0 pointer-events-none" aria-hidden="true" />

      {/* Top right language selector and theme toggle */}
      <div className="login-top-controls absolute top-5 right-5 z-30 flex items-center gap-2">
        <ThemeToggle theme={resolvedTheme} setTheme={setTheme} t={t} />
        <Segmented
          ariaLabel={t('language')}
          options={LANGS.map((l) => ({ value: l, label: l.toUpperCase() }))}
          value={lang}
          onChange={setLang}
        />
      </div>

      {/* Main sign-in surface */}
      <main className="login-security-field relative my-auto w-full max-w-[440px] md:max-w-[960px] z-10" data-security-field data-motion={reduced ? 'reduced' : 'full'} data-phase={fieldPhase}>
        <div className="login-field-aura" data-field-aura aria-hidden="true" />
        <div className="login-field-trace" data-field-trace aria-hidden="true" />
        {/* Split sign-in card */}
        <motion.div
          initial={reduced ? false : { scale: 0.985, opacity: 0, y: 10 }}
          animate={{
            scale: leaving ? 1.03 : 1,
            opacity: leaving ? 0 : 1,
            y: 0,
          }}
          transition={reduced ? { duration: 0 } : { duration: 0.32, ease: [0.32, 0.72, 0, 1] }}
          className="login-card w-full overflow-hidden flex flex-col md:flex-row md:items-stretch relative"
        >
          {/* Left Panel: restrained brand lockup */}
          <div className="login-brand-panel w-full md:w-[42%] p-6 md:p-12 flex flex-col items-center justify-center text-center relative">
            <div className="login-brand-lockup my-auto flex flex-col items-center">
              <div className="login-mark-stage relative flex items-center justify-center">
                <AegisMark size={180} theme={resolvedTheme} className="login-mark" />
              </div>
              <div className="login-brand-text">
                <h1 lang="en" className="login-brand-name mt-3 text-3xl md:text-4xl font-bold tracking-tight leading-none">
                  AEGIS
                </h1>
                <p lang="en" className="login-brand-tag mt-3 text-xs font-semibold tracking-widest uppercase text-balance leading-relaxed">
                  {t('productTag')}
                </p>
              </div>
            </div>
          </div>

          {/* Right Panel: Sign-In Form */}
          <div className="login-form-panel w-full md:flex-1 p-6 md:p-10 flex flex-col justify-between">
            <div>
              <h2 className="login-title text-2xl font-bold tracking-tight">{t('loginTitle')}</h2>
              <p className="login-subtitle text-sm mt-1 mb-6">{t('loginSubtitle')}</p>

              <form onSubmit={(event) => { event.preventDefault(); submit() }} className={`login-form flex flex-col gap-4 ${shake ? 'shake-x' : ''}`}>
                <div>
                  <label htmlFor="login-username" className="login-label block text-sm font-medium mb-1.5">
                    {t('username')}
                  </label>
                  <input
                    id="login-username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={t('usernamePlaceholder')}
                    autoComplete="username"
                    disabled={busy}
                    required
                    className="login-input w-full h-12 px-4 rounded-xl focus:outline-none text-base"
                  />
                </div>

                <div>
                  <label htmlFor="login-password" className="login-label block text-sm font-medium mb-1.5">
                    {t('password')}
                  </label>
                  <div className="relative">
                    <input
                      id="login-password"
                      type={showPw ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={t('passwordPlaceholder')}
                      autoComplete="current-password"
                      disabled={busy}
                      required
                      className="login-input w-full h-12 px-4 pr-14 rounded-xl focus:outline-none text-base"
                    />
                    <button
                      type="button"
                      aria-label={showPw ? t('hidePassword') : t('showPassword')}
                      onClick={() => setShowPw((v) => !v)}
                      className="login-password-toggle absolute right-1 top-1/2 -translate-y-1/2 size-11 flex items-center justify-center rounded-lg transition-colors cursor-pointer"
                    >
                      {showPw ? <EyeOff size={16} strokeWidth={1.75} /> : <Eye size={16} strokeWidth={1.75} />}
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between py-1">
                  <span className="login-label text-sm font-medium">
                    {t('rememberSession')}
                  </span>
                  <Toggle on={remember} onChange={setRemember} label={t('rememberSession')} />
                </div>

                <SparkleButton
                  type="submit"
                  size="lg"
                  className="login-submit w-full mt-2"
                  disabled={busy || !username || !password}
                >
                  {busy ? t('signingIn') : t('signIn')}
                </SparkleButton>

                {errorKey && (
                  <p role="alert" aria-live="assertive" className="login-error text-sm font-semibold text-center mt-2">
                    {errorKey === 'lockout' ? t('lockout', { s: lockSec }) : t(errorKey)}
                  </p>
                )}
              </form>
            </div>

            {/* Defense-in-Depth Security Status Layers with Staggered Entrance */}
            <motion.div
              variants={layersContainerVariants}
              initial={reduced ? false : 'hidden'}
              animate="show"
              className="login-layers flex flex-col gap-2 mt-6 pt-5"
            >
              {LAYERS.map((layer, i) => (
                <LayerRow key={layer.id} t={t} layer={layer} status={statuses[i]} />
              ))}
            </motion.div>
          </div>
        </motion.div>
      </main>
    </div>
  )
}
