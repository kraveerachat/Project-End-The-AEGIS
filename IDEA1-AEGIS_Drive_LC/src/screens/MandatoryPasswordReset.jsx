import { useState } from 'react'
import { apiFetch } from '../lib/api.js'
import { AegisLockup } from '../components/AegisMark.jsx'
import { Btn, Field, HatchDefs, PillInput, SparkleButton } from '../components/ui.jsx'

// ด่านนี้บังคับใช้ must_reset_password ของบัญชี seed/บัญชีที่ได้รับรหัสชั่วคราว:
// จึงแสดงแทน shell ทั้งหมดและเก็บค่ารหัสผ่านไว้แค่ React state ในหน่วยความจำเท่านั้น
export function MandatoryPasswordReset({ t, user, onReset, onSignOut }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)

  const clearMessage = () => setMessage(null)

  // ส่งได้เฉพาะ endpoint ที่ backend ยกเว้นไว้สำหรับบัญชีที่ยังติด must_reset_password
  // และกดเปิด shell ต่อเมื่อเซิร์ฟเวอร์ยืนยันว่าเปลี่ยนรหัสสำเร็จจริงเท่านั้น
  const submit = async (event) => {
    event.preventDefault()
    if (busy || !currentPassword || !newPassword || !confirmPassword) return
    if (newPassword !== confirmPassword) {
      setMessage(t('pwConfirmMismatch'))
      return
    }

    setBusy(true)
    setMessage(null)
    const result = await apiFetch('/api/password/reset', {
      method: 'POST',
      body: { currentPassword, newPassword },
      // endpoint นี้ใช้ 401 กับ "รหัสเดิมผิด" ด้วย จึงห้าม interceptor ตีความว่า session หมด
      suppressAuthHandler: true,
    })
    setBusy(false)

    if (result.ok) {
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      onReset()
      return
    }

    if (result.status === 401 && result.data?.error === 'Invalid credentials') {
      setMessage(t('pwWrongCurrent'))
      return
    }
    if (result.status === 400 && result.data?.error === 'Weak password') {
      setMessage(t('pwWeak'))
      return
    }
    setMessage(typeof result.data?.error === 'string' ? result.data.error : t('actionFailed'))
  }

  const displayName = user?.displayName || user?.accountName || user?.username

  return (
    <div className="relative min-h-full bg-canvas text-ink overflow-y-auto">
      <HatchDefs />
      <header className="relative z-10 min-h-20 px-6 py-4 border-b border-line bg-card flex items-center justify-between gap-4 max-sm:px-4">
        <AegisLockup />
        <div className="flex items-center gap-3 min-w-0">
          <div className="text-right min-w-0 max-sm:hidden">
            <div className="text-[13px] font-semibold text-ink truncate">{displayName}</div>
            <div className="text-[11px] font-mono text-ink-3 truncate">@{user?.username}</div>
          </div>
          <Btn variant="ghost" size="sm" onClick={onSignOut}>{t('signOut')}</Btn>
        </div>
      </header>

      <main className="relative z-10 min-h-[calc(100vh-80px)] px-5 py-12 flex items-center justify-center max-sm:py-8">
        <section className="w-full max-w-[560px] rounded-[28px] border border-line bg-card/95 p-8 shadow-[var(--elev-3)] max-sm:p-5" aria-labelledby="mandatory-reset-title">
          <div className="size-12 rounded-2xl border border-accent/30 bg-accent-soft text-accent flex items-center justify-center mb-5" aria-hidden>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="10" width="16" height="11" rx="3" />
              <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
            </svg>
          </div>
          <h1 id="mandatory-reset-title" className="text-2xl font-bold tracking-tight text-ink">{t('mandatoryResetTitle')}</h1>
          <p className="mt-2 text-[14px] leading-6 text-ink-2">{t('mandatoryResetSubtitle')}</p>

          <form id="mandatory-password-reset" aria-labelledby="mandatory-reset-title" onSubmit={submit} className="mt-7 space-y-4">
            <Field id="mandatory-current-password" label={t('temporaryPassword')}>
              <PillInput
                id="mandatory-current-password"
                type="password"
                autoComplete="current-password"
                required
                value={currentPassword}
                onChange={(event) => { setCurrentPassword(event.target.value); clearMessage() }}
              />
            </Field>
            <Field id="mandatory-new-password" label={t('newPassword')}>
              <PillInput
                id="mandatory-new-password"
                type="password"
                autoComplete="new-password"
                required
                value={newPassword}
                onChange={(event) => { setNewPassword(event.target.value); clearMessage() }}
              />
            </Field>
            <Field id="mandatory-confirm-password" label={t('confirmNewPassword')}>
              <PillInput
                id="mandatory-confirm-password"
                type="password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(event) => { setConfirmPassword(event.target.value); clearMessage() }}
              />
            </Field>

            <p className="text-[12px] leading-5 text-ink-3">{t('pwPolicyHint')}</p>
            {message && <p role="alert" className="text-[12.5px] font-medium text-danger">{message}</p>}
            <SparkleButton type="submit" className="w-full mt-1" disabled={busy || !currentPassword || !newPassword || !confirmPassword}>
              {busy ? t('saving') : t('updatePassword')}
            </SparkleButton>
          </form>

          <div className="mt-5 pt-5 border-t border-line flex items-start gap-2 text-[11.5px] leading-5 text-ink-3">
            <span className="mt-1 size-1.5 rounded-full bg-accent shrink-0" aria-hidden />
            <span>{t('mandatoryResetSecurityNote')}</span>
          </div>
        </section>
      </main>
    </div>
  )
}
