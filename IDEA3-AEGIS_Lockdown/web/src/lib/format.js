const thaiDate = new Intl.DateTimeFormat('th-TH', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})
const integer = new Intl.NumberFormat('th-TH')

export function formatDateTime(value) {
  if (!value) return 'ไม่มีหลักฐานเวลา'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'เวลาไม่ถูกต้อง' : thaiDate.format(date)
}

export function formatCount(value) {
  return integer.format(Number.isFinite(value) ? value : 0)
}

export function formatEvidenceAge(ageMs) {
  if (!Number.isFinite(ageMs)) return 'ไม่ทราบอายุหลักฐาน'
  if (ageMs < 1_000) return 'ล่าสุดขณะนี้'
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)} วินาทีที่แล้ว`
  if (ageMs < 3_600_000) {
    const minutes = Math.floor(ageMs / 60_000)
    const seconds = Math.floor((ageMs % 60_000) / 1_000)
    return `${minutes} นาที${seconds ? ` ${seconds} วินาที` : ''}ที่แล้ว`
  }
  if (ageMs < 86_400_000) {
    const hours = Math.floor(ageMs / 3_600_000)
    const minutes = Math.floor((ageMs % 3_600_000) / 60_000)
    return `${hours} ชั่วโมง${minutes ? ` ${minutes} นาที` : ''}ที่แล้ว`
  }
  return `${Math.floor(ageMs / 86_400_000)} วันที่แล้ว`
}
