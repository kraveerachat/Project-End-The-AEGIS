import { useEffect, useRef, useState } from 'react'
import { Bell, Menu, LogOut } from 'lucide-react'
import { Dot, Avatar } from './ui.jsx'

function Dropdown({ open, onClose, children, align = 'right', width = 280 }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (!ref.current?.contains(e.target)) onClose()
    }
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])
  if (!open) return null
  return (
    <div
      ref={ref}
      className={`absolute top-[calc(100%+8px)] bg-card border border-line rounded-xl py-2 fade-in ${align === 'right' ? 'right-0' : 'left-0'}`}
      style={{ width, boxShadow: 'var(--elev-2)', zIndex: 'var(--z-dropdown)' }}
    >
      {children}
    </div>
  )
}

export function TopBar({ t, scrolled, user, health, onSignOut, openMobileNav }) {
  const [bellOpen, setBellOpen] = useState(false)
  const [avatarOpen, setAvatarOpen] = useState(false)

  // Live Tactical Clock (matching CCTV-Operator topbar clock)
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])
  const clockText = now.toLocaleTimeString('en-GB', { hour12: false })
  const dateText = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

  // สอง pill อ่านคนละ probe: Drive = Application process, Metadata = SELECT 1 จริง
  // ห้ามเรียก Edge node เพราะ endpoint นี้ไม่ได้วัด host/Docker daemon ทั้งเครื่อง
  const applicationUp = health.data?.layers?.application?.ok === true
    && health.data?.layers?.application?.checked === true
  const metadataUp = health.data?.layers?.metadata?.ok === true
    && health.data?.layers?.metadata?.checked === true
  const dbMode = health.data?.db

  return (
    <header
      className="h-[68px] shrink-0 bg-card border-b border-line backdrop-blur-md flex items-center justify-between gap-6 px-6 max-md:px-4 transition-all duration-[var(--dur-base)] sticky top-0 z-[var(--z-sticky)]"
      style={{ boxShadow: scrolled ? 'var(--elev-1)' : 'none' }}
    >
      {/* LEFT ZONE: Mobile Toggle Button / Left Spacer */}
      <div className="flex items-center min-w-[40px]">
        <button
          type="button"
          aria-label={t('expandSidebar')}
          onClick={openMobileNav}
          className="md:hidden size-9 flex items-center justify-center rounded-full text-ink-2 hover:bg-sunken hover:text-ink transition-colors cursor-pointer"
        >
          <Menu size={18} strokeWidth={1.5} />
        </button>
      </div>

      {/* CENTER ZONE: Status Pills — ค่าจริงจาก /healthz (poll 15s) */}
      <div className="flex items-center justify-center gap-3 max-md:hidden" role="status" aria-live="polite">
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-sunken border border-line text-ink-2 text-xs font-mono font-medium select-none shadow-xs">
          <Dot tone={applicationUp ? 'ok' : 'neutral'} pulse={applicationUp} size={6} />
          <span>{applicationUp ? t('driveOnline') : t('driveNotConnected')}</span>
        </div>
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-sunken border border-line text-ink-2 text-xs font-mono font-medium select-none shadow-xs">
          <Dot tone={metadataUp ? 'accent' : 'neutral'} pulse={metadataUp} size={6} />
          <span>{metadataUp ? `Metadata: ${dbMode === 'postgres' ? 'PostgreSQL' : 'in-memory'}` : t('metadataNotConnected')}</span>
        </div>
      </div>

      {/* RIGHT ZONE: Tactical Clock, Bell & Profile */}
      <div className="flex items-center gap-4">
        {/* Tactical Clock (Monospace Stacked) */}
        <div className="flex flex-col items-end leading-tight max-sm:hidden select-none">
          <span className="font-mono text-sm font-bold text-ink tracking-tight">{clockText}</span>
          <span className="font-mono text-[10.5px] font-medium text-ink-3 tracking-wide">{dateText}</span>
        </div>

        <div className="w-px h-6 bg-line max-sm:hidden" aria-hidden />

        {/* Utilities: Notifications Bell */}
        <div className="flex items-center">
          <div className="relative">
            <button
              type="button"
              aria-label={t('notifications')}
              onClick={() => setBellOpen((v) => !v)}
              className="relative size-9 flex items-center justify-center rounded-full text-ink-2 hover:bg-sunken hover:text-ink transition-colors cursor-pointer"
            >
              <Bell size={17} strokeWidth={1.5} />
            </button>
            <Dropdown open={bellOpen} onClose={() => setBellOpen(false)} width={320}>
              <p className="px-4 pb-1.5 text-[11px] font-semibold text-ink-3 uppercase tracking-[0.08em]">{t('notifications')}</p>
              {/* ไม่มีระบบแจ้งเตือนแบบ push ใน scope นี้ — บอกตรง ๆ ดีกว่าโชว์แถวปลอม
                  (เหตุการณ์ความปลอดภัยดูได้ที่ Audit Log ซึ่งเป็นข้อมูลจริง) */}
              <p className="px-4 py-3 text-xs text-ink-3">{t('emptyNoActivity')}</p>
            </Dropdown>
          </div>
        </div>

        <div className="w-px h-6 bg-line max-sm:hidden" aria-hidden />

        {/* Profile Avatar & Usermeta Badge */}
        <div className="relative">
          <button
            type="button"
            aria-label={user.displayName}
            onClick={() => setAvatarOpen((v) => !v)}
            className="flex items-center gap-3 p-1 rounded-full hover:bg-sunken transition-colors cursor-pointer text-left"
          >
            {/* รูปโปรไฟล์จริงถ้าผู้ใช้อัปโหลดไว้ ไม่งั้นตกลงมาที่อักษรย่อเหมือนเดิม
                (Avatar จัดการ fallback เอง — ดู src/components/ui.jsx) */}
            <div className="p-[2px] rounded-full bg-gradient-to-tr from-blue-600 via-indigo-500 to-purple-600 shadow-sm shrink-0">
              <Avatar userId={user.id} name={user.displayName} size={36} className="bg-blue-600 text-white" />
            </div>
            <div className="flex flex-col text-left max-md:hidden min-w-0 pr-1">
              <span className="text-[13px] font-bold text-ink leading-tight truncate">{user.displayName}</span>
              {/* role เป็นจอแสดงผลของสิ่งที่เซิร์ฟเวอร์ตัดสินมา — ไม่ใช่ปุ่ม เปลี่ยนไม่ได้ */}
              <span className="text-xs font-mono text-ink-3 leading-tight truncate">AEGIS Drive · {user.role}</span>
            </div>
          </button>

          <Dropdown open={avatarOpen} onClose={() => setAvatarOpen(false)} width={220}>
            <div className="px-4 pb-2 border-b border-line mb-1.5">
              <p className="text-[13.5px] font-bold text-ink">{user.displayName}</p>
              <p className="font-mono text-xs text-ink-3">{user.username} · {user.role}</p>
            </div>
            <button
              type="button"
              onClick={onSignOut}
              className="w-full flex items-center gap-2.5 px-4 h-9 text-[13px] font-medium text-danger hover:bg-sunken transition-colors cursor-pointer"
            >
              <LogOut size={14} strokeWidth={1.5} />
              {t('signOut')}
            </button>
          </Dropdown>
        </div>
      </div>
    </header>
  )
}
