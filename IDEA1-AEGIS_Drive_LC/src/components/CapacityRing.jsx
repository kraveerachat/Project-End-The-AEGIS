import { useEffect, useId, useMemo, useState } from 'react'
import { Card, CardTitle, NotYetImplemented } from './ui.jsx'
import { fmtBytes } from '../lib/format.js'

/* ── การ์ดความจุ — สองวง สองฐาน ────────────────────────────────────────────────
   ทำไมต้องสองวง:

   บน production จริง ข้อมูลทั้งหมดที่ AEGIS เก็บมีขนาดราว 43 MB บน volume 119 GB
   คิดเป็น ~0.03% ของทั้งดิสก์ ไม่ว่าจะวาดวงแหวนวงเดียวสวยแค่ไหน หมวดของ AEGIS
   (เอกสาร / สื่อ / ห้องนิรภัย / เวอร์ชันก่อนหน้า) ก็ยังเป็นเศษเสี้ยวที่มองไม่เห็นอยู่ดี
   รอบก่อนแก้ด้วยการวาดเป็น "ขีด" แล้วชี้ป้ายออกมา ซึ่งซื่อสัตย์แต่หน้าตาเหมือน
   เครื่องมือ debug มากกว่าแผนภูมิที่ตั้งใจออกแบบ

   การขยายมุมของหมวดเล็กให้ "ดูเป็นชิ้นจริง" บนวงเดียวคือการโกหกสัดส่วน — ทำไม่ได้
   ทางออกที่ทั้งอ่านง่ายและไม่โกหกคือ **แยกคำถามออกเป็นสองคำถาม แล้วประกาศฐานของ
   แต่ละวงให้ชัด**:

   1. วงนอก (ฐาน = ทั้ง volume): ดิสก์เต็มแค่ไหน — "ข้อมูลของ AEGIS" รวมเป็นชิ้นเดียว,
      "อื่น ๆ บน volume นี้" (ลายขวาง = ระบุไม่ได้), และ "พื้นที่ว่าง" เหลือแค่สามส่วน
      จึงอ่านออกทันทีและป้ายชี้ไม่ทับกัน

   2. วงใน (ฐาน = ข้อมูลของ AEGIS เท่านั้น): ในข้อมูลของเราเอง อะไรกินพื้นที่
      ที่ฐานนี้ สื่อ 39.1 MB จาก 43.4 MB = 90% ซึ่งเป็น "ส่วนโค้งจริง" ที่มองเห็นชัด
      และเป็นเปอร์เซ็นต์จริง ไม่ใช่ตัวเลขที่ถูกขยาย เพียงแต่คิดจากฐานคนละตัว

   ฐานของแต่ละวงถูกเขียนไว้ข้างวงเสมอ และตารางด้านล่างแยกเป็นสองกลุ่มตามฐานเดียวกัน
   หมวดหนึ่งจึงมีทั้ง "สัดส่วนต่อ AEGIS" และ "สัดส่วนต่อ volume" ให้เทียบได้

   กติกาที่ห้ามแก้โดยไม่คิด:

   1. 360° ของวงนอก = totalBytes เสมอ, 360° ของวงใน = ผลรวมข้อมูล AEGIS เสมอ
   2. ลายขวาง (hatch) มีความหมายเดียวทั้งผลิตภัณฑ์: ระบบมองไม่เห็นว่าตรงนั้นคืออะไร
      "อื่น ๆ บน volume นี้" = ลายขวาง, "พื้นที่ว่าง" = วัดมาแล้วและรู้ว่าว่าง = พื้นเรียบ
   3. หมวดที่เล็กกว่าเกณฑ์มองเห็นยังถูกวาดที่ "ความกว้างขั้นต่ำ" เท่านั้น ห้ามขยายมุม
      และต่ำกว่า 0.1% แสดงเป็น "<0.1%" ไม่ใช่ 0.0%
   4. เกณฑ์ "เล็กเกินวาด" คิดเป็นสัดส่วนของวง ไม่ใช่พิกเซล — ย่อ/ขยายหน้าต่างแล้ว
      หมวดชุดเดิมต้องถูกจัดประเภทเหมือนเดิมเสมอ

   ทุกไบต์มาจาก /api/storage (capacityBytes จาก statfs, usage จากผลรวมในฐานข้อมูล,
   unaccountedBytes = used − accounted) สัญญาของ /api/storage ไม่ถูกแตะ */

