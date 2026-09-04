import { useEffect, useId, useMemo, useState } from 'react'
import { Card, CardTitle, NotYetImplemented } from './ui.jsx'
import { fmtBytes } from '../lib/format.js'

/* ── การ์ดความจุ — วงแหวนพร้อมป้ายชี้ (callout) ───────────────────────────────
   ของเดิมเป็นแท่งเดียวยาวขวางการ์ด แล้วเปลี่ยนเป็นวงแหวน + ตาราง legend
   รอบนี้วงแหวนถูกขยายบนจอกว้างและมี "ป้ายชี้" รอบวง เพราะบน production จริง
   หมวดของ AEGIS (เอกสาร / เวอร์ชันก่อนหน้า / ห้องนิรภัย ฯลฯ) เล็กมากเมื่อเทียบกับ
   ทั้ง filesystem — เส้นรอบวงเกือบทั้งหมดจึงเป็น "อื่น ๆ บน volume นี้" กับพื้นที่ว่าง
   และหมวดจริงกลายเป็นขีดบาง ๆ ที่อ่านไม่ออกว่าคืออะไร

   สิ่งที่วงแหวนนี้ยึดไว้ ห้ามแก้โดยไม่คิด:

   1. 360° = totalBytes เสมอ ไม่ใช่ผลรวมของสิ่งที่ใช้ไป — ส่วนที่เติมไว้ "คือ" สัดส่วน
      ที่ใช้ไปโดยไม่ต้องอ่านตัวเลข

   2. ลายขวาง (hatch) มีความหมายเดียวทั้งผลิตภัณฑ์: **ระบบมองไม่เห็นว่าตรงนั้นคืออะไร**
      - "อื่น ๆ บน volume นี้" = ไบต์ที่ statfs นับว่าใช้ไปแล้วแต่แอปนี้ระบุไม่ได้ → ลายขวาง
      - "พื้นที่ว่าง" = ค่าที่ statfs วัดมาแล้วและรู้แน่ว่าว่าง → พื้นเรียบกลาง ๆ ไม่ใช่ลายขวาง

   3. หมวดที่เล็กเกินกว่าจะวาดเป็นส่วนโค้งได้ **ต้องไม่ถูกขยายมุมให้ดูใหญ่ขึ้น**
      ป้ายชี้ทำให้อ่านชื่อและตัวเลขได้ แต่ "มุม" ของมันยังเป็นมุมจริง หมวดที่เล็กกว่า
      เกณฑ์มองเห็นถูกวาดเป็น "ขีด" (TICK) ที่บางกว่าความหนาวงแหวน จึงอ่านออกทันทีว่า
      เป็นเครื่องหมายตำแหน่ง ไม่ใช่สัดส่วน — และป้ายชี้ของมันลากจากตำแหน่งจริงนั้น
      **ตัวเลขที่เชื่อถือได้อยู่ที่ป้ายชี้และ legend เสมอ** (ไบต์จริง + สัดส่วนจริง,
      ต่ำกว่า 0.1% แสดงเป็น "<0.1%" ไม่ใช่ 0.0% ที่ปัดแล้วดูเหมือนศูนย์)

   4. เกณฑ์ "เล็กเกินวาด" คิดเป็น *สัดส่วนของวง* ไม่ใช่พิกเซล — วงเล็กกับวงใหญ่จึงชี้
      หมวดชุดเดียวกันว่าเป็นขีดเสมอ ถ้าผูกกับพิกเซล การย่อ/ขยายหน้าต่างจะทำให้
      หมายเหตุใต้ตารางเปลี่ยนไปมาโดยที่ข้อมูลไม่ได้เปลี่ยนเลย

   ไม่มีค่าใดในไฟล์นี้ถูกคิดขึ้นเอง ทุกไบต์มาจาก /api/storage (capacityBytes จาก statfs,
   usage จากผลรวมในฐานข้อมูล, unaccountedBytes = used − accounted) อ่านค่าไม่ได้ = บอกตรง ๆ
   สัญญาของ /api/storage ไม่ถูกแตะในรอบนี้ */

