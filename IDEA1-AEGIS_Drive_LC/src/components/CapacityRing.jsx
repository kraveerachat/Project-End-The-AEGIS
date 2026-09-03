import { useId, useMemo, useState } from 'react'
import { Card, CardTitle, NotYetImplemented } from './ui.jsx'
import { fmtBytes } from '../lib/format.js'

/* ── การ์ดความจุ — วงแหวนแทนแท่งแนวนอน ────────────────────────────────────────
   ของเดิมเป็นแท่งเดียวยาวขวางการ์ด: พอมีหมวดจริงหลายหมวด (เอกสาร/ไฟล์บีบอัด/สื่อ/
   ห้องนิรภัย/เวอร์ชันก่อนหน้า/ไฟล์อื่น + "อื่น ๆ บน volume นี้" + พื้นที่ว่าง) ทุกหมวด
   ถูกบีบให้บางจนอ่านไม่ออก และ legend ที่ไหลเป็นแถวเดียวก็ไม่มีคอลัมน์ให้กวาดสายตา

   สิ่งที่วงแหวนนี้ยึดไว้ ห้ามแก้โดยไม่คิด:

   1. 360° = totalBytes เสมอ ไม่ใช่ผลรวมของสิ่งที่ใช้ไป — ส่วนที่เติมไว้ "คือ" สัดส่วน
      ที่ใช้ไปโดยไม่ต้องอ่านตัวเลข

   2. ลายขวาง (hatch) มีความหมายเดียวทั้งผลิตภัณฑ์: **ระบบมองไม่เห็นว่าตรงนั้นคืออะไร**
      - "อื่น ๆ บน volume นี้" = ไบต์ที่ statfs นับว่าใช้ไปแล้วแต่แอปนี้ระบุไม่ได้ → ลายขวาง
      - "พื้นที่ว่าง" = ค่าที่ statfs วัดมาแล้วและรู้แน่ว่าว่าง → พื้นเรียบกลาง ๆ ไม่ใช่ลายขวาง
      แท่งเดิมสลับสองอย่างนี้ไว้ (ว่าง = ลายขวาง, unaccounted = เส้นทึบ) ซึ่งกลับความหมาย
      ของภาษาภาพทั้งระบบ — รอบนี้แก้กลับให้ตรงกับ DESIGN.md

   3. หมวดที่เล็กเกินกว่าจะวาดเป็นส่วนโค้งได้ **ต้องไม่ถูกวาดให้ดูเหมือนส่วนโค้งจริง**
      มันถูกวาดเป็น "ขีด" บาง (TICK) ที่หนาไม่เท่าวงแหวน จึงอ่านออกทันทีว่าเป็นเครื่องหมาย
      ไม่ใช่สัดส่วน และช่องสีใน legend ของแถวนั้นก็เปลี่ยนเป็นขีดบางแบบเดียวกัน
      **ตัวเลขที่เชื่อถือได้อยู่ที่ legend เสมอ** (ไบต์จริง + สัดส่วนจริง, ต่ำกว่า 0.1%
      แสดงเป็น "<0.1%" ไม่ใช่ 0.0% ที่ปัดแล้วดูเหมือนศูนย์)

   ไม่มีค่าใดในไฟล์นี้ถูกคิดขึ้นเอง ทุกไบต์มาจาก /api/storage (capacityBytes จาก statfs,
   usage จากผลรวมในฐานข้อมูล, unaccountedBytes = used − accounted) อ่านค่าไม่ได้ = บอกตรง ๆ */

const SEG = [
  { key: 'docs', color: 'var(--accent)' },
  { key: 'archives', color: 'var(--ink-3)' },
  { key: 'media', color: 'var(--violet)' },
  { key: 'vaultSeg', color: 'var(--ink)' },
  { key: 'versions', color: 'var(--warn)' },
  { key: 'other', color: 'var(--accent-ink)' },
]

const BOX = 240          // viewBox ของวงแหวน
const R = 82             // รัศมีเส้นกึ่งกลาง
const BAND = 26          // ความหนาปกติ
const GROW = 6           // ความหนาที่เพิ่มเมื่อแถวนั้นถูกเลือก (โตทั้งเข้าและออก)
const TICK = 10          // ความหนาของขีดแทนหมวดที่เล็กเกินกว่าจะวาดจริง
// 2px คือจุดที่ส่วนโค้งเริ่มหายไปจริง ๆ บนวงรัศมี 82 (≈0.39% ของวงแหวน) ตั้งสูงกว่านี้
// แล้วหมวดที่ยังมองเห็นได้สบาย (0.6%) จะถูกตีตราว่า "เล็กเกินวาด" ทั้งที่ไม่จริง
const MIN_LEN = 2        // ความยาวขั้นต่ำที่ตายังจับได้ (px บนเส้นกึ่งกลาง)
const GAP = 1.5          // ช่องว่างระหว่างส่วนโค้ง — เผยรางสี --line ด้านล่าง
const C = 2 * Math.PI * R
const CENTER = BOX / 2

