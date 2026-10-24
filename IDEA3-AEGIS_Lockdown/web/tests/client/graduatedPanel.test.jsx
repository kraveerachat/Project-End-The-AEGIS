import React from 'react'
import { render, screen, within } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import { GraduatedDecisions, GraduatedSummary, LevelTag } from '../../src/components/GraduatedPanel.jsx'
import { STRINGS } from '../../src/lib/i18n.js'
import { AlertsPage } from '../../src/pages/AlertsPage.jsx'
import { DashboardPage } from '../../src/pages/DashboardPage.jsx'
import { IncidentsPage } from '../../src/pages/IncidentsPage.jsx'
import { LockdownPage } from '../../src/pages/LockdownPage.jsx'
import { makeDemoSnapshot } from '../fixtures/clientSnapshot.js'

let snapshot

const view = (changes = {}) => ({
  schemaVersion: 1, provenance: 'CORE_PROJECTION', updatedAt: '2026-10-24T09:00:00Z', ageMs: 30_000, current: true,
  highestLevel: 'CRITICAL', cutRecommendedFor: '203.0.113.7', autoCutLatched: true,
  decisions: [
    { at: '2026-10-24T09:00:00Z', attackerIp: '203.0.113.7', kind: 'ssh_login_after_failures', level: 'CRITICAL', action: 'AUTO_CUT', outcome: 'CUT_SENT', score: 140, mitre: ['T1078', 'T1110'] },
    { at: '2026-10-24T08:59:00Z', attackerIp: '203.0.113.7', kind: 'port_scan', level: 'MEDIUM', action: 'SOFTWARE_BLOCK', outcome: 'BLOCKED', score: 30, mitre: ['T1046'] },
  ],
  ...changes,
})

const withGraduated = (value) => ({ ...snapshot, runtime: { ...snapshot.runtime, graduated: value } })

beforeAll(async () => {
  snapshot = await makeDemoSnapshot()
})

describe('graduated response: Lockdown page', () => {
  it('shows the current level, the CUT recommendation and the automatic-CUT latch (Thai by default)', () => {
    render(<LockdownPage snapshot={withGraduated(view())} />)
    const summary = screen.getByTestId('graduated-summary')
    expect(within(summary).getByText('CRITICAL')).toBeVisible()
    expect(within(summary).getByText('ปัจจุบัน')).toBeVisible()
    expect(within(summary).getByTestId('graduated-recommendation')).toHaveTextContent('203.0.113.7')
    expect(within(summary).getByTestId('graduated-autocut')).toHaveTextContent('RESTORE ทำได้โดยผู้ปฏิบัติงานที่ Core เท่านั้น')
  })

  it('contains no control at all: no button, no link, no form field', () => {
    render(<LockdownPage snapshot={withGraduated(view())} />)
    const panel = screen.getByRole('region', { name: 'การตอบสนองแบบไล่ระดับ' })
    expect(within(panel).queryAllByRole('button')).toHaveLength(0)
    expect(within(panel).queryAllByRole('link')).toHaveLength(0)
    expect(panel.querySelectorAll('input, select, textarea, form, a[href]')).toHaveLength(0)
    expect(within(panel).getByText(/ไม่มีเส้นทางสั่ง CUT หรือ RESTORE/)).toBeVisible()
  })

  it('says "no data" when the section is absent and never shows LOW instead', () => {
    render(<LockdownPage snapshot={withGraduated(null)} />)
    const unavailable = screen.getByTestId('graduated-unavailable')
    expect(unavailable).toHaveTextContent('ไม่มีข้อมูลจาก Core')
    expect(screen.queryByTestId('graduated-summary')).not.toBeInTheDocument()
    expect(document.querySelector('[data-level="LOW"]')).toBeNull()
  })

  it('marks an old section as historical with its age and a muted tag', () => {
    render(<LockdownPage snapshot={withGraduated(view({ current: false, ageMs: 3_700_000, autoCutLatched: false, cutRecommendedFor: null }))} />)
    const summary = screen.getByTestId('graduated-summary')
    expect(summary).toHaveTextContent('ย้อนหลัง')
    expect(summary.querySelector('.level--muted')).not.toBeNull()
    expect(within(summary).getByTestId('graduated-recommendation')).toHaveTextContent('ไม่มีคำแนะนำ')
    expect(within(summary).getByTestId('graduated-autocut')).toHaveTextContent('ยังไม่ได้ดำเนินการ')
  })

  it('labels demo data as demo data only', () => {
    render(<LockdownPage snapshot={snapshot} />)
    expect(snapshot.runtime.graduated.demo).toBe(true)
    expect(screen.getByTestId('graduated-demo')).toHaveTextContent('ข้อมูลสาธิตเท่านั้น')
  })
})