const SEG = [
  { key: 'docs', color: 'var(--accent)' },
  { key: 'archives', color: 'var(--ink-3)' },
  { key: 'media', color: 'var(--violet)' },
  { key: 'vaultSeg', color: 'var(--ink)' },
  { key: 'versions', color: 'var(--warn)' },
  { key: 'other', color: 'var(--accent-ink)' },
]

/* เกณฑ์มองเห็น: 2px บนวงรัศมี 82 คือจุดที่ส่วนโค้งเริ่มหายไปจริง ๆ (≈0.39% ของวง)
   เก็บไว้เป็น "สัดส่วน" เพื่อให้ทุกขนาดวงตัดสินเหมือนกัน (ดูข้อ 4 ด้านบน) */
const MIN_FRAC = 2 / (2 * Math.PI * 82)
const GAP_FRAC = 1.5 / (2 * Math.PI * 82) // ช่องว่างระหว่างส่วนโค้ง — เผยรางสี --line

/* สองขนาด: วงกะทัดรัดสำหรับการ์ดแคบ และวงใหญ่พร้อมป้ายชี้สำหรับจอกว้าง
   ป้ายชี้ต้องการที่ว่างซ้าย/ขวาของวง จึงเป็นคนละ viewBox ไม่ใช่แค่ย่อขยายอันเดิม */
const COMPACT = { w: 260, h: 260, cx: 130, cy: 130, r: 92, band: 28, tick: 11, grow: 6 }
/* rail = ระยะจากจุดศูนย์กลางถึงแนวตั้งที่ป้ายเรียงกัน, gutter = ระยะที่เส้นชี้ต้อง
   ออกให้พ้นวงก่อนจะเลี้ยวลงไปหาป้าย — ต้องมากกว่ารัศมีนอกสุด (r + band/2 = 143)
   ไม่งั้นเส้นทแยงจากป้ายที่อยู่ต่ำกว่าจุดยึดมากจะ "ตัดผ่านวงแหวน" */
const WIDE = { w: 780, h: 420, cx: 390, cy: 210, r: 132, band: 40, tick: 16, grow: 7, rail: 210, gutter: 178, pad: 26 }

const LABEL_GAP = 42 // ระยะห่างแนวตั้งขั้นต่ำระหว่างป้ายชี้สองใบฝั่งเดียวกัน (ป้ายสูงสองบรรทัด)

/**
 * แปลงสัดส่วนจริงเป็นสัดส่วนที่ "วาด" โดยรับประกันสองอย่างพร้อมกัน:
 * หมวดที่ไม่เป็นศูนย์ต้องมองเห็น และวงแหวนต้องปิดที่ 360° พอดี
 * สัดส่วนที่ยืมมาให้ขีดขั้นต่ำถูกหักคืนตามสัดส่วนจากส่วนที่วาดตามจริง
 * (ในทางปฏิบัติคือพื้นที่ว่าง ซึ่งใหญ่กว่ามาก) — ส่วนที่ถูกยืมถูกทำเครื่องหมาย floored
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
      strokeDasharray={`${drawn} ${Math.max(0, C - drawn)}`}
      strokeDashoffset={-row.startFrac * C}
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

/**
 * วางป้ายชี้รอบวงโดยไม่ให้ทับกัน: แยกซ้าย/ขวาตามตำแหน่งจริงของส่วนโค้ง แล้วดัน
 * ป้ายในแต่ละฝั่งให้ห่างกันอย่างน้อย LABEL_GAP โดยยังเรียงตามลำดับบน→ล่างเดิม
 * เส้นชี้ยังลากจาก "ตำแหน่งจริง" บนวงเสมอ การเลื่อนเกิดกับป้ายเท่านั้น ไม่ใช่กับมุม
 */
