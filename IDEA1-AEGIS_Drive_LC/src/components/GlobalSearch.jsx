import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Search, FileText, User, Clock, Lock, CornerDownLeft, SearchX,
  Gauge, Folder, Vault as VaultIcon, Upload, Link2, History, HardDrive,
  ScrollText, UserCog, Settings as SettingsIcon,
} from 'lucide-react'
import { useNow } from '../lib/hooks.js'
import { fmtBytes, fmtRelative } from '../lib/format.js'
import { EmptyState } from './ui.jsx'

/* เดียวกับ Sidebar — nav item ส่ง "ชื่อไอคอน" มาจากเซิร์ฟเวอร์ ไม่ใช่ component */
const NAV_ICONS = {
  gauge: Gauge, folder: Folder, vault: VaultIcon, upload: Upload, link: Link2,
  history: History, harddrive: HardDrive, scroll: ScrollText, usercog: UserCog,
  settings: SettingsIcon,
}

const SUGGESTED_IDS = ['files', 'vault', 'shares']
const MAX_PER_GROUP = 5

/* ตัวหนาเฉพาะช่วงที่ตรงกับคำค้น — ไม่ใช้ dangerouslySetInnerHTML */
function Mark({ text, q }) {
  if (!q) return text
  const i = text.toLowerCase().indexOf(q)
  if (i < 0) return text
  return (
    <>
      {text.slice(0, i)}
      <b className="font-bold text-ink">{text.slice(i, i + q.length)}</b>
      {text.slice(i + q.length)}
    </>
  )
}

function Row({ row, idx, active, q, onRun, onHover }) {
  const Icon = row.icon
  return (
    <button
      type="button"
      id={`gs-opt-${idx}`}
      data-idx={idx}
      role="option"
      aria-selected={active}
      onMouseEnter={() => onHover(idx)}
      onClick={() => onRun(row)}
      className="w-full h-10 flex items-center gap-2.5 px-3.5 text-left cursor-pointer transition-colors duration-[var(--dur-fast)]"
      style={{ background: active ? 'var(--card-sunken)' : 'transparent' }}
    >
      <Icon size={14} strokeWidth={1.5} className="text-ink-3 shrink-0" aria-hidden />
      <span className="text-[13px] font-medium text-ink-2 truncate min-w-0 flex-1">
        <Mark text={row.label} q={q} />
      </span>
      {row.meta && (
        <span className="text-[11.5px] text-ink-3 whitespace-nowrap shrink-0" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {row.meta}
        </span>
      )}
      {active && <CornerDownLeft size={12} strokeWidth={1.8} className="text-ink-3 shrink-0" aria-hidden />}
    </button>
  )
}

/**
 * GlobalSearch — "หาอะไรก็ได้ทั้งระบบ" หนึ่งอินสแตนซ์ต่อจอ
 *
 * สถานะเปิด/ปิด "เป็นของ component นี้เท่านั้น" (ไม่ยกขึ้น App / context)
 * — นั่นคือสาเหตุที่ dropdown เดิมค้างข้ามจอ: state อยู่ที่ App แต่ไม่มีใครสั่งปิด
 *
 * ปิดตัวเองสี่ทาง: คลิกนอกกรอบ · Escape · เปลี่ยนจอ · เลือกผลลัพธ์
 * ข้อมูลมาจาก props (App ถือ fetch ไว้ตัวเดียว) — ที่นี่ไม่ยิง request เอง
 */
