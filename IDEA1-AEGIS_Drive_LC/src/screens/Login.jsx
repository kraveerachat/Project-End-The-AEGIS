import { useRef, useState } from 'react'
import { Eye, EyeOff, Check, X as XIcon } from 'lucide-react'
import { authenticate } from '../lib/auth.js'
import { useReducedMotion } from '../lib/hooks.js'
import { Btn, Field, PillInput, Toggle, Segmented } from '../components/ui.jsx'
import { AegisMark } from '../components/AegisMark.jsx'
import { LANGS } from '../lib/strings.js'

/* Defense-in-depth rows. Layer 0 (network) is already satisfied — the
   client reached this page through VPN+VLAN. Layers 2–3 are hatched:
   "not yet real". The submit cascade IS the loading state — no spinner. */
const LAYERS = [
  { id: 0, nameKey: 'layerNetwork', descKey: 'layerNetworkDesc' },
  { id: 1, nameKey: 'layerApp', descKey: 'layerAppDesc' },
  { id: 2, nameKey: 'layerStorage', descKey: 'layerStorageDesc' },
  { id: 3, nameKey: 'layerMeta', descKey: 'layerMetaDesc' },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function LayerRow({ t, layer, status }) {
  // status: 'ok' | 'active' | 'pending' | 'fail'
  const isOk = status === 'ok'
  const isFail = status === 'fail'
  const isPending = status === 'pending'
  return (
    <div
      className="relative overflow-hidden flex items-center gap-3 h-11 px-4 rounded-full border transition-colors duration-[var(--dur-base)]"
      style={{
        background: isOk ? 'var(--ok-soft)' : isFail ? 'var(--danger-soft)' : 'var(--card-sunken)',
        borderColor: isOk || isFail ? 'transparent' : 'var(--line)',
      }}
    >
      {/* hatch overlay — wipes away left→right when the layer resolves */}
      <div
        aria-hidden
        className="absolute inset-0 hatch hatch-ink3 pointer-events-none transition-[clip-path] duration-500"
        style={{
          clipPath: isPending ? 'inset(0 0 0 0)' : 'inset(0 0 0 100%)',
          transitionTimingFunction: 'var(--ease)',
        }}
      />
      <span className="relative size-5 flex items-center justify-center shrink-0">
        {isOk && (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <path d="M3 8.5l3.2 3.2L13 4.5" fill="none" stroke="var(--ok)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="draw-check" />
          </svg>
        )}
        {isFail && <XIcon size={15} strokeWidth={2.5} style={{ color: 'var(--danger)' }} />}
        {status === 'active' && <span className="size-2.5 rounded-full border-2" style={{ borderColor: 'var(--accent)' }} />}
        {isPending && <span className="size-2.5 rounded-[3px] border" style={{ borderColor: 'var(--ink-3)' }} />}
      </span>
      <span className="relative text-[11px] font-semibold tracking-[0.06em] whitespace-nowrap" style={{ color: isPending ? 'var(--ink-3)' : 'var(--ink)' }}>
        {t(layer.nameKey)}
      </span>
      <span className="relative text-[12px] text-ink-3 truncate ml-auto">{t(layer.descKey)}</span>
    </div>
  )
}

export function Login({ t, lang, setLang, theme, setTheme, onAuthed }) {
  const reduced = useReducedMotion()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [shake, setShake] = useState(false)
  const [leaving, setLeaving] = useState(false)
  // L0 passed on arrival (VPN+VLAN), L1 is where credentials land, L2–L3 hatched
  const [statuses, setStatuses] = useState(['ok', 'active', 'pending', 'pending'])
  const busyRef = useRef(false)

  const setLayer = (i, s) =>
    setStatuses((prev) => prev.map((v, idx) => (idx === i ? s : v)))

  async function submit() {
    if (busyRef.current || !username || !password) return
    busyRef.current = true
    setBusy(true)
    setError(false)
    setStatuses(['ok', 'active', 'pending', 'pending'])

    const step = reduced ? 0 : 250
    const authPromise = authenticate({ username, password, remember })
    await sleep(step) // L0 re-confirms while credentials travel
    const res = await authPromise

    if (!res.ok) {
      // การล้มเหลว "หยุดนิ่ง" ที่ Layer 1 — ชั้นที่เหลือคงเป็น hatch (ยังไม่เกิดขึ้นจริง)
      // ข้อความผิดพลาดเหมือนกันทุกกรณี — ห้ามบอกว่า field ไหนผิด ห้ามบอกว่า
      // "ไม่พบผู้ใช้" เพื่อกัน username enumeration
      setLayer(1, 'fail')
      setShake(true)
      setError(true)
      setTimeout(() => setShake(false), 300)
      setBusy(false)
      busyRef.current = false
      return
    }

    // Success: the cascade resolves top-to-bottom, hatch wiping away.
    setLayer(1, 'ok')
    await sleep(step)
    setLayer(2, 'ok')
    await sleep(step)
    setLayer(3, 'ok')
    await sleep(reduced ? 0 : 350)
    setLeaving(true)
    await sleep(reduced ? 0 : 380)
    onAuthed(res.user)
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter') submit()
  }

  return (
    <div className="min-h-full flex flex-col items-center justify-center py-10 px-4 bg-canvas relative">
      <div className="absolute top-5 right-5 flex items-center gap-2">
        <button
          type="button"
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
          className="size-9 flex items-center justify-center rounded-full text-ink-3 hover:text-ink hover:bg-card border border-line bg-card/40 backdrop-blur transition-all duration-[var(--dur-fast)] cursor-pointer"
        >
          {theme === 'dark' ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
          )}
        </button>
        <Segmented
          ariaLabel={t('language')}
          options={LANGS.map((l) => ({ value: l, label: l.toUpperCase() }))}
          value={lang}
          onChange={setLang}
        />
      </div>

      <div
        className="w-full flex flex-col items-center transition-[transform,opacity] duration-[var(--dur-slow)]"
        style={{
          transform: leaving ? 'scale(1.03)' : 'scale(1)',
          opacity: leaving ? 0 : 1,
          transitionTimingFunction: 'var(--ease)',
        }}
      >
        {/* The mark stands alone on the gray. Its own texture is the interest. */}
        <AegisMark size={126} />
        <h1 className="mt-7 text-[46px] font-bold tracking-[-0.02em] text-ink leading-none">AEGIS</h1>
        <p className="mt-4 text-[18px] font-medium tracking-[0.14em] text-ink-3">{t('productTag')}</p>

        <div
          className={`w-full max-w-[440px] mt-8 bg-card border border-line rounded-[24px] p-10 max-sm:p-6 ${shake ? 'shake-x' : ''}`}
          style={{ boxShadow: 'var(--elev-2)' }}
        >
          <h2 className="text-[20px] font-semibold text-ink">{t('loginTitle')}</h2>
          <p className="text-[13px] text-ink-3 mt-0.5 mb-6">{t('loginSubtitle')}</p>

          <div className="flex flex-col gap-4">
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
                  className="absolute right-2 top-1/2 -translate-y-1/2 size-9 flex items-center justify-center rounded-full text-ink-3 hover:text-ink hover:bg-card transition-colors duration-[var(--dur-fast)] cursor-pointer"
                >
                  {showPw ? <EyeOff size={17} strokeWidth={1.5} /> : <Eye size={17} strokeWidth={1.5} />}
                </button>
              </div>
            </Field>

            <div className="flex items-center justify-between py-1">
              <span className="text-[13px] text-ink-2" id="remember-label">
                {t('rememberSession')}
              </span>
              <Toggle on={remember} onChange={setRemember} label={t('rememberSession')} />
            </div>

            {/* ไม่มีตัวเลือก role ที่นี่โดยเจตนา — role มาจากคำตอบของเซิร์ฟเวอร์
                เท่านั้น การให้ client เลือกสิทธิ์เอง = Broken Access Control (OWASP A01) */}
            <Btn variant="primary" size="lg" className="w-full" onClick={submit} disabled={busy || !username || !password}>
              {busy ? t('signingIn') : t('signIn')}
            </Btn>

            {error && (
              <p role="alert" aria-live="assertive" className="text-[13px] font-medium text-center" style={{ color: 'var(--danger)' }}>
                {t('loginFailed')}
              </p>
            )}
          </div>

          {/* Defense-in-depth — the cascade is the whole loading state */}
          <div className="flex flex-col gap-2 mt-7">
            {LAYERS.map((layer, i) => (
              <LayerRow key={layer.id} t={t} layer={layer} status={statuses[i]} />
            ))}
          </div>
        </div>

        <p className="mt-6 text-[12px] text-ink-3">
          demo · <span className="font-mono">user / aegis-user</span> · <span className="font-mono">admin / aegis-admin</span>
        </p>
      </div>
    </div>
  )
}