describe('graduated response: Dashboard KPI tile', () => {
  const tile = (language, value) => {
    render(<DashboardPage snapshot={withGraduated(value)} language={language} />)
    const summary = screen.getAllByRole('region').find((region) => region.querySelectorAll('.metric-card').length === 3)
    return [...summary.querySelectorAll('.metric-card')].at(-1)
  }

  it.each([
    ['th', 'ระดับภัยคุกคามปัจจุบัน', 'ปัจจุบัน'],
    ['en', 'Current threat level', 'Current'],
    ['zh', '当前威胁级别', '当前'],
  ])('shows the level code with a %s label', (language, label, detail) => {
    const card = tile(language, view())
    expect(within(card).getByText(label)).toBeVisible()
    expect(within(card).getByText('CRITICAL')).toBeVisible()
    expect(card.querySelector('.level--critical')).not.toBeNull()
    expect(card).toHaveTextContent(detail)
  })

  it('uses a different colour class for each level and keeps the code text', () => {
    for (const level of ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) {
      const { container, unmount } = render(<LevelTag level={level} />)
      const tag = container.querySelector('.level')
      expect(tag).toHaveTextContent(level)
      expect(tag.className).toContain(`level--${level.toLowerCase()}`)
      unmount()
    }
    const { container } = render(<LevelTag level="BOGUS" />)
    expect(container.querySelector('.level--unknown')).not.toBeNull()
  })

  it.each([['th', 'ไม่มีข้อมูลจาก Core'], ['en', 'No data from the Core'], ['zh', 'Core 无数据']])('shows an UNKNOWN tile in %s when there is no section', (language, text) => {
    const card = tile(language, null)
    expect(within(card).getByText(text)).toBeVisible()
    expect(card.querySelector('[data-status="UNKNOWN"]')).not.toBeNull()
    expect(card.querySelector('[data-level]')).toBeNull()
  })

  it('marks an old level as historical', () => {
    const card = tile('en', view({ current: false, ageMs: 4_000_000 }))
    expect(card).toHaveTextContent('Historical')
    expect(card.querySelector('.level--muted')).not.toBeNull()
    expect(card.querySelector('[data-status="STALE"]')).not.toBeNull()
  })
})

describe('graduated response: decisions on Alerts and Incidents', () => {
  it('lists the decisions with their MITRE IDs, untranslated, on the Alerts page', () => {
    render(<AlertsPage snapshot={withGraduated(view())} />)
    const table = screen.getByRole('region', { name: 'การตัดสินใจล่าสุดของ Core' })
    const ids = within(table).getAllByTestId('mitre-ids').map((node) => node.textContent)
    expect(ids).toEqual(['T1078, T1110', 'T1046'])
    for (const code of ['203.0.113.7', 'ssh_login_after_failures', 'AUTO_CUT', 'CUT_SENT', 'CRITICAL', 'SOFTWARE_BLOCK', 'BLOCKED', 'port_scan']) {
      expect(within(table).getAllByText(code).length).toBeGreaterThan(0)
    }
    expect(within(table).queryAllByRole('button')).toHaveLength(0)
  })

  it('lists the same decisions on the Incidents page', () => {
    render(<IncidentsPage snapshot={withGraduated(view())} />)
    expect(screen.getAllByTestId('mitre-ids').map((node) => node.textContent)).toEqual(['T1078, T1110', 'T1046'])
  })

  it('explains an empty list and an absent section without inventing events', () => {
    const { unmount } = render(<AlertsPage snapshot={withGraduated(view({ decisions: [] }))} />)
    expect(screen.getByText(/Core ยังไม่ได้รายงานการตัดสินใจ/)).toBeVisible()
    unmount()
    render(<IncidentsPage snapshot={withGraduated(null)} />)
    expect(screen.getByTestId('graduated-unavailable')).toBeVisible()
  })

  it.each([['en', 'Latest Core decisions', 'Attacker IP'], ['zh', 'Core 最近决策', '攻击者 IP']])('translates the headings and keeps the codes (%s)', (language, title, column) => {
    render(<GraduatedDecisions graduated={view()} language={language} />)
    expect(screen.getByRole('region', { name: title })).toBeVisible()
    expect(screen.getByText(column)).toBeVisible()
    expect(screen.getAllByTestId('mitre-ids')[0]).toHaveTextContent('T1078, T1110')
    expect(screen.getAllByText('CRITICAL').length).toBeGreaterThan(0)
  })

  it('the summary also translates while keeping CUT and RESTORE as words', () => {
    render(<GraduatedSummary graduated={view()} language="zh" />)
    expect(screen.getByTestId('graduated-autocut')).toHaveTextContent('RESTORE')
    expect(screen.getByTestId('graduated-recommendation')).toHaveTextContent('203.0.113.7')
  })
})

describe('graduated response: strings', () => {
  const keys = (language) => Object.keys(STRINGS[language]).filter((key) => key.startsWith('graduated.')).sort()
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()

  it('has the same keys and placeholders in th, en and zh', () => {
    expect(keys('th').length).toBeGreaterThan(20)
    expect(keys('en')).toEqual(keys('th'))
    expect(keys('zh')).toEqual(keys('th'))
    for (const key of keys('th')) {
      expect(placeholders(STRINGS.en[key]), key).toEqual(placeholders(STRINGS.th[key]))
      expect(placeholders(STRINGS.zh[key]), key).toEqual(placeholders(STRINGS.th[key]))
    }
  })

  it('translates the text for real: Thai has Thai script, Chinese has Han characters, English has neither', () => {
    for (const key of keys('th').filter((k) => !['graduated.col.mitre'].includes(k))) {
      expect(STRINGS.th[key], key).toMatch(/[฀-๿]/)
      expect(STRINGS.zh[key], key).toMatch(/[一-鿿]/)
      expect(STRINGS.en[key], key).not.toMatch(/[฀-๿一-鿿]/)
    }
  })

  it('offers no way to send CUT or RESTORE: no string asks the operator to press anything here', () => {
    for (const language of ['th', 'en', 'zh']) {
      for (const key of keys(language)) expect(STRINGS[language][key].toLowerCase(), key).not.toMatch(/\bclick\b|กดปุ่ม|点击/)
    }
  })
})