/**
 * แปลงสัดส่วนจริงเป็นความยาวส่วนโค้ง โดยรับประกันสองอย่างพร้อมกัน:
 * หมวดที่ไม่เป็นศูนย์ต้องมองเห็น และวงแหวนต้องปิดที่ 360° พอดี
 * ความยาวที่ยืมมาให้ขีดขั้นต่ำถูกหักคืนตามสัดส่วนจากส่วนที่วาดตามจริง
 * (ในทางปฏิบัติคือพื้นที่ว่าง ซึ่งใหญ่กว่ามาก) — ส่วนที่ถูกยืมจะถูกทำเครื่องหมาย floored
 */
function ringLayout(parts) {
  const exact = parts.map((p) => p.frac * C)
  const floored = parts.map((p, i) => p.bytes > 0 && exact[i] < MIN_LEN)
  const len = exact.map((v, i) => (floored[i] ? MIN_LEN : v))
  const excess = len.reduce((a, b) => a + b, 0) - C
  if (excess > 0) {
    const pool = len.reduce((a, v, i) => a + (floored[i] ? 0 : v), 0)
    if (pool > excess) {
      for (let i = 0; i < len.length; i += 1) if (!floored[i]) len[i] -= excess * (len[i] / pool)
    }
  }
  let cursor = 0
  return parts.map((p, i) => {
    const start = cursor
    cursor += len[i]
    return { ...p, len: len[i], start, floored: floored[i] }
  })
}

function Arc({ row, paint, width, dim }) {
  if (row.len <= 0) return null
  const gap = row.len > GAP * 3 ? GAP : 0
  const drawn = Math.max(0.75, row.len - gap)
  return (
    <circle
      cx={CENTER}
      cy={CENTER}
      r={R}
      fill="none"
      stroke={paint}
      strokeWidth={width}
      strokeDasharray={`${drawn} ${Math.max(0, C - drawn)}`}
      strokeDashoffset={-row.start}
      style={{
        opacity: dim ? 0.4 : 1,
        transition: 'stroke-width var(--dur-fast) var(--ease), opacity var(--dur-fast) var(--ease)',
      }}
    />
  )
}

/* ช่องสีใน legend พูดภาษาเดียวกับวงแหวน: สี่เหลี่ยม = ส่วนโค้งจริง,
   ขีดบาง = ถูกวาดที่ความกว้างขั้นต่ำ, ลายขวาง = ระบุไม่ได้, ขอบเปล่า = ว่าง */
function Swatch({ row }) {
  if (row.kind === 'hatch') {
    return <span aria-hidden className="size-3 rounded-[4px] hatch hatch-ink3 border border-line" style={{ backgroundColor: 'var(--card-sunken)' }} />
  }
  if (row.kind === 'free') {
    return <span aria-hidden className="size-3 rounded-[4px] border border-line" style={{ backgroundColor: 'var(--card-sunken)' }} />
  }
  if (row.floored) {
    return <span aria-hidden className="w-[3px] h-3 rounded-[1px]" style={{ backgroundColor: row.color }} />
  }
  return <span aria-hidden className="size-3 rounded-[4px]" style={{ backgroundColor: row.color }} />
}

const ROW_GRID = 'grid grid-cols-[14px_minmax(0,1fr)_auto_58px] items-center gap-x-3'

