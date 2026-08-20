import { useRef, useState } from 'react'
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

  if (layer.id === 0) {
    return (
      <motion.div variants={layerItemVariants} className="flex items-center justify-between gap-3 h-10 px-4 rounded-xl border border-emerald-500/40 dark:border-emerald-500/30 text-emerald-800 dark:text-emerald-400 bg-emerald-50/70 dark:bg-emerald-950/20 text-xs font-semibold">
        <div className="flex items-center gap-2.5">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden className="text-emerald-600 dark:text-emerald-400">
            <path d="M3 8.5l3.2 3.2L13 4.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="font-bold tracking-wide">{t(layer.nameKey)}</span>
        </div>
        <span className="text-[11px] font-mono opacity-90">{t(layer.descKey)}</span>
      </motion.div>
    )
  }

  if (layer.id === 1) {
    return (
      <motion.div variants={layerItemVariants} className="flex items-center justify-between gap-3 h-10 px-4 rounded-xl border border-blue-600/80 dark:border-blue-400/70 text-blue-800 dark:text-blue-300 bg-blue-50/70 dark:bg-blue-950/20 text-xs font-semibold">
        <div className="flex items-center gap-2.5">
          {isOk ? (
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden className="text-emerald-600 dark:text-emerald-400">
              <path d="M3 8.5l3.2 3.2L13 4.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : isFail ? (
            <XIcon size={14} strokeWidth={2.5} className="text-rose-500" />
          ) : (
            <span className="size-2 rounded-full border-2 border-cyan-500 dark:border-blue-400 animate-pulse" />
          )}
          <span className="font-bold tracking-wide">{t(layer.nameKey)}</span>
        </div>
        <span className="text-[11px] font-mono text-slate-600 dark:text-slate-400">{t(layer.descKey)}</span>
      </motion.div>
    )
  }

  return (
    <motion.div variants={layerItemVariants} className="relative overflow-hidden flex items-center justify-between gap-3 h-10 px-4 rounded-xl border border-cyan-500/30 dark:border-slate-600/40 text-slate-500 dark:text-slate-400 text-xs font-medium bg-slate-50/80 dark:bg-slate-950/40 bg-[repeating-linear-gradient(45deg,transparent,transparent_8px,rgba(0,0,0,0.03)_8px,rgba(0,0,0,0.03)_16px)] dark:bg-[repeating-linear-gradient(45deg,transparent,transparent_8px,rgba(255,255,255,0.03)_8px,rgba(255,255,255,0.03)_16px)]">
      <div className="flex items-center gap-2.5 relative z-10">
        {isOk ? (
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden className="text-emerald-600 dark:text-emerald-400">
            <path d="M3 8.5l3.2 3.2L13 4.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <span className="text-slate-400 dark:text-slate-500 font-mono text-[10px]">◇</span>
        )}
        <span className="font-bold tracking-wide">{t(layer.nameKey)}</span>
      </div>
      <span className="text-[11px] font-mono text-slate-400 dark:text-slate-500 relative z-10">{t(layer.descKey)}</span>
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
  const [statuses, setStatuses] = useState(['ok', 'active', 'pending', 'pending'])
  const busyRef = useRef(false)
  const welcomeAsset = import.meta.env.BASE_URL + themeAssetsFor(resolvedTheme).welcome

  const setLayer = (i, s) =>
    setStatuses((prev) => prev.map((v, idx) => (idx === i ? s : v)))

  async function submit() {
    if (busyRef.current || !username || !password) return
    busyRef.current = true
    setBusy(true)
    setErrorKey(null)
    setStatuses(['ok', 'active', 'pending', 'pending'])

    const step = reduced ? 0 : 250
    const authPromise = login({ username, password, remember })
    await sleep(step)
    const res = await authPromise

    if (!res.ok) {
      const locked = res.status === 429
      setLayer(1, 'fail')
      setShake(true)
      setErrorKey(loginErrorKey(res))
      setLockSec(locked ? Math.ceil((res.lockedMs ?? 0) / 1000) : 0)
      setTimeout(() => setShake(false), 300)
      setBusy(false)
      busyRef.current = false
      return
    }

    setLockSec(0)
    setLayer(1, 'ok')
    await sleep(step)
    setLayer(2, 'ok')
    await sleep(step)
    setLayer(3, 'ok')
    await sleep(reduced ? 0 : 350)
    setLeaving(true)
    await sleep(reduced ? 0 : 380)
    onAuthed({ user: res.user, menu: res.menu })
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter') submit()
  }

  return (
    <div className="login-shell min-h-screen w-full flex flex-col items-center justify-center p-4 md:p-6 bg-canvas text-ink font-sans select-none relative overflow-hidden transition-colors duration-[var(--dur-base)]">
      <div
        className="gate-bg absolute inset-0 pointer-events-none"
        style={{ '--gate-image': `url("${welcomeAsset}")` }}
        aria-hidden
      />
      <div className="gate-halo absolute inset-0 pointer-events-none" aria-hidden />

      {/* Top right language selector and theme toggle */}
      <div className="absolute top-5 right-5 z-30 flex items-center gap-2">
        <ThemeToggle theme={resolvedTheme} setTheme={setTheme} t={t} />
        <Segmented
          ariaLabel={t('language')}
          options={LANGS.map((l) => ({ value: l, label: l.toUpperCase() }))}
          value={lang}
          onChange={setLang}
        />
      </div>

      {/* Main sign-in surface */}
      <div className="relative my-auto w-full max-w-[440px] md:max-w-[920px] flex justify-center z-10">
        {/* Split sign-in card */}
        <motion.div
          initial={reduced ? false : { scale: 0.985, opacity: 0, y: 10 }}
          animate={{
            scale: leaving ? 1.03 : 1,
            opacity: leaving ? 0 : 1,
            y: 0,
          }}
          transition={reduced ? { duration: 0 } : { duration: 0.32, ease: [0.32, 0.72, 0, 1] }}
          className={`w-full rounded-[var(--r-card)] bg-card border border-line overflow-hidden flex flex-col md:flex-row md:items-stretch relative transition-colors duration-[var(--dur-base)] ${
            shake ? 'shake-x' : ''
          }`}
          style={{ boxShadow: 'var(--elev-2)' }}
        >
          {/* Left Panel: restrained brand lockup */}
          <div className="w-full md:w-[42%] p-8 md:p-12 flex flex-col items-center justify-center text-center bg-sunken border-b md:border-b-0 md:border-r border-line relative">
            <div className="my-auto flex flex-col items-center">
              <div className="relative flex items-center justify-center">
                <AegisMark size={180} theme={resolvedTheme} />
              </div>
              <h1 lang="en" className="mt-4 text-3xl md:text-4xl font-bold tracking-tight text-slate-900 dark:text-white leading-none">
                AEGIS
              </h1>
              <p lang="en" className="mt-3 text-[11px] md:text-xs font-semibold tracking-widest uppercase text-balance leading-relaxed text-blue-700 dark:text-blue-300">
                {t('productTag')}
              </p>
            </div>
          </div>

          {/* Right Panel: Sign-In Form */}
          <div className="w-full md:flex-1 p-6 md:p-10 flex flex-col justify-between bg-card">
            <div>
              <h2 className="text-2xl font-bold text-slate-900 dark:text-white tracking-tight">{t('loginTitle')}</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 mb-6">{t('loginSubtitle')}</p>

              <div className="flex flex-col gap-4">
                <div>
                  <label htmlFor="login-username" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    {t('username')}
                  </label>
                  <input
                    id="login-username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder={t('usernamePlaceholder')}
                    autoComplete="username"
                    autoFocus
                    disabled={busy}
                    className="w-full h-11 px-4 rounded-xl bg-sunken border border-line text-ink placeholder:text-ink-3 focus:bg-card focus:outline-none transition-colors duration-[var(--dur-fast)] text-sm"
                  />
                </div>

                <div>
                  <label htmlFor="login-password" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    {t('password')}
                  </label>
                  <div className="relative">
                    <input
                      id="login-password"
                      type={showPw ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyDown={onKeyDown}
                      placeholder={t('passwordPlaceholder')}
                      autoComplete="current-password"
                      disabled={busy}
                      className="w-full h-11 px-4 pr-12 rounded-xl bg-sunken border border-line text-ink placeholder:text-ink-3 focus:bg-card focus:outline-none transition-colors duration-[var(--dur-fast)] text-sm"
                    />
                    <button
                      type="button"
                      aria-label={showPw ? t('hidePassword') : t('showPassword')}
                      onClick={() => setShowPw((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 size-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-200/60 dark:hover:bg-slate-800/60 transition-all duration-200 cursor-pointer"
                    >
                      {showPw ? <EyeOff size={16} strokeWidth={1.75} /> : <Eye size={16} strokeWidth={1.75} />}
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between py-1">
                  <span className="text-sm text-slate-700 dark:text-slate-300 font-medium">
                    {t('rememberSession')}
                  </span>
                  <Toggle on={remember} onChange={setRemember} label={t('rememberSession')} />
                </div>

                <SparkleButton
                  size="lg"
                  className="w-full mt-2"
                  onClick={submit}
                  disabled={busy || !username || !password}
                >
                  {busy ? t('signingIn') : t('signIn')}
                </SparkleButton>

                {errorKey && (
                  <p role="alert" aria-live="assertive" className="text-xs font-semibold text-center mt-2 text-rose-600 dark:text-rose-400">
                    {errorKey === 'lockout' ? t('lockout', { s: lockSec }) : t(errorKey)}
                  </p>
                )}
              </div>
            </div>

            {/* Defense-in-Depth Security Status Layers with Staggered Entrance */}
            <motion.div
              variants={layersContainerVariants}
              initial="hidden"
              animate="show"
              className="flex flex-col gap-2 mt-6 border-t border-slate-200/80 dark:border-slate-800/80 pt-5"
            >
              {LAYERS.map((layer, i) => (
                <LayerRow key={layer.id} t={t} layer={layer} status={statuses[i]} />
              ))}
            </motion.div>
          </div>
        </motion.div>
      </div>

      {/* Monospace Footer Demo Hint */}
      <div className="relative z-10 mt-6 text-center">
        <p className="text-xs text-slate-400 dark:text-slate-500 font-mono tracking-wider">
          demo · Drive · user / aegis-drive-user · admin / aegis-drive-admin
        </p>
      </div>
    </div>
  )
}
