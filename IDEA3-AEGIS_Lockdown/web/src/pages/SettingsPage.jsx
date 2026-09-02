import React, { useState } from 'react'
import { Database, FlaskConical, LockKeyhole, Save, ServerCog, ShieldCheck } from 'lucide-react'
import { DataTable } from '../components/DataTable.jsx'
import { Panel } from '../components/Panel.jsx'
import { StatusBadge } from '../components/StatusBadge.jsx'
import { formatDateTime } from '../lib/format.js'

export function SettingsPage({ snapshot, onDemoMode = () => {}, onSavePolicy = () => {} }) {
  const [policy, setPolicy] = useState(snapshot.settings.policy)
  const adapterColumns = [
    { key: 'name', label: 'Adapter', render: (value, row) => <div className="primary-cell"><span className={`source-glyph source-glyph--${row.configured ? 'healthy' : 'not_configured'}`} /><strong>{value}</strong><small>{row.enabled ? 'Enabled' : 'Disabled'}</small></div> },
    { key: 'alias', label: 'Safe alias', render: (value) => <span className="source-tag">{value}</span> },
    { key: 'configured', label: 'Configured', render: (value) => <StatusBadge status={value ? 'HEALTHY' : 'NOT_CONFIGURED'} compact /> },
    { key: 'timeoutMs', label: 'Timeout', render: (value) => <span className="mono">{value} ms</span> },
    { key: 'lastValidation', label: 'Validated', render: (value) => <span className="mono">{formatDateTime(value)}</span> },
    { key: 'lastSuccess', label: 'Last success', render: (value) => <span className="mono">{formatDateTime(value)}</span> },
  ]
  const securityLabels = {
    csrf: 'CSRF', adminRbac: 'Admin RBAC', secureCookieProduction: 'Secure cookie', productionDemo: 'Production Demo', rawPayload: 'Raw payload',
  }
  function numberField(key, label, min, max) {
    return <label>{label}<input type="number" min={min} max={max} value={policy[key]} onChange={(event) => setPolicy((value) => ({ ...value, [key]: Number(event.target.value) }))} /></label>
  }

  return (
    <div className="settings-layout">
      <div className="page-stack">
        <Panel title="Demo Mode" description="สำหรับตรวจ UI โดยไม่ปลอมเป็นระบบจริง">
          <label className="switch-row"><span className="switch-row__icon"><FlaskConical /></span><span><strong>Demo Mode</strong><small>เฉพาะ session นี้ ปิดอัตโนมัติเมื่อเข้าสู่ระบบใหม่ และ production ปฏิเสธเสมอ</small></span><input type="checkbox" aria-label="Demo Mode" checked={snapshot.mode === 'DEMO'} onChange={(event) => onDemoMode(event.target.checked)} /></label>
        </Panel>
        <Panel title="Read-only adapters" description="หน้าจอแสดง safe alias เท่านั้น ไม่มี URL หรือ credential">
          <DataTable columns={adapterColumns} rows={snapshot.settings.adapters} />
        </Panel>
        <Panel title="Event, correlation & retention policy" description="ค่าทุกช่องมีขอบเขตตรวจสอบซ้ำที่ API">
          <form className="policy-form" onSubmit={(event) => { event.preventDefault(); onSavePolicy(policy) }}>
            {numberField('dedupWindowSeconds', 'Dedup window (วินาที)', 10, 600)}
            {numberField('correlationWindowMinutes', 'Correlation window (นาที)', 1, 60)}
            {numberField('escalationThreshold', 'Escalation threshold', 1, 100)}
            {numberField('eventRetentionDays', 'Event retention (วัน)', 1, 365)}
            {numberField('auditRetentionDays', 'Audit retention (วัน)', 30, 2555)}
            {numberField('exportLimit', 'Export limit', 1, 10000)}
            <button className="button button--primary" type="submit"><Save size={15} />บันทึกนโยบายที่ปลอดภัย</button>
          </form>
        </Panel>
      </div>
      <aside className="settings-aside page-stack">
        <Panel title="Security policy" description="อ่านอย่างเดียวจาก server policy">
          <div className="security-policy">{Object.entries(snapshot.settings.security).map(([key, value]) => <div key={key}><span className="security-policy__icon">{key === 'csrf' ? <LockKeyhole /> : key === 'adminRbac' ? <ShieldCheck /> : key === 'secureCookieProduction' ? <ServerCog /> : <Database />}</span><span><strong>{securityLabels[key]}</strong><small>{value}</small></span><StatusBadge status={value === 'ENFORCED' || value === 'REQUIRED' || value === 'DENIED' ? 'HEALTHY' : 'UNKNOWN'} compact /></div>)}</div>
        </Panel>
        <section className="settings-boundary"><BanIcon /><div><strong>ไม่มี Hardware controls</strong><p>Relay, network isolation, broker credential และ signing secret ไม่ใช่ Web setting</p></div></section>
      </aside>
    </div>
  )
}

function BanIcon() {
  return <span className="command-boundary__icon"><ShieldCheck /></span>
}