const SEG = [
  { key: 'docs', color: 'var(--accent)' },
  { key: 'archives', color: 'var(--ink-3)' },
  { key: 'media', color: 'var(--violet)' },
  { key: 'vaultSeg', color: 'var(--ink)' },
  { key: 'versions', color: 'var(--warn)' },
  { key: 'other', color: 'var(--accent-ink)' },
]

/* เกณฑ์มองเห็น: 2px บนวงรัศมี 82 คือจุดที่ส่วนโค้งเริ่มหายไปจริง ๆ (≈0.39% ของวง)
   เก็บเป็น "สัดส่วน" เพื่อให้ทุกขนาดวงตัดสินเหมือนกัน (ดูกติกาข้อ 4) */
const MIN_FRAC = 2 / (2 * Math.PI * 82)
const GAP_FRAC = 2.5 / (2 * Math.PI * 82) // ช่องว่างระหว่างส่วนโค้ง — เผยรางสี --line

/* w ต้องกว้างพอให้ป้ายที่ยาวที่สุด ("อื่น ๆ บน volume นี้") วางจบภายใน viewBox
   ไม่งั้น SVG text ซึ่งไม่ตัดบรรทัดเองจะถูกขอบ viewBox เฉือนหายไปครึ่งคำ */
const VOLUME_WIDE = { w: 720, h: 400, cx: 360, cy: 200, r: 124, band: 44, tick: 18, grow: 7, rail: 196, gutter: 172, pad: 28 }
const VOLUME_COMPACT = { w: 260, h: 260, cx: 130, cy: 130, r: 94, band: 32, tick: 13, grow: 6 }
const AEGIS_WIDE = { w: 240, h: 240, cx: 120, cy: 120, r: 84, band: 32, tick: 13, grow: 6 }
const AEGIS_COMPACT = { w: 220, h: 220, cx: 110, cy: 110, r: 78, band: 28, tick: 12, grow: 5 }

const LABEL_GAP = 44 // ระยะห่างแนวตั้งขั้นต่ำระหว่างป้ายชี้สองใบฝั่งเดียวกัน

/**
 * แปลงสัดส่วนจริงเป็นสัดส่วนที่ "วาด" โดยรับประกันสองอย่างพร้อมกัน:
 * ส่วนที่ไม่เป็นศูนย์ต้องมองเห็น และวงต้องปิดที่ 360° พอดี
 * สัดส่วนที่ยืมมาให้ขั้นต่ำถูกหักคืนตามสัดส่วนจากส่วนที่วาดตามจริง
 *
 * `frac` = สัดส่วนจริงเสมอ (ใช้กับตัวเลขทุกที่)
 * `span` = สัดส่วนที่วาดจริงบนวง (ใช้กับเรขาคณิตเท่านั้น)
 */
function ringLayout(parts) {
  const floored = parts.map((p) => p.bytes > 0 && p.frac < MIN_FRAC)
  const span = parts.map((p, i) => (floored[i] ? MIN_FRAC : p.frac))
  const excess = span.reduce((a, b) => a + b, 0) - 1
  if (excess > 0) {
    const pool = span.reduce((a, v, i) => a + (floored[i] ? 0 : v), 0)
    if (pool > excess) {
      for (let i = 0; i < span.length; i += 1) if (!floored[i]) span[i] -= excess * (span[i] / pool)
    }
  }
  let cursor = 0
  return parts.map((p, i) => {
    const startFrac = cursor
    cursor += span[i]
    return { ...p, span: span[i], startFrac, midFrac: startFrac + span[i] / 2, floored: floored[i] }
  })
}