function layoutCallouts(rows, geom) {
  const anchored = rows.map((row) => {
    const angle = row.midFrac * 2 * Math.PI - Math.PI / 2
    const outer = geom.r + geom.band / 2
    return {
      row,
      angle,
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
    const top = geom.pad
    const bottom = geom.h - geom.pad

    let cursor = -Infinity
    for (const item of column) {
      item.ly = Math.max(item.ey, cursor + LABEL_GAP)
      cursor = item.ly
    }
    // ถ้าล้นขอบล่าง ดันทั้งคอลัมน์ขึ้น แล้วค่อยกันไม่ให้ทะลุขอบบน
    const overflow = column.length ? column[column.length - 1].ly - bottom : 0
    if (overflow > 0) for (const item of column) item.ly -= overflow
    let floor = top
    for (const item of column) {
      item.ly = Math.max(item.ly, floor)
      floor = item.ly + LABEL_GAP
    }
    placed.push(...column)
  }
  return placed
}

const ROW_GRID = 'grid grid-cols-[14px_minmax(0,1fr)_auto_58px] items-center gap-x-3'

/** จอกว้างพอจะวางป้ายชี้รอบวงหรือยัง — ต่ำกว่านี้ป้ายจะทับกันเองจนอ่านยากกว่าเดิม */
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
    return { drawn: laid, legend: [...laid, ...absent.map((a) => ({ ...a, span: 0, startFrac: 0, midFrac: 0, floored: false, frac: 0 }))] }
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

  const geom = wide ? WIDE : COMPACT
  const paintOf = (row) => (row.kind === 'hatch' ? `url(#${hatchId})` : row.kind === 'free' ? 'var(--card-sunken)' : row.color)
  const widthOf = (row) => {
    const base = row.floored ? geom.tick : row.kind === 'free' ? geom.band - 2 : geom.band
    return row.id === active ? base + geom.grow : base
  }
  const callouts = wide ? layoutCallouts(drawn, geom) : []

  const ring = (
    <svg
      viewBox={`0 0 ${geom.w} ${geom.h}`}
      className="w-full h-auto"
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

      <g transform={`rotate(-90 ${geom.cx} ${geom.cy})`}>
        {/* รางเต็มวง: ทำให้ช่องว่างระหว่างส่วนโค้งอ่านเป็นเส้นแบ่ง ไม่ใช่รูโหว่ */}
        <circle cx={geom.cx} cy={geom.cy} r={geom.r} fill="none" stroke="var(--line)" strokeWidth={geom.band} />
        {drawn.map((row) => (
          <Arc key={row.id} row={row} geom={geom} paint={paintOf(row)} width={widthOf(row)} dim={Boolean(active) && row.id !== active} />
        ))}
      </g>

      {/* ป้ายชี้ — aria-hidden เพราะวงมี aria-label สรุปอยู่แล้ว และ legend ด้านล่าง
          เป็นตัวเลขชุดเดียวกันในรูปแบบที่กดได้จริง การอ่านซ้ำสามรอบไม่ช่วยใคร */}
      {callouts.length > 0 && (
        <g aria-hidden>
          {callouts.map(({ row, ax, ay, ex, ey, ly, side }) => {
            const railX = geom.cx + side * geom.rail
            const textX = railX + side * 10
            const dim = Boolean(active) && row.id !== active
            const stroke = row.kind === 'cat' ? row.color : 'var(--ink-3)'
            return (
              <g key={row.id} style={{ opacity: dim ? 0.35 : 1, transition: 'opacity var(--dur-fast) var(--ease)' }}>
                {/* จุดยึด → ออกตามแนวรัศมี → ออกด้านข้างจนพ้นวง → ค่อยเลี้ยวไปหาป้าย
                    ทุกช่วงหลังจุดที่สองอยู่ห่างจากศูนย์กลางเกินรัศมีนอกสุดเสมอ เส้นจึง
                    ไม่มีทางพาดทับวงแหวนแม้ป้ายจะถูกดันลงไปไกลจากจุดยึดแค่ไหน */}
                <polyline
                  points={`${ax},${ay} ${ex},${ey} ${geom.cx + side * geom.gutter},${ey} ${railX},${ly}`}
                  fill="none"
                  stroke="var(--line)"
                  strokeWidth="1"
                />
                {/* จุดที่ปลายเส้นบอก "ตำแหน่งจริง" ของหมวดบนวง — สำคัญกับหมวดที่ถูกวาด
                    เป็นขีด เพราะขีดเล็กเกินกว่าจะชี้ตัวเองได้ */}
                <circle cx={ax} cy={ay} r="2.5" fill={stroke} />
                <text
                  x={textX}
                  y={ly - 3}
                  textAnchor={side === 1 ? 'start' : 'end'}
                  className="fill-ink"
                  style={{ fontSize: '12.5px', fontWeight: 600 }}
                >
                  {row.label}
                </text>
                <text
                  x={textX}
                  y={ly + 13}
                  textAnchor={side === 1 ? 'start' : 'end'}
                  className="fill-ink-3"
                  style={{ fontSize: '11.5px', fontVariantNumeric: 'tabular-nums' }}
                >
                  {`${amount(row.bytes)} · ${share(row.bytes)}`}
                </text>
              </g>
            )
          })}
        </g>
      )}

      {/* แกนกลาง: ค่าที่ชี้อยู่ ถ้าไม่มีก็สรุปว่าใช้ไปกี่เปอร์เซ็นต์ */}
      {activeRow ? (
        <>
          <text x={geom.cx} y={geom.cy - 12} textAnchor="middle" className="fill-ink" style={{ fontSize: '12px', fontWeight: 600 }}>{activeRow.label}</text>
          <text x={geom.cx} y={geom.cy + 9} textAnchor="middle" className="fill-ink" style={{ fontSize: '17px', fontVariantNumeric: 'tabular-nums' }}>{amount(activeRow.bytes)}</text>
          <text x={geom.cx} y={geom.cy + 26} textAnchor="middle" className="fill-ink-3" style={{ fontSize: '11.5px', fontVariantNumeric: 'tabular-nums' }}>{share(activeRow.bytes)}</text>
        </>
      ) : (
        <>
          <text x={geom.cx} y={geom.cy + 4} textAnchor="middle" className="fill-ink" style={{ fontSize: '30px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{usedPct}%</text>
          <text x={geom.cx} y={geom.cy + 24} textAnchor="middle" className="fill-ink-3" style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em' }}>{t('capacityUsed').toUpperCase()}</text>
        </>
      )}
    </svg>
  )

  const legendTable = (
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
  )

  /* ยอดรวมสี่ค่าที่ต้องอ่านได้โดยไม่ต้องตีความวงแหวน — บนจอกว้างเป็นคอลัมน์ที่คั่นด้วย
     เส้น 1px ตามโครง (ไม่ใช่แถบสีตกแต่ง) แคบกว่านั้นไหลลงเป็นแถวล่าง */
  const totals = (
    <dl className="grid gap-y-4 gap-x-6 self-stretch content-center pl-10 border-l border-line xl:w-[168px] max-xl:w-full max-xl:grid-cols-4 max-xl:border-l-0 max-xl:border-t max-xl:pl-0 max-xl:pt-4 max-md:grid-cols-2">
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
  )

  return (
    <Card className="p-5">
      <CardTitle sub={t('capacitySub')}>{t('capacity')}</CardTitle>

      {wide ? (
        /* จอกว้าง: วงใหญ่พร้อมป้ายชี้กินความกว้างเต็ม แล้วตาราง legend (ตัวเลขที่กดได้)
           กับยอดรวมวางเป็นแถวล่าง — ป้ายชี้ตอบ "อะไรอยู่ตรงไหน" ตารางตอบ "เท่าไรกันแน่" */
        <div className="flex flex-col gap-6">
          <div className="mx-auto w-full max-w-[900px]">{ring}</div>
          <div className="flex items-start gap-10 max-xl:flex-col max-xl:gap-6">
            {legendTable}
            <div className="flex-1" />
            {totals}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[260px_minmax(0,1fr)] gap-x-10 gap-y-6 items-center max-md:grid-cols-1">
          <div className="w-[260px] shrink-0 max-md:justify-self-center">{ring}</div>
          {legendTable}
          <div className="col-span-2 max-md:col-span-1">{totals}</div>
        </div>
      )}
    </Card>
  )
}
