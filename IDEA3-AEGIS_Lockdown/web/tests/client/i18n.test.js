import { describe, expect, it } from 'vitest'
import {
  LANGUAGE_OPTIONS, LANGS, STRINGS, htmlLanguage, localeFor, makeT,
  normalizeLanguage, statusLabel,
} from '../../src/lib/i18n.js'
import { formatCount, formatDateTime, formatEvidenceAge } from '../../src/lib/format.js'

describe('Dashboard language contract', () => {
  it('falls back to Thai for unsupported or missing persisted values', () => {
    expect(normalizeLanguage()).toBe('th')
    expect(normalizeLanguage('fr')).toBe('th')
    expect(normalizeLanguage('en')).toBe('en')
    expect(normalizeLanguage('zh')).toBe('zh')
  })

  it('uses the approved selector labels and document locales', () => {
    expect(LANGS).toEqual(['th', 'en', 'zh'])
    expect(LANGUAGE_OPTIONS).toEqual([
      { value: 'th', label: 'ไทย' },
      { value: 'en', label: 'EN' },
      { value: 'zh', label: '中文' },
    ])
    expect(htmlLanguage('th')).toBe('th')
    expect(htmlLanguage('en')).toBe('en')
    expect(htmlLanguage('zh')).toBe('zh-CN')
    expect(localeFor('th')).toBe('th-TH')
    expect(localeFor('en')).toBe('en-US')
    expect(localeFor('zh')).toBe('zh-CN')
  })

  it('keeps every language dictionary in exact key parity', () => {
    const thaiKeys = Object.keys(STRINGS.th).sort()
    expect(Object.keys(STRINGS.en).sort()).toEqual(thaiKeys)
    expect(Object.keys(STRINGS.zh).sort()).toEqual(thaiKeys)
  })

  it('interpolates values and exposes a missing key instead of mixing languages', () => {
    expect(makeT('zh')('count.items', { count: 3 })).toBe('3 项')
    expect(makeT('en')('missing.translation')).toBe('missing.translation')
  })

  it.each([
    ['HEALTHY', 'ปกติ', 'Healthy', '正常'],
    ['DEGRADED', 'ทำงานแบบจำกัด', 'Degraded', '性能受限'],
    ['FAILED', 'ขัดข้อง', 'Failed', '故障'],
    ['UNKNOWN', 'ไม่ทราบสถานะ', 'Unknown', '未知'],
    ['NOT_CONFIGURED', 'ยังไม่ได้ตั้งค่า', 'Not configured', '未配置'],
    ['STALE', 'ข้อมูลล้าสมัย', 'Stale', '数据过期'],
    ['DISABLED', 'ปิดใช้งาน', 'Disabled', '已禁用'],
    ['CONNECTED', 'เชื่อมต่อแล้ว', 'Connected', '已连接'],
    ['DISCONNECTED', 'ขาดการเชื่อมต่อ', 'Disconnected', '已断开'],
    ['NOT_VERIFIED', 'ยังไม่ได้ยืนยัน', 'Not verified', '未验证'],
  ])('localizes %s without changing the raw status', (status, th, en, zh) => {
    expect(statusLabel(status, 'th')).toBe(th)
    expect(statusLabel(status, 'en')).toBe(en)
    expect(statusLabel(status, 'zh')).toBe(zh)
  })

  it('fails unknown future states closed to the localized unknown label', () => {
    expect(statusLabel('FUTURE_STATE', 'th')).toBe('ไม่ทราบสถานะ')
    expect(statusLabel('FUTURE_STATE', 'en')).toBe('Unknown')
    expect(statusLabel('FUTURE_STATE', 'zh')).toBe('未知')
  })
})

describe('Dashboard locale formatting', () => {
  it('formats counts with the selected locale', () => {
    expect(formatCount(12345, 'en')).toBe('12,345')
    expect(formatCount(12345, 'zh')).toBe('12,345')
    expect(formatCount(Number.NaN, 'en')).toBe('0')
  })

  it('formats a fixed timestamp in the selected locale', () => {
    const timestamp = '2026-09-03T12:34:56.000Z'
    expect(formatDateTime(timestamp, 'en')).toMatch(/Sep/)
    expect(formatDateTime(timestamp, 'zh')).toMatch(/2026/)
    expect(formatDateTime(null, 'en')).toBe('No timestamp evidence')
    expect(formatDateTime('invalid', 'zh')).toBe('时间无效')
  })

  it.each([
    [500, 'Just now', '刚刚'],
    [5_000, '5 seconds ago', '5 秒前'],
    [65_000, '1 minute 5 seconds ago', '1 分钟 5 秒前'],
    [3_660_000, '1 hour 1 minute ago', '1 小时 1 分钟前'],
    [172_800_000, '2 days ago', '2 天前'],
  ])('formats age %i without Thai copy in English or Chinese', (ageMs, english, chinese) => {
    expect(formatEvidenceAge(ageMs, 'en')).toBe(english)
    expect(formatEvidenceAge(ageMs, 'zh')).toBe(chinese)
  })

  it('localizes unavailable evidence age', () => {
    expect(formatEvidenceAge(Number.NaN, 'th')).toBe('ไม่ทราบอายุหลักฐาน')
    expect(formatEvidenceAge(Number.NaN, 'en')).toBe('Evidence age unknown')
    expect(formatEvidenceAge(Number.NaN, 'zh')).toBe('证据时间未知')
  })
})