function Arc({ row, geom, paint, width, dim }) {
  const C = 2 * Math.PI * geom.r
  const len = row.span * C
  if (len <= 0) return null
  const gap = row.span > GAP_FRAC * 3 ? GAP_FRAC * C : 0
  const drawn = Math.max(0.75, len - gap)
  return (
    <circle
      cx={geom.cx}
      cy={geom.cy}
      r={geom.r}
      fill="none"
      stroke={paint}
      strokeWidth={width}
      strokeLinecap={row.floored ? 'round' : 'butt'}
      strokeDasharray={`${drawn} ${Math.max(0, C - drawn)}`}
      strokeDashoffset={-row.startFrac * C}
      style={{
        opacity: dim ? 0.32 : 1,
        transition: 'stroke-width var(--dur-fast) var(--ease), opacity var(--dur-fast) var(--ease)',
      }}
    />
  )
}

/* ช่องสีใน legend พูดภาษาเดียวกับวง: สี่เหลี่ยม = ส่วนโค้งจริง,
   ขีดบาง = ถูกวาดที่ความกว้างขั้นต่ำ, ลายขวาง = ระบุไม่ได้, ขอบเปล่า = ว่าง */
function Swatch({ row }) {
  if (row.kind === 'hatch') {
    return <span aria-hidden className="size-3 rounded-[4px] hatch hatch-ink3 border border-line" style={{ backgroundColor: 'var(--card-sunken)' }} />
  }
  if (row.kind === 'free') {
    return <span aria-hidden className="size-3 rounded-[4px] border border-line" style={{ backgroundColor: 'var(--card-sunken)' }} />
  }
  if (row.floored) {
    return <span aria-hidden className="w-[3px] h-3 rounded-full" style={{ backgroundColor: row.color }} />
  }
  return <span aria-hidden className="size-3 rounded-[4px]" style={{ backgroundColor: row.color }} />
}

/**
 * วางป้ายชี้รอบวงโดยไม่ให้ทับกัน แล้วดันป้ายแต่ละฝั่งให้ห่างกันอย่างน้อย LABEL_GAP
 * เส้นชี้ยังลากจาก "ตำแหน่งจริง" บนวงเสมอ การเลื่อนเกิดกับป้ายเท่านั้น ไม่ใช่กับมุม
 */
function layoutCallouts(rows, geom) {
  const anchored = rows.map((row) => {
    const angle = row.midFrac * 2 * Math.PI - Math.PI / 2
    const outer = geom.r + geom.band / 2
    return {
      row,
      side: Math.cos(angle) >= 0 ? 1 : -1,
      ax: geom.cx + outer * Math.cos(angle),
      ay: geom.cy + outer * Math.sin(angle),
      ex: geom.cx + (outer + 18) * Math.cos(angle),
      ey: geom.cy + (outer + 18) * Math.sin(angle),
    }
  })

  const placed = []
  for (const side of [1, -1]) {
    const column = anchored.filter((a) => a.side === side).sort((a, b) => a.ey - b.ey)
    let cursor = -Infinity
    for (const item of column) {
      item.ly = Math.max(item.ey, cursor + LABEL_GAP)
      cursor = item.ly
    }
    const overflow = column.length ? column[column.length - 1].ly - (geom.h - geom.pad) : 0
    if (overflow > 0) for (const item of column) item.ly -= overflow
    let floor = geom.pad
    for (const item of column) {
      item.ly = Math.max(item.ly, floor)
      floor = item.ly + LABEL_GAP
    }
    placed.push(...column)
  }
  return placed
}

