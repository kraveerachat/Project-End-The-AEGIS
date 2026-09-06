import { localeFor, makeT, normalizeLanguage } from './i18n.js'

const dateFormats = new Map()
const numberFormats = new Map()

function dateFormat(language) {
  const locale = localeFor(language)
  if (!dateFormats.has(locale)) {
    dateFormats.set(locale, new Intl.DateTimeFormat(locale, {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }))
  }
  return dateFormats.get(locale)
}

function numberFormat(language) {
  const locale = localeFor(language)
  if (!numberFormats.has(locale)) numberFormats.set(locale, new Intl.NumberFormat(locale))
  return numberFormats.get(locale)
}

function formattedUnit(value, unit, language) {
  const t = makeT(language)
  const form = value === 1 ? 'one' : 'many'
  return `${formatCount(value, language)} ${t(`unit.${unit}.${form}`)}`
}

export function formatDateTime(value, language = 'th') {
  const t = makeT(language)
  if (!value) return t('time.missing')
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? t('time.invalid') : dateFormat(language).format(date)
}

export function formatCount(value, language = 'th') {
  return numberFormat(language).format(Number.isFinite(value) ? value : 0)
}

export function formatEvidenceAge(ageMs, language = 'th') {
  const normalizedLanguage = normalizeLanguage(language)
  const t = makeT(normalizedLanguage)
  if (!Number.isFinite(ageMs)) return t('age.unknown')
  if (ageMs < 1_000) return t('age.now')
  if (ageMs < 60_000) return t('age.past', { value: formattedUnit(Math.floor(ageMs / 1_000), 'second', normalizedLanguage) })
  if (ageMs < 3_600_000) {
    const minutes = Math.floor(ageMs / 60_000)
    const seconds = Math.floor((ageMs % 60_000) / 1_000)
    const value = [formattedUnit(minutes, 'minute', normalizedLanguage), seconds ? formattedUnit(seconds, 'second', normalizedLanguage) : null].filter(Boolean).join(' ')
    return t('age.past', { value })
  }
  if (ageMs < 86_400_000) {
    const hours = Math.floor(ageMs / 3_600_000)
    const minutes = Math.floor((ageMs % 3_600_000) / 60_000)
    const value = [formattedUnit(hours, 'hour', normalizedLanguage), minutes ? formattedUnit(minutes, 'minute', normalizedLanguage) : null].filter(Boolean).join(' ')
    return t('age.past', { value })
  }
  return t('age.past', { value: formattedUnit(Math.floor(ageMs / 86_400_000), 'day', normalizedLanguage) })
}
