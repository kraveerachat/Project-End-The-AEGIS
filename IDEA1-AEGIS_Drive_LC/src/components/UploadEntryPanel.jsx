import { useEffect, useRef } from 'react'
import { UploadCloud, X } from 'lucide-react'

import { Btn, IconBtn } from './ui.jsx'

/**
 * ลิ้นชัก "เริ่มงานอัปโหลด" ด้านขวา — พื้นผิวเดียวที่ Files (UploadDrawer) และ Private Vault
 * (VaultUploadDrawer) ใช้ร่วมกัน เพื่อให้สองจอ "เหมือนกันโดยโครงสร้าง" ไม่ใช่ลอกคลาสกันแล้วค่อย ๆ เพี้ยน
 *
 * ⚠️ เป็น presentation ล้วน: ไม่รู้จักคิว transport หรือการกู้คืน — ไฟล์ที่เลือก/ลากมาถูกส่งให้ `onFiles`
 *    แล้วผู้เรียกเป็นผู้ตัดสินเส้นทาง (Files = /api/files/uploads, Vault = /api/vault/tree/uploads เท่านั้น)
 * ⚠️ ตัวเรียกเป็นผู้ครอบด้วย `open` — คิวและถาดต้องอยู่นอกคอมโพเนนต์นี้เสมอ การปิดลิ้นชักจึงไม่มีวัน
 *    กลายเป็นการยกเลิกงาน
 */
export function UploadEntryPanel({
  t, onClose, onFiles, destination = '/', titleId = 'upload-drawer-title', testId, inputTestId, children,
}) {
  const inputRef = useRef(null)
  const drawerRef = useRef(null)

  useEffect(() => {
    const drawer = drawerRef.current
    drawer?.focus()
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose?.()
        return
      }
      if (event.key !== 'Tab' || !drawer) return
      const focusable = [...drawer.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const pick = () => inputRef.current?.click()
  const acceptDrop = (event) => {
    event.preventDefault()
    if (event.dataTransfer?.files?.length) onFiles(event.dataTransfer.files)
  }

  return (
    <>
      <div className="fixed inset-0 z-[var(--z-modal)] bg-black/20" aria-hidden />
      <aside ref={drawerRef} tabIndex={-1} data-testid={testId} role="dialog" aria-modal="true" aria-labelledby={titleId} className="fixed z-[calc(var(--z-modal)+1)] inset-y-0 right-0 w-full max-w-[420px] bg-canvas border-l border-line shadow-[var(--elev-2)] flex flex-col outline-none">
        <header className="px-6 py-5 border-b border-line flex items-start gap-3 bg-card">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[18px] font-bold text-ink tracking-[-0.01em]">{t('uploadFiles')}</h2>
            <p className="mt-1 text-[11.5px] text-ink-3">
              {t('destinationFolder')} · <span className="font-mono text-ink-2">{destination}</span>
            </p>
          </div>
          <IconBtn label={t('closeUpload')} onClick={onClose}><X size={17} /></IconBtn>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-5">
          {/* จุดเริ่มงานจุดเดียวของลิ้นชักนี้ — ใหญ่ ชัด และไม่มีอะไรมาแย่งความสนใจ */}
          <button
            type="button"
            onClick={pick}
            onDragOver={(event) => event.preventDefault()}
            onDrop={acceptDrop}
            className="w-full min-h-44 rounded-[var(--r-card)] border-2 border-dashed border-line bg-sunken flex flex-col items-center justify-center gap-2 text-center px-6 py-8 transition-colors duration-[var(--dur-fast)] hover:border-accent hover:bg-[var(--accent-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span className="size-12 rounded-full bg-card flex items-center justify-center shadow-[var(--elev-1)]">
              <UploadCloud size={22} className="text-accent" aria-hidden />
            </span>
            <span className="mt-1 block text-[14px] font-bold text-ink">{t('dropHere')}</span>
            <span className="block max-w-[28ch] text-[11.5px] leading-relaxed text-ink-3">{t('dropSub')}</span>
          </button>
          <input ref={inputRef} data-testid={inputTestId} type="file" multiple className="sr-only" aria-label={t('chooseFiles')} onChange={(event) => { if (event.target.files?.length) onFiles(event.target.files); event.target.value = '' }} />

          <Btn variant="primary" className="w-full" onClick={pick}>{t('chooseFiles')}</Btn>

          {/* ⚠️ คิวที่กำลังเดินไม่ถูกแสดงซ้ำที่นี่ ถาดมุมขวาล่างเป็นเจ้าของเรื่องนั้นคนเดียว */}
          <p className="text-[11.5px] leading-relaxed text-ink-3 border-l-2 border-line pl-3">{t('uploadEntryHint')}</p>

          {children}
        </div>

        <footer className="px-6 py-4 border-t border-line bg-card">
          <span className="text-[11.5px] text-ink-3">{t('currentFolder')}: <span className="font-mono text-ink-2">{destination}</span></span>
        </footer>
      </aside>
    </>
  )
}