export function GlobalSearch({ t, screen, go, nav = [], files = [], people = [], disabled = false }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const containerRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const now = useNow(30_000)

  // ① คลิกนอกกรอบ (input + panel อยู่ใน containerRef เดียวกัน) → ปิด
  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // ② Escape → ปิด (ฟังที่ document เพื่อให้ทำงานแม้โฟกัสอยู่ในผลลัพธ์)
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false)
        inputRef.current?.blur()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  // ③ เปลี่ยนจอ → ปิดเสมอ (component นี้ remount ตาม key={screen} อยู่แล้ว แต่ไม่พึ่งโชค)
  useEffect(() => { setOpen(false) }, [screen])

  // จอที่ปิดการค้นหา (Vault) ต้องไม่มีทางเปิด panel ได้เลย แม้สถานะเดิมค้างอยู่
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])

  // ⌘K / Ctrl+K — จอที่ปิดการค้นหาไม่รับคีย์ลัดนี้ (ไม่โฟกัส ไม่เปิด)
  useEffect(() => {
    if (disabled) return
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [disabled])

  const q = query.trim().toLowerCase()

  const sections = useMemo(() => {
    // ชั้นกันที่สอง: จอ Vault ไม่มีดัชนีให้ค้นเลย ต่อให้มีใครถอด disabled ทิ้งใน devtools
    // ก็ไม่มีข้อมูลให้กรอง (ดัชนีมาจาก /api/files + /api/users ซึ่งไม่เคยมีเนื้อหา vault อยู่แล้ว)
    if (disabled) return []
    const fileRow = (f) => ({
      id: `f:${f.id}`,
      icon: FileText,
      label: f.name,
      meta: `${fmtBytes(f.size)} · ${fmtRelative(t, f.modified, now)}`,
      run: () => go('files'),
    })
    const navRow = (n) => ({
      id: `a:${n.id}`,
      icon: NAV_ICONS[n.icon] ?? Gauge,
      label: t(n.labelKey),
      meta: t('searchJumpTo'),
      run: () => go(n.id),
    })

    if (!q) {
      const recent = [...files]
        .filter((f) => f.type !== 'Folder')
        .sort((a, b) => b.modified - a.modified)
        .slice(0, MAX_PER_GROUP)
        .map(fileRow)
      const suggested = SUGGESTED_IDS
        .map((id) => nav.find((n) => n.id === id))
        .filter(Boolean)
        .map(navRow)
      return [
        { key: 'searchSecRecent', rows: recent, emptyText: t('searchNoRecent'), emptyIcon: Clock },
        ...(suggested.length ? [{ key: 'searchSecSuggested', rows: suggested }] : []),
      ]
    }

    const fileRows = files.filter((f) => f.name.toLowerCase().includes(q)).slice(0, MAX_PER_GROUP).map(fileRow)
    // PEOPLE ปรากฏเฉพาะเมื่อ App ส่ง people มา — ซึ่งส่งเฉพาะ role ที่เซิร์ฟเวอร์ให้เห็นจอ Access
    const peopleRows = people
      .filter((u) => `${u.name} ${u.username}`.toLowerCase().includes(q))
      .slice(0, MAX_PER_GROUP)
      .map((u) => ({
        id: `p:${u.id}`,
        icon: User,
        label: u.name,
        meta: `${u.username} · ${u.role === 'Admin' ? t('roleAdmin') : t('roleUser')}`,
        run: () => go('access'),
      }))
    const actionRows = nav.filter((n) => t(n.labelKey).toLowerCase().includes(q)).slice(0, MAX_PER_GROUP).map(navRow)

    return [
      { key: 'searchSecFiles', rows: fileRows },
      { key: 'searchSecPeople', rows: peopleRows },
      { key: 'searchSecActions', rows: actionRows },
    ].filter((s) => s.rows.length > 0)
  }, [q, files, people, nav, t, now, go, disabled])

  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections])

  // คำค้นเปลี่ยน = ผลลัพธ์ชุดใหม่ → ตัวเลือกที่ไฮไลต์กลับไปแถวแรกเสมอ
  useEffect(() => { setActive(0) }, [q, open])

  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  // ④ เลือกผลลัพธ์ → ปิด + ล้างคำค้น
  const run = (row) => {
    setOpen(false)
    setQuery('')
    inputRef.current?.blur()
    row.run()
  }

  const onInputKey = (e) => {
    if (disabled) return
    if (!open) {
      if (e.key === 'ArrowDown') { setOpen(true); e.preventDefault() }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (flat.length ? (i + 1) % flat.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0))
    } else if (e.key === 'Enter') {
      const row = flat[active]
      if (row) { e.preventDefault(); run(row) }
    }
  }

  let idx = -1

  const panelOpen = open && !disabled
  const tip = t('searchUnavailableVault')

  return (
    <div ref={containerRef} className="relative w-full max-w-[380px]">
      {/* ฉากรับคลิก — กันคลิก "เพื่อปิด dropdown" ทะลุไปโดนปุ่มที่ถูกบังอยู่ข้างล่าง
          (เช่น "อัปโหลด" บนแถบเครื่องมือของจอไฟล์) ปิดอย่างเดียว ไม่สั่งงานอย่างอื่น
          อยู่ใต้ panel แต่เหนือเนื้อหาหน้า และต่ำกว่าชั้น modal เสมอ */}
      {panelOpen && (
        <div
          aria-hidden
          onMouseDown={() => setOpen(false)}
          className="fixed inset-0"
          style={{ zIndex: 'calc(var(--z-dropdown) - 1)' }}
        />
      )}

      {disabled
        ? <Lock size={15} strokeWidth={1.5} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
        : <Search size={15} strokeWidth={1.5} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />}
      <input
        ref={inputRef}
        value={disabled ? '' : query}
        onChange={(e) => { if (disabled) return; setQuery(e.target.value); setOpen(true) }}
        onFocus={() => { if (!disabled) setOpen(true) }}
        onKeyDown={onInputKey}
        disabled={disabled}
        title={disabled ? tip : undefined}
        placeholder={disabled ? t('searchUnavailable') : t('searchPlaceholder')}
        aria-label={disabled ? tip : t('searchPlaceholder')}
        role="combobox"
        aria-expanded={panelOpen}
        aria-controls="global-search-panel"
        aria-autocomplete="list"
        aria-activedescendant={panelOpen && flat[active] ? `gs-opt-${active}` : undefined}
        className="w-full h-10 pl-10 pr-12 rounded-full bg-sunken border border-line text-sm text-ink placeholder:text-ink-3 outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent-soft shadow-xs disabled:cursor-not-allowed disabled:opacity-55 disabled:border-dashed disabled:focus:border-line disabled:focus:ring-0"
      />
      {/* ⌘K เป็นคำสัญญาว่า "กดแล้วค้นได้" — จอที่ปิดการค้นหาจึงไม่ควรโชว์ */}
      {!disabled && (
        <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-[10.5px] font-mono font-medium text-ink-3 bg-card border border-line rounded px-1.5 py-0.5 pointer-events-none max-sm:hidden">
          ⌘K
        </kbd>
      )}
      {disabled && <span className="sr-only" role="note">{tip}</span>}

      {panelOpen && (
        <div
          id="global-search-panel"
          ref={listRef}
          role="listbox"
          aria-label={t('searchPlaceholder')}
          /* ยึดใต้ "ช่องค้นหา" เท่านั้น: กว้างเท่า input (right-0 กันล้นขอบขวาของจอ)
             ไม่ยืดเต็มบรรทัดหัวเรื่อง จึงไม่กินพื้นที่ปุ่มอื่นในแนวนอน */
          className="absolute top-[calc(100%+6px)] right-0 w-full rounded-xl border border-line bg-card py-1.5 overflow-y-auto overscroll-contain search-pop"
          style={{ maxHeight: 'min(60vh, 420px)', boxShadow: 'var(--elev-2)', zIndex: 'var(--z-dropdown)' }}
        >
          {q && flat.length === 0 && (
            /* สถานะ "ไม่พบผลลัพธ์" ใช้แพตเทิร์นเดียวกับจอไฟล์ (ไอคอน + หัวข้อ + คำอธิบาย) */
            <div className="py-2">
              <EmptyState
                icon={SearchX}
                title={t('searchNoResults', { q: query.trim() })}
                hint={t('searchNoResultsHint')}
              />
            </div>
          )}
          {sections.map((section) => (
            <div key={section.key}>
              <p className="px-3.5 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3 select-none">
                {t(section.key)}
              </p>
              {section.rows.length === 0 ? (
                <div className="h-9 flex items-center gap-2.5 px-3.5 text-[13px] text-ink-3">
                  {section.emptyIcon && <section.emptyIcon size={13} strokeWidth={1.5} aria-hidden />}
                  {section.emptyText}
                </div>
              ) : (
                section.rows.map((row) => {
                  idx += 1
                  const i = idx
                  return (
                    <Row
                      key={row.id}
                      row={row}
                      idx={i}
                      active={i === active}
                      q={q}
                      onRun={run}
                      onHover={setActive}
                    />
                  )
                })
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* จอ Vault ไม่ใช้ component แยกอีกต่อไป — ใช้ <GlobalSearch disabled /> ตัวเดียวกัน
   เพื่อให้ "ช่องที่ถูกปิด" เป็นช่องค้นหาจริงที่ disabled (เทา ๆ ไม่ใช่ซ่อน) */
