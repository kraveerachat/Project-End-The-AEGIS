import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Eye, EyeOff, X as XIcon } from 'lucide-react'
import { login } from '../lib/auth.js'
import { useMediaQuery, useReducedMotion } from '../lib/hooks.js'
import { Field, PillInput, SparkleButton, Toggle } from '../components/ui.jsx'
import { EASE, SPRING } from '../lib/motion.js'

/* Defense-in-depth rows. Layer 0 (network) is already satisfied — the
   client reached this page through VPN+VLAN. Layers 2–3 are hatched:
   "not yet real". The submit cascade IS the loading state — no spinner. */
const LAYERS = [
  { id: 0, nameKey: 'layerNetwork', descKey: 'layerNetworkDesc' },
  { id: 1, nameKey: 'layerApp', descKey: 'layerAppDesc' },
  { id: 2, nameKey: 'layerStorage', descKey: 'layerStorageDesc' },
  { id: 3, nameKey: 'layerMeta', descKey: 'layerMetaDesc' },
]

// Rate limiting — 5 ครั้งติดกันแล้วล็อก 30 วินาที
// ⚠️ นี่คือมารยาทต่อผู้ใช้ฝั่ง client เท่านั้น ระบบจริง "ต้อง" บังคับฝั่ง
// เซิร์ฟเวอร์ด้วย เพราะ attacker ที่ไม่รัน JS ของเรา ข้ามการล็อกนี้ได้ทันที
const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 30_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* Panel entrance: the form staggers in while the vault card is still
   settling — title first, cascade last. Exits are handled by the
   whole gate (App), so children only ever animate in. */
const staggerParent = {
  hidden: {},
  show: { transition: { staggerChildren: 0.045, delayChildren: 0.16 } },
}
const staggerChild = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE } },
}

/**
 * One row of the readout — a stepper node on a spine, then a ruled line
 * of mono label + description. No fill, no pill: the state is carried by
 * ink colour, the node glyph, and whether the hatch is still there.
 *
 * `isLast` suppresses the connector; `flows` colours the connector below
 * this node once the layer has passed, so the spine fills downward as the
 * server's answer arrives — the cascade IS the loading state.
 */
function LayerRow({ t, layer, status, isLast }) {
  // status: 'ok' | 'active' | 'pending' | 'fail'
  const isOk = status === 'ok'
  const isFail = status === 'fail'
  const isPending = status === 'pending'
  const isActive = status === 'active'

  const labelColor = isOk || isActive ? 'var(--ink)' : isFail ? 'var(--danger)' : 'var(--ink-3)'

  return (
    <div className="relative grid grid-cols-[16px_1fr] gap-3">
      {/* ── the spine ──────────────────────────────────────────────
          The connector is drawn from this node's centre to the next
          one's; the node's own bg-card disc masks the line behind it,
          so one element gives both the rule and the gap. */}
      <div className="relative h-[34px] flex items-center justify-center">
        {!isLast && (
          <span
            aria-hidden
            className="absolute left-1/2 top-1/2 w-px h-[34px] -translate-x-1/2 transition-colors duration-(--dur-base)"
            style={{
              background: isOk ? 'var(--ok)' : 'var(--line)',
              opacity: isOk ? 0.45 : 1,
              transitionTimingFunction: 'var(--ease)',
            }}
          />
        )}
        <span className="relative bg-card size-4 flex items-center justify-center shrink-0">
          {isOk && (
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
              <path d="M3 8.5l3.2 3.2L13 4.5" fill="none" stroke="var(--ok)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="draw-check" />
            </svg>
          )}
          {isFail && <XIcon size={13} strokeWidth={2.5} style={{ color: 'var(--danger)' }} />}
          {isActive && <span className="size-2 rounded-full border-2 pulse-node" style={{ borderColor: 'var(--accent)' }} />}
          {/* pending nodes are hollow and hatch-grey — nothing has happened here yet */}
          {isPending && <span className="size-1.5 rotate-45 border" style={{ borderColor: 'var(--ink-3)' }} />}
        </span>
      </div>

      {/* ── the readout line ─────────────────────────────────────── */}
      <div className={`relative overflow-hidden flex items-center gap-3 h-[34px] min-w-0 ${isLast ? '' : 'border-b border-line'}`}>
        {/* hatch — wipes away left→right the moment the layer resolves */}
        <div
          aria-hidden
          className="absolute inset-0 hatch-fine pointer-events-none transition-[clip-path] duration-500"
          style={{
            clipPath: isPending ? 'inset(0 0 0 0)' : 'inset(0 0 0 100%)',
            transitionTimingFunction: 'var(--ease)',
          }}
        />
        <span
          className="relative font-mono text-[10px] font-medium tracking-[0.1em] whitespace-nowrap transition-colors duration-(--dur-base)"
          style={{ color: labelColor }}
        >
          {t(layer.nameKey)}
        </span>
        {/* The description is the layer's mechanism, not its state — so it is
            the first thing to go when the panel is too narrow to hold it.
            Below ~260px of readout it truncates to noise ("Encryptio…",
            "Cred…"); the layer name and node still carry the full status. */}
        <span className={`relative text-[11.5px] truncate ml-auto hidden @min-[260px]:block ${isPending ? 'text-ink-3' : 'text-ink-2'}`}>
          {t(layer.descKey)}
        </span>
      </div>
    </div>
  )
}

