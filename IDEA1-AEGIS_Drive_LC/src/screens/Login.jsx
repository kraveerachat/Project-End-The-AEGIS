import { useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Eye, EyeOff, X as XIcon } from 'lucide-react'
import { login } from '../lib/auth.js'
import { useReducedMotion } from '../lib/hooks.js'
import { Toggle, Segmented, SparkleButton, ThemeToggle } from '../components/ui.jsx'
import { AegisMark } from '../components/AegisMark.jsx'
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

export function Login({ t, lang, setLang, theme, setTheme, onAuthed }) {
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
    <div className="min-h-screen w-full flex flex-col items-center justify-center p-4 md:p-6 bg-slate-100 dark:bg-[#08080A] text-slate-900 dark:text-slate-100 font-sans select-none relative overflow-hidden transition-colors duration-300">
      {/* Base dot grid pattern overlay */}
      <div className="absolute inset-0 bg-[radial-gradient(#cbd5e1_1px,transparent_1px)] dark:bg-[radial-gradient(#1e293b_1px,transparent_1px)] [background-size:16px_16px] opacity-70 dark:opacity-30 pointer-events-none" />

      {/* Background image circuit/streak texture overlay */}
      <div className="absolute inset-0 gate-bg opacity-30 dark:opacity-60 pointer-events-none" />

      {/* Ambient glowing radial beam behind card */}
      <motion.div
        animate={{
          scale: [1, 1.08, 1],
          opacity: [0.4, 0.7, 0.4],
        }}
        transition={{
          duration: 5,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[300px] bg-gradient-to-r from-cyan-400/20 via-blue-500/20 to-transparent dark:from-blue-500/14 dark:via-sky-500/12 dark:to-transparent blur-3xl pointer-events-none opacity-50 dark:opacity-100"
      />

      {/* Horizontal glowing energy line running across screen width */}
      <motion.div
        animate={{
          x: [-20, 20, -20],
          opacity: [0.4, 0.8, 0.4],
        }}
        transition={{
          duration: 6,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
        className="absolute top-1/2 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-cyan-500/50 dark:via-blue-400/40 to-transparent blur-[1px] pointer-events-none"
      />

      {/* Subtle halo backdrop */}
      <div className="absolute inset-0 gate-halo pointer-events-none opacity-20 dark:opacity-90" />

      {/* Top right language selector and theme toggle */}
      <div className="absolute top-5 right-5 z-30 flex items-center gap-2">
        <ThemeToggle theme={theme} setTheme={setTheme} t={t} />
        <Segmented
          ariaLabel={t('language')}
          options={LANGS.map((l) => ({ value: l, label: l.toUpperCase() }))}
          value={lang}
          onChange={setLang}
        />
      </div>

      {/* Main Vault Card Container Wrapper with Volumetric Aura */}
      <div className="relative my-auto w-full max-w-[440px] md:max-w-[920px] flex justify-center z-10">
        {/* Volumetric Aura Background Glow Layer */}
        <motion.div
          animate={{
            opacity: [0.6, 0.9, 0.6],
            scale: [0.99, 1.025, 0.99],
          }}
          transition={{
            duration: 4,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
          className="absolute -inset-2 -z-10 rounded-[32px] bg-gradient-to-r from-cyan-400 via-sky-400 to-blue-500 dark:from-blue-600/30 dark:via-blue-500/24 dark:to-sky-500/16 opacity-70 blur-2xl shadow-[0_0_70px_15px_rgba(6,182,212,0.35)] dark:shadow-[0_0_34px_2px_rgba(37,99,235,0.2)] pointer-events-none transition-all duration-500"
        />

        {/* Main Floating Split Vault Card */}
        <motion.div
          initial={{ scale: 0.96, opacity: 0, y: 15 }}
          animate={{
            scale: leaving ? 1.03 : 1,
            opacity: leaving ? 0 : 1,
            y: 0,
          }}
          transition={{
            type: 'spring',
            stiffness: 260,
            damping: 20,
          }}
          whileHover={{ y: -4 }}
          whileTap={{ scale: 0.995 }}
          className={`w-full rounded-3xl bg-white/95 dark:bg-[#0C0D12]/90 border border-cyan-400/80 hover:border-blue-400 dark:border-blue-400/45 dark:hover:border-sky-300 shadow-[0_10px_35px_-5px_rgba(14,165,233,0.25)] dark:shadow-[0_0_26px_-8px_rgba(59,130,246,0.28)] backdrop-blur-2xl overflow-hidden flex flex-col md:flex-row md:items-stretch relative transition-all duration-300 ${
            shake ? 'shake-x' : ''
          }`}
        >
          {/* Left Panel: Brand Lockup with Breathing Backlight */}
          <div className="w-full md:w-[42%] p-8 md:p-12 flex flex-col items-center justify-center text-center bg-slate-50/90 dark:bg-[#07080B] border-b md:border-b-0 md:border-r border-cyan-500/20 dark:border-blue-500/20 relative">
            <div className="my-auto flex flex-col items-center">
              <div className="relative flex items-center justify-center">
                <motion.div
                  animate={{
                    scale: [1, 1.15, 1],
                    opacity: [0.3, 0.6, 0.3],
                  }}
                  transition={{
                    duration: 4,
                    repeat: Infinity,
                    ease: 'easeInOut',
                  }}
                  className="absolute inset-0 rounded-full bg-gradient-to-r from-cyan-400/20 via-blue-500/20 to-blue-600/20 dark:from-sky-400/12 dark:via-blue-500/12 dark:to-blue-600/10 blur-2xl pointer-events-none"
                />
                <AegisMark size={180} />
              </div>
              <h1 lang="en" className="mt-4 text-3xl md:text-4xl font-bold tracking-tight text-slate-900 dark:text-white leading-none">
                AEGIS
              </h1>
              <p lang="en" className="mt-3 text-[11px] md:text-xs font-semibold tracking-widest uppercase text-balance leading-relaxed bg-clip-text text-transparent bg-gradient-to-r from-cyan-600 via-blue-600 to-blue-700 dark:from-sky-300 dark:via-blue-300 dark:to-blue-400">
                {t('productTag')}
              </p>
            </div>
          </div>

          {/* Right Panel: Sign-In Form */}
          <div className="w-full md:flex-1 p-6 md:p-10 flex flex-col justify-between bg-white/40 dark:bg-slate-900/40">
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
                    className="w-full h-11 px-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 hover:border-cyan-400/80 dark:border-slate-800 dark:hover:border-blue-500/50 text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:bg-white dark:focus:bg-slate-950 focus:outline-none focus:border-cyan-500 dark:focus:border-blue-400 focus:ring-2 focus:ring-cyan-500/40 dark:focus:ring-blue-500/45 focus:shadow-[0_0_25px_rgba(6,182,212,0.4)] dark:focus:shadow-[0_0_16px_rgba(59,130,246,0.3)] transition-all duration-300 text-sm"
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
                      className="w-full h-11 px-4 pr-12 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 hover:border-cyan-400/80 dark:border-slate-800 dark:hover:border-blue-500/50 text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:bg-white dark:focus:bg-slate-950 focus:outline-none focus:border-cyan-500 dark:focus:border-blue-400 focus:ring-2 focus:ring-cyan-500/40 dark:focus:ring-blue-500/45 focus:shadow-[0_0_25px_rgba(6,182,212,0.4)] dark:focus:shadow-[0_0_16px_rgba(59,130,246,0.3)] transition-all duration-300 text-sm"
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
                  sparkles="hover"
                  size="lg"
                  className="w-full mt-2 hover:shadow-[0_0_25px_rgba(37,99,235,0.45)] hover:scale-[1.01] active:scale-[0.98] transition-all duration-300"
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
