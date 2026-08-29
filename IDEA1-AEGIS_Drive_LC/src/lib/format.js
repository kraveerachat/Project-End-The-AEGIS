/** 4812339 → "4.8 MB" — binary-ish display units, one decimal where useful. */
export function fmtBytes(bytes) {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = -1
  do {
    v /= 1024
    i += 1
  } while (v >= 1024 && i < units.length - 1)
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** Relative time via i18n templates: t('minAgo', { n }) etc. */
export function fmtRelative(t, time, now = Date.now()) {
  const diff = Math.max(0, now - time)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return t('justNow')
  if (min < 60) return t('minAgo', { n: min })
  const h = Math.floor(min / 60)
  if (h < 24) return t('hourAgo', { n: h })
  return t('dayAgo', { n: Math.floor(h / 24) })
}

/** Live countdown "5h 12m" / "41m 08s" / "EXPIRED". */
export function fmtCountdown(msLeft, expiredLabel = 'EXPIRED') {
  if (msLeft <= 0) return expiredLabel
  const s = Math.floor(msLeft / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  return `${m}m ${String(sec).padStart(2, '0')}s`
}

export function fmtDateTime(time, lang = 'en') {
  const locale = lang === 'th' ? 'th-TH' : lang === 'zh' ? 'zh-CN' : 'en-GB'
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(time)
}

/** ISO-ish timestamp for the audit ledger's mono column. */
export function fmtStamp(time) {
  const d = new Date(time)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Break a 64-char hash into 8-char groups for legibility. */
export function fmtHashGroups(sha) {
  return sha.match(/.{1,8}/g) ?? [sha]
}

/**
 * 61234567 → "58.4 MB/s" — ความเร็วจริงของการโอน
 * ⚠️ ใช้หน่วยชุดเดียวกับ fmtBytes โดยเจตนา: ตัวเลข "ที่โอนไปแล้ว" กับ "ความเร็ว" อยู่
 *    บรรทัดติดกันบนจอเดียวกัน ถ้าใช้คนละฐาน (1000 vs 1024) ผู้ใช้จะหารสองตัวนี้แล้ว
 *    ไม่ได้เวลาที่เห็นอยู่ตรงหน้า
 * ⚠️ null = "ยังไม่รู้" ไม่ใช่ "ศูนย์" — จอต้องไม่แสดง 0 B/s ตอนที่ยังไม่มีตัวอย่างพอ
 */
export function fmtRate(bytesPerSecond) {
  if (bytesPerSecond == null || !Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return null
  return `${fmtBytes(Math.round(bytesPerSecond))}/s`
}