export function CapacityCard({ t, capacityBytes, usage, unaccountedBytes }) {
  // useId คืนค่าที่มีอักขระพิเศษ (React 19 ใช้ «r0») ซึ่งอ้างอิงผ่าน url(#…) ไม่ได้เสมอไป
  const hatchId = `cap-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [hovered, setHovered] = useState(null)
  const [pinned, setPinned] = useState(null)
  const active = hovered ?? pinned

  const total = capacityBytes?.totalBytes ?? 0
  const free = capacityBytes?.freeBytes ?? 0
  const used = capacityBytes?.usedBytes ?? 0
  const unaccounted = unaccountedBytes ?? 0

  const { drawn, legend } = useMemo(() => {
    const cats = SEG.map((s) => ({ id: s.key, kind: 'cat', color: s.color, label: t(s.key), bytes: usage?.[s.key] ?? 0 }))
    // เรียงจากมากไปน้อยเพราะคำถามแรกของคนอ่านคือ "อะไรกินพื้นที่" — หมวดที่เป็นศูนย์
    // ยังคงแสดงไว้ท้ายตาราง (แบบจาง) เพื่อบอกว่ามีหมวดอะไรอยู่บ้าง ไม่ใช่ซ่อนไป
    const present = cats.filter((c) => c.bytes > 0).sort((a, b) => b.bytes - a.bytes)
    const absent = cats.filter((c) => c.bytes === 0)
    const tail = []
    if (unaccounted > 0) tail.push({ id: 'unaccounted', kind: 'hatch', label: t('unaccounted'), hint: t('unaccountedHint'), bytes: unaccounted })
    tail.push({ id: 'free', kind: 'free', label: t('free'), bytes: free })

    const parts = [...present, ...tail].map((p) => ({ ...p, frac: total > 0 ? p.bytes / total : 0 }))
    const laid = ringLayout(parts)
    return { drawn: laid, legend: [...laid, ...absent.map((a) => ({ ...a, len: 0, start: 0, floored: false, frac: 0 }))] }
  }, [t, usage, unaccounted, free, total])

  const share = (bytes) => {
    if (total <= 0 || bytes <= 0) return '0%'
    const p = (bytes / total) * 100
    return p < 0.1 ? t('capacityTinyShare') : `${p.toFixed(1)}%`
  }
  const amount = (bytes) => (bytes === 0 ? t('storageZeroGb') : fmtBytes(bytes))
  const usedPct = total > 0 ? ((used / total) * 100).toFixed(1) : '0.0'
  const anyFloored = drawn.some((r) => r.floored)
  const activeRow = drawn.find((r) => r.id === active) ?? null

  // ระบบไฟล์ไม่รายงานความจุ = ไม่มีฐานให้คิดสัดส่วน จึงไม่วาดวงแหวนและบอกเหตุผลตรง ๆ
  if (!capacityBytes || total <= 0) {
    return (
      <Card className="p-5">
        <CardTitle sub={t('capacitySub')}>{t('capacity')}</CardTitle>
        <NotYetImplemented label={t('notAvailable')}>{t('capacityUnreadable')}</NotYetImplemented>
      </Card>
    )
  }

  const paintOf = (row) => (row.kind === 'hatch' ? `url(#${hatchId})` : row.kind === 'free' ? 'var(--card-sunken)' : row.color)
  const widthOf = (row) => {
    const base = row.floored ? TICK : row.kind === 'free' ? BAND - 2 : BAND
    return row.id === active ? base + GROW : base
  }

  return (
    <Card className="p-5">
      <CardTitle sub={t('capacitySub')}>{t('capacity')}</CardTitle>

      {/* วงแหวน | ตาราง | ยอดรวม — ตารางถูกจำกัดความกว้างไว้ ไม่งั้นบนการ์ดกว้าง ๆ
          ชื่อหมวดกับตัวเลขจะถูกดันแยกกันคนละฝั่งจนอ่านเป็นคู่กันไม่ออก */}
      <div className="grid grid-cols-[240px_minmax(0,1fr)_auto] gap-x-10 gap-y-6 items-center max-xl:grid-cols-[240px_minmax(0,1fr)] max-md:grid-cols-1">
        <div className="relative size-[240px] shrink-0 max-md:justify-self-center">
          <svg
            viewBox={`0 0 ${BOX} ${BOX}`}
            className="size-full"
            role="img"
            aria-label={t('capacityRingLabel', { used: fmtBytes(used), total: fmtBytes(total), free: amount(free), pct: usedPct })}
          >
            <defs>
              {/* ลายขวาง 45° เดียวกับ .hatch-ink3 — ที่นี่ต้องเป็น SVG pattern เพราะเป็น stroke ไม่ใช่ background */}
              <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill="var(--card-sunken)" />
                <line x1="0.5" y1="0" x2="0.5" y2="6" stroke="var(--ink-3)" strokeOpacity="0.55" strokeWidth="1" />
              </pattern>
            </defs>
            <g transform={`rotate(-90 ${CENTER} ${CENTER})`}>
              {/* รางเต็มวง: ทำให้ช่องว่างระหว่างส่วนโค้งอ่านเป็นเส้นแบ่ง ไม่ใช่รูโหว่ */}
              <circle cx={CENTER} cy={CENTER} r={R} fill="none" stroke="var(--line)" strokeWidth={BAND} />
              {drawn.map((row) => (
                <Arc key={row.id} row={row} paint={paintOf(row)} width={widthOf(row)} dim={Boolean(active) && row.id !== active} />
              ))}
            </g>
          </svg>

          <div className="absolute inset-0 grid place-items-center pointer-events-none px-9 text-center">
            {activeRow ? (
              <div>
                <p className="text-[12px] font-semibold text-ink leading-snug">{activeRow.label}</p>
                <p className="text-[17px] font-mono text-ink mt-1" style={{ fontVariantNumeric: 'tabular-nums' }}>{amount(activeRow.bytes)}</p>
                <p className="text-[11.5px] text-ink-3 mt-0.5" style={{ fontVariantNumeric: 'tabular-nums' }}>{share(activeRow.bytes)}</p>
              </div>
            ) : (
              <div>
                <p className="text-[30px] font-semibold text-ink leading-none" style={{ fontVariantNumeric: 'tabular-nums' }}>{usedPct}%</p>
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3 mt-1.5">{t('capacityUsed')}</p>
              </div>
            )}
          </div>
        </div>

        <div className="min-w-0 w-full max-w-[520px] max-md:max-w-none">
          <div className={`${ROW_GRID} px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3`} aria-hidden>
            <span />
            <span>{t('capacityLegendCategory')}</span>
            <span className="text-right">{t('capacityLegendSize')}</span>
            <span className="text-right">{t('capacityLegendShare')}</span>
          </div>
          <ul className="flex flex-col border-t border-line">
            {legend.map((row) => {
              const empty = row.bytes <= 0
              // แถวที่เป็นศูนย์ถูกลดน้ำหนักด้วย "สี" ไม่ใช่ opacity — ink-2 ที่ 55% วัดได้
              // ~2.6:1 ซึ่งตกเกณฑ์ AA ส่วน ink-3 เต็มความทึบผ่านทั้งธีมสว่างและมืด
              const cells = (
                <>
                  <span className="grid place-items-center" style={empty ? { opacity: 0.5 } : undefined}><Swatch row={row} /></span>
                  <span className={`truncate text-left text-[13px] font-medium ${empty ? 'text-ink-3' : 'text-ink-2'}`}>{row.label}</span>
                  <span className={`text-right text-[13px] ${empty ? 'text-ink-3' : 'text-ink'}`} style={{ fontVariantNumeric: 'tabular-nums' }}>{amount(row.bytes)}</span>
                  <span className="text-right text-[12px] text-ink-3" style={{ fontVariantNumeric: 'tabular-nums' }}>{share(row.bytes)}</span>
                </>
              )
              // หมวดที่เป็นศูนย์ไม่มีส่วนโค้งให้เน้น จึงไม่ใช่ปุ่ม — ปุ่มที่กดแล้วไม่เกิดอะไรคือ affordance ที่โกหก
              if (empty) return <li key={row.id} className={`${ROW_GRID} px-2 py-1.5`}>{cells}</li>

              return (
                <li key={row.id}>
                  {/* คลิก = ปักหมุด เพื่อให้จอสัมผัสและคีย์บอร์ดเข้าถึงค่าเดียวกับที่เมาส์ชี้ได้
                      คำอธิบายของ "อื่น ๆ บน volume นี้" ต่อท้าย aria-label ด้วย ไม่ใช่อยู่ใน
                      title อย่างเดียว — title เป็นของเมาส์เท่านั้น คีย์บอร์ดจะไม่มีวันได้ยิน */}
                  <button
                    type="button"
                    aria-pressed={pinned === row.id}
                    aria-label={`${row.label}: ${amount(row.bytes)}, ${share(row.bytes)}${row.hint ? `. ${row.hint}` : ''}`}
                    title={row.hint}
                    onMouseEnter={() => setHovered(row.id)}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={() => setHovered(row.id)}
                    onBlur={() => setHovered(null)}
                    onClick={() => setPinned((p) => (p === row.id ? null : row.id))}
                    className={`${ROW_GRID} w-full px-2 py-1.5 rounded-[8px] cursor-pointer transition-colors duration-[var(--dur-fast)] hover:bg-sunken focus-visible:bg-sunken ${pinned === row.id ? 'bg-sunken' : ''}`}
                    style={{ transitionTimingFunction: 'var(--ease)' }}
                  >
                    {cells}
                  </button>
                </li>
              )
            })}
          </ul>
          {anyFloored && (
            <p className="text-[11.5px] text-ink-3 leading-relaxed mt-3 px-2">{t('capacityFloorNote')}</p>
          )}
        </div>

        {/* ยอดรวมสี่ค่าที่ต้องอ่านได้โดยไม่ต้องตีความวงแหวน — บนจอกว้างวางเป็นคอลัมน์ที่สาม
            (คั่นด้วยเส้น 1px ตามโครง ไม่ใช่แถบสีตกแต่ง) แคบกว่านั้นไหลลงเป็นแถวล่าง */}
        <dl className="grid gap-y-4 gap-x-6 self-stretch content-center pl-10 border-l border-line xl:w-[168px] max-xl:col-span-2 max-xl:w-full max-xl:grid-cols-4 max-xl:border-l-0 max-xl:border-t max-xl:pl-0 max-xl:pt-4 max-md:col-span-1 max-md:grid-cols-2">
          {[
            [t('capacityTotal'), amount(total)],
            [t('capacityUsed'), amount(used)],
            [t('free'), amount(free)],
            [t('capacityUsedPct'), `${usedPct}%`],
          ].map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">{label}</dt>
              <dd className="text-[15px] font-mono text-ink mt-0.5" style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Card>
  )
}