/** จอกว้างพอจะวางสองวงเคียงกันพร้อมป้ายชี้หรือยัง */
function useWideRing() {
  const [wide, setWide] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const mq = window.matchMedia('(min-width: 1180px)')
    const sync = () => setWide(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  return wide
}

const ROW_GRID = 'grid grid-cols-[14px_minmax(0,1fr)_auto_62px] items-center gap-x-3'

/* ── one ring ─────────────────────────────────────────────────────── */

function Ring({ rows, geom, hatchId, active, callouts, centre, label, amount, share }) {
  const paintOf = (row) => (row.kind === 'hatch' ? `url(#${hatchId})` : row.kind === 'free' ? 'var(--card-sunken)' : row.color)
  const widthOf = (row) => {
    const base = row.floored ? geom.tick : row.kind === 'free' ? geom.band - 2 : geom.band
    return row.id === active ? base + geom.grow : base
  }

  return (
    <svg viewBox={`0 0 ${geom.w} ${geom.h}`} className="w-full h-auto" role="img" aria-label={label}>
      <g transform={`rotate(-90 ${geom.cx} ${geom.cy})`}>
        {/* รางเต็มวง: ทำให้ช่องว่างระหว่างส่วนโค้งอ่านเป็นเส้นแบ่ง ไม่ใช่รูโหว่ */}
        <circle cx={geom.cx} cy={geom.cy} r={geom.r} fill="none" stroke="var(--line)" strokeWidth={geom.band} />
        {rows.map((row) => (
          <Arc key={row.id} row={row} geom={geom} paint={paintOf(row)} width={widthOf(row)} dim={Boolean(active) && row.id !== active} />
        ))}
      </g>

      {/* ป้ายชี้ — aria-hidden เพราะวงมี aria-label สรุปแล้ว และตารางด้านล่างเป็น
          ตัวเลขชุดเดียวกันในรูปแบบที่กดได้จริง */}
      {callouts?.length > 0 && (
        <g aria-hidden>
          {callouts.map(({ row, ax, ay, ex, ey, ly, side }) => {
            const railX = geom.cx + side * geom.rail
            const textX = railX + side * 10
            const dim = Boolean(active) && row.id !== active
            const dot = row.kind === 'cat' ? row.color : 'var(--ink-3)'
            return (
              <g key={row.id} style={{ opacity: dim ? 0.32 : 1, transition: 'opacity var(--dur-fast) var(--ease)' }}>
                {/* จุดยึด → ออกตามแนวรัศมี → ออกด้านข้างจนพ้นวง → เลี้ยวไปหาป้าย
                    ทุกช่วงหลังจุดที่สองอยู่พ้นรัศมีนอกสุด เส้นจึงไม่พาดทับวง */}
                <polyline
                  points={`${ax},${ay} ${ex},${ey} ${geom.cx + side * geom.gutter},${ey} ${railX},${ly}`}
                  fill="none"
                  stroke="var(--line)"
                  strokeWidth="1"
                />
                <circle cx={ax} cy={ay} r="2.5" fill={dot} />
                <text x={textX} y={ly - 3} textAnchor={side === 1 ? 'start' : 'end'} className="fill-ink" style={{ fontSize: '12.5px', fontWeight: 600 }}>
                  {row.label}
                </text>
                <text x={textX} y={ly + 13} textAnchor={side === 1 ? 'start' : 'end'} className="fill-ink-3" style={{ fontSize: '11.5px', fontVariantNumeric: 'tabular-nums' }}>
                  {`${amount(row.bytes)} · ${share(row.bytes)}`}
                </text>
              </g>
            )
          })}
        </g>
      )}

      {centre}
    </svg>
  )
}

/* ── legend rows ──────────────────────────────────────────────────── */

function LegendRows({ rows, pinned, setPinned, setHovered, amount, share, shareLabel }) {
  return (
    <ul className="flex flex-col border-t border-line">
      {rows.map((row) => {
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
                คำอธิบายต่อท้าย aria-label ด้วย ไม่ใช่อยู่ใน title อย่างเดียว —
                title เป็นของเมาส์เท่านั้น คีย์บอร์ดจะไม่มีวันได้ยิน */}
            <button
              type="button"
              aria-pressed={pinned === row.id}
              aria-label={`${row.label}: ${amount(row.bytes)}, ${share(row.bytes)} ${shareLabel}${row.hint ? `. ${row.hint}` : ''}`}
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
  )
}

function LegendHead({ title, shareLabel, categoryLabel, sizeLabel, sub }) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <p className="text-[12px] font-semibold text-ink">{title}</p>
        {sub && <p className="text-[11.5px] text-ink-3" style={{ fontVariantNumeric: 'tabular-nums' }}>{sub}</p>}
      </div>
      <div className={`${ROW_GRID} px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3`} aria-hidden>
        <span />
        <span>{categoryLabel}</span>
        <span className="text-right">{sizeLabel}</span>
        <span className="text-right">{shareLabel}</span>
      </div>
    </>
  )
}

/* ── the card ─────────────────────────────────────────────────────── */

export function CapacityCard({ t, capacityBytes, usage, unaccountedBytes }) {
  // useId คืนค่าที่มีอักขระพิเศษ (React 19 ใช้ «r0») ซึ่งอ้างอิงผ่าน url(#…) ไม่ได้เสมอไป
  const hatchId = `cap-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [hovered, setHovered] = useState(null)
  const [pinned, setPinned] = useState(null)
  const wide = useWideRing()
  const active = hovered ?? pinned

  const total = capacityBytes?.totalBytes ?? 0
  const free = capacityBytes?.freeBytes ?? 0
  const used = capacityBytes?.usedBytes ?? 0
  const unaccounted = unaccountedBytes ?? 0

  const model = useMemo(() => {
    const cats = SEG.map((s) => ({ id: s.key, kind: 'cat', color: s.color, label: t(s.key), bytes: usage?.[s.key] ?? 0 }))
    const aegisTotal = cats.reduce((sum, c) => sum + c.bytes, 0)

    // วงนอก — ฐานคือทั้ง volume
    const volumeParts = [
      { id: 'aegis', kind: 'cat', color: 'var(--accent)', label: t('capacityAegisData'), hint: t('capacityAegisHint'), bytes: aegisTotal },
      ...(unaccounted > 0 ? [{ id: 'unaccounted', kind: 'hatch', label: t('unaccounted'), hint: t('unaccountedHint'), bytes: unaccounted }] : []),
      { id: 'free', kind: 'free', label: t('free'), bytes: free },
    ].map((p) => ({ ...p, frac: total > 0 ? p.bytes / total : 0 }))

    // วงใน — ฐานคือผลรวมข้อมูลของ AEGIS เท่านั้น (ประกาศไว้ข้างวง)
    const present = cats.filter((c) => c.bytes > 0).sort((a, b) => b.bytes - a.bytes)
    const absent = cats.filter((c) => c.bytes === 0)
    const aegisParts = present.map((p) => ({ ...p, frac: aegisTotal > 0 ? p.bytes / aegisTotal : 0 }))

    return {
      aegisTotal,
      volume: ringLayout(volumeParts),
      aegis: ringLayout(aegisParts),
      aegisLegend: [...ringLayout(aegisParts), ...absent.map((a) => ({ ...a, span: 0, startFrac: 0, midFrac: 0, floored: false, frac: 0 }))],
    }
  }, [t, usage, unaccounted, free, total])

  const pct = (bytes, base) => {
    if (base <= 0 || bytes <= 0) return '0%'
    const p = (bytes / base) * 100
    return p < 0.1 ? t('capacityTinyShare') : `${p.toFixed(1)}%`
  }
  const shareOfVolume = (bytes) => pct(bytes, total)
  const shareOfAegis = (bytes) => pct(bytes, model.aegisTotal)
  const amount = (bytes) => (bytes === 0 ? t('storageZeroGb') : fmtBytes(bytes))
  const usedPct = total > 0 ? ((used / total) * 100).toFixed(1) : '0.0'

  // ระบบไฟล์ไม่รายงานความจุ = ไม่มีฐานให้คิดสัดส่วน จึงไม่วาดวงและบอกเหตุผลตรง ๆ
  if (!capacityBytes || total <= 0) {
    return (
      <Card className="p-5">
        <CardTitle sub={t('capacitySub')}>{t('capacity')}</CardTitle>
        <NotYetImplemented label={t('notAvailable')}>{t('capacityUnreadable')}</NotYetImplemented>
      </Card>
    )
  }

  const volumeGeom = wide ? VOLUME_WIDE : VOLUME_COMPACT
  const aegisGeom = wide ? AEGIS_WIDE : AEGIS_COMPACT
  const anyFloored = model.volume.some((r) => r.floored) || model.aegis.some((r) => r.floored)
  const activeVolume = model.volume.find((r) => r.id === active) ?? null
  const activeAegis = model.aegis.find((r) => r.id === active) ?? null

  const hatchDefs = (
    <defs>
      {/* ลายขวาง 45° เดียวกับ .hatch-ink3 — ที่นี่ต้องเป็น SVG pattern เพราะเป็น stroke ไม่ใช่ background */}
      <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="6" height="6" fill="var(--card-sunken)" />
        <line x1="0.5" y1="0" x2="0.5" y2="6" stroke="var(--ink-3)" strokeOpacity="0.55" strokeWidth="1" />
      </pattern>
    </defs>
  )

  const volumeCentre = activeVolume ? (
    <>
      <text x={volumeGeom.cx} y={volumeGeom.cy - 12} textAnchor="middle" className="fill-ink" style={{ fontSize: '12px', fontWeight: 600 }}>{activeVolume.label}</text>
      <text x={volumeGeom.cx} y={volumeGeom.cy + 9} textAnchor="middle" className="fill-ink" style={{ fontSize: '17px', fontVariantNumeric: 'tabular-nums' }}>{amount(activeVolume.bytes)}</text>
      <text x={volumeGeom.cx} y={volumeGeom.cy + 26} textAnchor="middle" className="fill-ink-3" style={{ fontSize: '11.5px', fontVariantNumeric: 'tabular-nums' }}>{shareOfVolume(activeVolume.bytes)}</text>
    </>
  ) : (
    <>
      <text x={volumeGeom.cx} y={volumeGeom.cy + 4} textAnchor="middle" className="fill-ink" style={{ fontSize: '32px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{usedPct}%</text>
      <text x={volumeGeom.cx} y={volumeGeom.cy + 25} textAnchor="middle" className="fill-ink-3" style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em' }}>{t('capacityUsed').toUpperCase()}</text>
    </>
  )

  const aegisCentre = activeAegis ? (
    <>
      <text x={aegisGeom.cx} y={aegisGeom.cy - 8} textAnchor="middle" className="fill-ink" style={{ fontSize: '11.5px', fontWeight: 600 }}>{activeAegis.label}</text>
      <text x={aegisGeom.cx} y={aegisGeom.cy + 12} textAnchor="middle" className="fill-ink" style={{ fontSize: '15px', fontVariantNumeric: 'tabular-nums' }}>{shareOfAegis(activeAegis.bytes)}</text>
    </>
  ) : (
    <>
      <text x={aegisGeom.cx} y={aegisGeom.cy + 2} textAnchor="middle" className="fill-ink" style={{ fontSize: '17px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{amount(model.aegisTotal)}</text>
      <text x={aegisGeom.cx} y={aegisGeom.cy + 21} textAnchor="middle" className="fill-ink-3" style={{ fontSize: '10.5px', fontWeight: 600, letterSpacing: '0.07em' }}>{t('capacityAegisData').toUpperCase()}</text>
    </>
  )

  const volumeRing = (
    <div className="relative w-full">
      {hatchDefs && <svg width="0" height="0" className="absolute" aria-hidden>{hatchDefs}</svg>}
      <Ring
        rows={model.volume}
        geom={volumeGeom}
        hatchId={hatchId}
        active={active}
        callouts={wide ? layoutCallouts(model.volume, volumeGeom) : null}
        centre={volumeCentre}
        amount={amount}
        share={shareOfVolume}
        label={t('capacityRingLabel', { used: fmtBytes(used), total: fmtBytes(total), free: amount(free), pct: usedPct })}
      />
    </div>
  )

  const aegisRing = model.aegisTotal > 0 ? (
    <Ring
      rows={model.aegis}
      geom={aegisGeom}
      hatchId={hatchId}
      active={active}
      callouts={null}
      centre={aegisCentre}
      amount={amount}
      share={shareOfAegis}
      label={t('capacityAegisRingLabel', { total: fmtBytes(model.aegisTotal), n: String(model.aegis.length) })}
    />
  ) : null

  const totals = (
    <dl className="grid grid-cols-4 gap-x-6 gap-y-4 max-md:grid-cols-2">
      {[
        [t('capacityTotal'), amount(total)],
        [t('capacityUsed'), amount(used)],
        [t('free'), amount(free)],
        [t('capacityUsedPct'), `${usedPct}%`],
      ].map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">{label}</dt>
          <dd className="text-[16px] font-mono text-ink mt-0.5" style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</dd>
        </div>
      ))}
    </dl>
  )

  const volumeLegend = (
    <div className="min-w-0">
      <LegendHead title={t('capacityVolumeGroup')} shareLabel={t('capacityLegendShare')} categoryLabel={t('capacityLegendCategory')} sizeLabel={t('capacityLegendSize')} sub={amount(total)} />
      <LegendRows rows={model.volume} pinned={pinned} setPinned={setPinned} setHovered={setHovered} amount={amount} share={shareOfVolume} shareLabel={t('capacityLegendShare')} />
    </div>
  )

  const aegisLegend = (
    <div className="min-w-0">
      <LegendHead title={t('capacityAegisGroup')} shareLabel={t('capacityShareOfAegis')} categoryLabel={t('capacityLegendCategory')} sizeLabel={t('capacityLegendSize')} sub={amount(model.aegisTotal)} />
      {/* แถวยังแสดงเสมอแม้ผลรวมเป็นศูนย์ — รายชื่อหมวดคือสิ่งที่บอกว่า "มีหมวดอะไรบ้าง"
          ถ้าซ่อนไปตอนยังไม่มีไฟล์ ผู้ดูแลจะไม่มีทางรู้ว่าระบบรู้จักหมวดใดบ้างเลย */}
      <LegendRows rows={model.aegisLegend} pinned={pinned} setPinned={setPinned} setHovered={setHovered} amount={amount} share={shareOfAegis} shareLabel={t('capacityShareOfAegis')} />
      {model.aegisTotal > 0 ? (
        /* ⚠️ ฐานของกลุ่มนี้ต่างจากกลุ่มบน ต้องประกาศไว้ ไม่ใช่ให้เดาเอง */
        <p className="text-[11.5px] text-ink-3 leading-relaxed mt-2 px-2">
          {t('capacityAegisBase', { total: amount(model.aegisTotal) })}
        </p>
      ) : (
        <p className="text-[12.5px] text-ink-3 leading-relaxed mt-2 px-2">{t('capacityAegisEmpty')}</p>
      )}
    </div>
  )

  return (
    <Card className="p-5">
      <CardTitle sub={t('capacitySub')}>{t('capacity')}</CardTitle>

      <div className="flex flex-col gap-6">
        {/* วงนอกกับวงในเคียงกัน — ฐานต่างกันจึงต้องเห็นพร้อมกัน ไม่ใช่สลับแท็บ */}
        <div className={wide ? 'grid grid-cols-[minmax(0,1fr)_240px] gap-x-10 items-center' : 'grid grid-cols-1 gap-6 justify-items-center'}>
          <div className={wide ? 'min-w-0' : 'w-[260px]'}>{volumeRing}</div>
          {aegisRing && (
            <div className={wide ? 'w-[240px]' : 'w-[220px]'}>
              {aegisRing}
            </div>
          )}
        </div>

        <div className="pt-1 border-t border-line" />
        {totals}

        <div className={wide ? 'grid grid-cols-2 gap-x-10 gap-y-6 items-start' : 'grid grid-cols-1 gap-6'}>
          {volumeLegend}
          {aegisLegend}
        </div>

        {anyFloored && (
          <p className="text-[11.5px] text-ink-3 leading-relaxed">{t('capacityFloorNote')}</p>
        )}
      </div>
    </Card>
  )
}