/**
 * Screen 2 — the lock, rendered as the right panel of the expanded
 * vault card (bottom panel below `md`). On success the cascade
 * resolves and we hand the server-decided user object up to App,
 * which exits the whole gate and shows the Hub. On failure the
 * cascade stops dead at Layer 1 and Layers 2–3 stay hatched.
 */
export function Login({ t, onAuthed }) {
  const reduced = useReducedMotion()
  const isMd = useMediaQuery('(min-width: 768px)')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [shake, setShake] = useState(false)
  // L0 passed on arrival (VPN+VLAN), L1 is where credentials land, L2–L3 hatched
  const [statuses, setStatuses] = useState(['ok', 'active', 'pending', 'pending'])
  const [fails, setFails] = useState(0)
  const [lockedUntil, setLockedUntil] = useState(0)
  const [nowTick, setNowTick] = useState(Date.now())
  const busyRef = useRef(false)

  const locked = lockedUntil > nowTick
  const lockSeconds = Math.max(0, Math.ceil((lockedUntil - nowTick) / 1000))

  // tick the lockout countdown once a second while locked
  useEffect(() => {
    if (!locked) return
    const id = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [locked])

  const setLayer = (i, s) =>
    setStatuses((prev) => prev.map((v, idx) => (idx === i ? s : v)))

  async function submit() {
    if (busyRef.current || !username || !password || locked) return
    busyRef.current = true
    setBusy(true)
    setError(false)
    setStatuses(['ok', 'active', 'pending', 'pending'])

    const step = reduced ? 0 : 250
    // ส่งแค่ { username, password, remember } ไป /api/login — ไม่มี role เด็ดขาด
    const authPromise = login({ username, password, remember })
    await sleep(step) // L0 re-confirms while credentials travel
    const res = await authPromise

    if (!res.ok) {
      // การล้มเหลว "หยุดนิ่ง" ที่ Layer 1 — ชั้นที่เหลือคงเป็น hatch (ยังไม่เกิดขึ้นจริง)
      // ข้อความผิดพลาดเหมือนกันทุกกรณี — ห้ามบอกว่า field ไหนผิด ห้ามบอกว่า
      // "ไม่พบผู้ใช้" เพื่อกัน username enumeration
      setLayer(1, 'fail')
      setShake(true)
      setError(true)
      const n = fails + 1
      setFails(n)
      if (n >= MAX_ATTEMPTS) {
        setLockedUntil(Date.now() + LOCKOUT_MS)
        setNowTick(Date.now())
        setFails(0)
      }
      setTimeout(() => setShake(false), 300)
      setBusy(false)
      busyRef.current = false
      return
    }

    // Success: the cascade resolves top-to-bottom, hatch wiping away —
    // ONLY now; the layers gate on the server's answer, never on the click.
    setFails(0)
    setLayer(1, 'ok')
    await sleep(step)
    setLayer(2, 'ok')
    await sleep(step)
    setLayer(3, 'ok')
    await sleep(reduced ? 0 : 350)
    // The vault's exit animation (App's AnimatePresence) is the leaving
    // state — hand the server-decided user AND the role-filtered menu up,
    // then let the gate close. Both come from the server; client only reads them.
    onAuthed({ user: res.user, menu: res.menu })
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter') submit()
  }

  return (
    <motion.div
      layout
      transition={{ ...SPRING, delay: 0.08 }}
      className="w-full md:flex-1 min-w-0 border-line border-t md:border-t-0 md:border-l"
      initial={{ opacity: 0, x: isMd ? 56 : 0, y: isMd ? 0 : 28 }}
      animate={{
        opacity: 1,
        x: 0,
        y: 0,
        transition: { ...SPRING, delay: 0.08, opacity: { duration: 0.35, ease: EASE, delay: 0.08 } },
      }}
    >
      {/* shake lives on a plain div so the CSS keyframes never fight
          framer's inline transforms */}
      <motion.div
        variants={staggerParent}
        initial="hidden"
        animate="show"
        className={`p-8 md:p-10 ${shake ? 'shake-x' : ''}`}
      >
        <motion.div variants={staggerChild}>
          <h2 className="text-[20px] font-semibold text-ink">{t('loginTitle')}</h2>
          <p className="text-[13px] text-ink-3 mt-0.5">{t('loginSubtitle')}</p>
        </motion.div>

        <div className="flex flex-col gap-4 mt-6">
          <motion.div variants={staggerChild}>
            <Field id="login-username" label={t('username')}>
              <PillInput
                id="login-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={t('usernamePlaceholder')}
                autoComplete="username"
                autoFocus
                disabled={busy}
              />
            </Field>
          </motion.div>

          <motion.div variants={staggerChild}>
            <Field id="login-password" label={t('password')}>
              <div className="relative">
                <PillInput
                  id="login-password"
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder={t('passwordPlaceholder')}
                  autoComplete="current-password"
                  disabled={busy}
                  className="pr-12"
                />
                <button
                  type="button"
                  aria-label={showPw ? t('hidePassword') : t('showPassword')}
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 size-9 flex items-center justify-center rounded-full text-ink-3 hover:text-ink hover:bg-card transition-colors duration-(--dur-fast) cursor-pointer"
                >
                  {showPw ? <EyeOff size={17} strokeWidth={1.5} /> : <Eye size={17} strokeWidth={1.5} />}
                </button>
              </div>
            </Field>
          </motion.div>

          <motion.div variants={staggerChild} className="flex items-center justify-between py-1">
            <span className="text-[13px] text-ink-2">{t('rememberSession')}</span>
            <Toggle on={remember} onChange={setRemember} label={t('rememberSession')} />
          </motion.div>

          {/* ไม่มีตัวเลือก role ที่นี่โดยเจตนา — role มาจากคำตอบของเซิร์ฟเวอร์
              เท่านั้น การให้ client เลือกสิทธิ์เอง = Broken Access Control (OWASP A01) */}
          <motion.div variants={staggerChild}>
            <SparkleButton
              sparkles="hover"
              size="lg"
              className="w-full"
              onClick={submit}
              disabled={busy || !username || !password || locked}
            >
              {busy ? t('signingIn') : t('signIn')}
            </SparkleButton>
          </motion.div>

          {(error || locked) && (
            <p role="alert" aria-live="assertive" className="text-[13px] font-medium text-center" style={{ color: 'var(--danger)' }}>
              {locked ? t('lockout', { s: lockSeconds }) : t('loginFailed')}
            </p>
          )}
        </div>

        {/* Defense-in-depth — the cascade is the whole loading state.
            Rows stack flush: the hairline rules and the spine do the
            separating, so it reads as one instrument, not four chips. */}
        <motion.div variants={staggerChild} className="@container flex flex-col mt-7">
          {LAYERS.map((layer, i) => (
            <LayerRow key={layer.id} t={t} layer={layer} status={statuses[i]} isLast={i === LAYERS.length - 1} />
          ))}
        </motion.div>
      </motion.div>
    </motion.div>
  )
}
