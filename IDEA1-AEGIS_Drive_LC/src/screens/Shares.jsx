import { useState } from 'react'
import { Link2, Plus } from 'lucide-react'
import { Card, CardTitle, Chip, Btn, Modal, ModalClose, PillSelect, Field, Segmented } from '../components/ui.jsx'
import { useNow, useReducedMotion } from '../lib/hooks.js'
import { fmtCountdown } from '../lib/format.js'
import { FILES, SHARES } from '../lib/data.js'

const SCOPE_CHIP = { vlan: { key: 'chipVlanOnly', tone: 'accent' }, subnet: { key: 'chipSubnet', tone: 'accent' }, any: { key: 'chipAnyNetwork', tone: 'warn' } }
const EXPIRY_MS = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 }

/* ── The network-scope diagram — teaches the entire feature ──────── */
function ScopeDiagram({ t, scope }) {
  const reduced = useReducedMotion()
  const zones = [
    { id: 'company', label: t('zoneCompany'), y: 36, allowed: true },
    { id: 'guest', label: t('zoneGuest'), y: 100, allowed: scope === 'any' },
    { id: 'internet', label: t('zoneInternet'), y: 164, allowed: scope === 'any' },
  ]
  const nasX = 398
  const nasY = 100
  const path = (y) => `M148,${y} C230,${y} 270,${nasY} ${nasX - 10},${nasY}`

  return (
    <svg viewBox="0 0 480 200" className="w-full" role="img" aria-label={t('networkScope')}>
      <defs>
        <pattern id="zone-hatch" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="var(--ink-3)" strokeWidth="1" opacity="0.4" />
        </pattern>
      </defs>

      {/* firewall boundary */}
      <line x1="300" y1="12" x2="300" y2="188" stroke="var(--line)" strokeWidth="1" strokeDasharray="3 4" />
      <text x="300" y="10" textAnchor="middle" fontSize="8.5" fontWeight="600" letterSpacing="0.06em" fill="var(--ink-3)">FIREWALL</text>

      {zones.map((z) => (
        <g key={z.id}>
          {/* connector — solid/​dashed variants cross-fade */}
          <path d={path(z.y)} fill="none" stroke="var(--accent)" strokeWidth="2" style={{ opacity: z.allowed ? 1 : 0, transition: 'opacity var(--dur-base) var(--ease)' }} />
          <path d={path(z.y)} fill="none" stroke="var(--ink-3)" strokeWidth="1.5" strokeDasharray="4 5" style={{ opacity: z.allowed ? 0 : 0.75, transition: 'opacity var(--dur-base) var(--ease)' }} />

          {/* blocked: a request travels, hits the boundary, dissolves */}
          {!z.allowed && !reduced && (
            <circle r="3.5" fill="var(--ink-3)">
              <animateMotion dur="3.2s" repeatCount="indefinite" path={path(z.y)} keyPoints="0;0.55;0.55" keyTimes="0;0.55;1" calcMode="linear" />
              <animate attributeName="opacity" values="0;1;1;0;0" keyTimes="0;0.1;0.45;0.55;1" dur="3.2s" repeatCount="indefinite" />
              <animate attributeName="r" values="3.5;3.5;5;0.5;0.5" keyTimes="0;0.45;0.5;0.55;1" dur="3.2s" repeatCount="indefinite" />
            </circle>
          )}
          {/* allowed: a quiet dot completes the journey */}
          {z.allowed && !reduced && (
            <circle r="3" fill="var(--accent)">
              <animateMotion dur="3.2s" repeatCount="indefinite" path={path(z.y)} />
              <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.9;1" dur="3.2s" repeatCount="indefinite" />
            </circle>
          )}

          {/* zone node */}
          <rect
            x="10" y={z.y - 17} width="138" height="34" rx="17"
            fill={z.allowed ? 'var(--card)' : 'url(#zone-hatch)'}
            stroke={z.allowed ? 'var(--accent)' : 'var(--line)'}
            strokeWidth="1.5"
            style={{ transition: 'stroke var(--dur-base) var(--ease)' }}
          />
          <text x="79" y={z.y + 4} textAnchor="middle" fontSize="11.5" fontWeight="600" fill={z.allowed ? 'var(--ink)' : 'var(--ink-3)'} style={{ transition: 'fill var(--dur-base) var(--ease)' }}>
            {z.label}
          </text>
          {z.id === 'company' && scope === 'subnet' && (
            <text x="79" y={z.y + 30} textAnchor="middle" fontSize="9" fontFamily="JetBrains Mono, monospace" fill="var(--accent-ink)">192.168.20.0/24</text>
          )}
        </g>
      ))}

      {/* NAS node */}
      <circle cx={nasX + 22} cy={nasY} r="26" fill="var(--ink)" />
      <text x={nasX + 22} y={nasY + 4} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--card)">NAS</text>
    </svg>
  )
}

/* ── One active-link row — collapses into hatch on revoke ────────── */
function LinkRow({ t, link, now, revoking, onAskRevoke }) {
  const msLeft = link.expiresAt - now
  const chip = SCOPE_CHIP[link.scope]
  return (
    <div
      className="overflow-hidden transition-[max-height,opacity] duration-[var(--dur-slow)]"
      style={{ maxHeight: revoking ? 0 : 64, opacity: revoking ? 0 : 1, transitionTimingFunction: 'var(--ease)' }}
    >
      <div
        className={`grid items-center gap-3 px-4 h-14 border-b border-line text-[13px] ${revoking ? 'hatch hatch-ink3' : ''}`}
        style={{
          gridTemplateColumns: 'minmax(150px, 1fr) 104px 100px 84px 36px 88px',
          filter: revoking ? 'saturate(0)' : 'none',
        }}
      >
        <span className="min-w-0">
          <span className="block font-medium text-ink truncate" title={link.file}>{link.file}</span>
          <span className="block text-[11px] text-ink-3 truncate">{link.createdBy}</span>
        </span>
        <Chip tone={chip.tone}>{t(chip.key)}</Chip>
        <span className="text-ink-2 whitespace-nowrap truncate">
          {link.auth === 'password' ? t('authPassword') : link.auth === 'otc' ? t('authOtc') : t('authNone')}
        </span>
        <span
          className="font-mono text-[12px] whitespace-nowrap"
          style={{ fontVariantNumeric: 'tabular-nums', color: msLeft < 3_600_000 ? 'var(--warn)' : 'var(--ink-2)' }}
        >
          {fmtCountdown(msLeft, t('expired'))}
        </span>
        <span className="text-ink-2 text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>{link.hits}</span>
        <Btn variant="dangerSoft" size="sm" className="justify-self-end" onClick={() => onAskRevoke(link)}>{t('revoke')}</Btn>
      </div>
    </div>
  )
}

export function Shares({ t }) {
  const now = useNow(1000)
  const [links, setLinks] = useState(SHARES)
  const [revokingIds, setRevokingIds] = useState(new Set())
  const [askRevoke, setAskRevoke] = useState(null)
  const [file, setFile] = useState(FILES[0].name)
  const [expiry, setExpiry] = useState('24h')
  const [auth, setAuth] = useState('password')
  const [scope, setScope] = useState('vlan')
  const idRef = useState(() => ({ n: 100 }))[0]

  const createLink = () => {
    setLinks((prev) => [
      { id: `s${idRef.n++}`, file, scope, auth, createdBy: 'You', hits: 0, expiresAt: Date.now() + EXPIRY_MS[expiry] },
      ...prev,
    ])
  }

  // Revoke is destructive and irreversible — two-step confirm, no undo offered.
  const confirmRevoke = () => {
    const id = askRevoke.id
    setAskRevoke(null)
    setRevokingIds((prev) => new Set(prev).add(id))
    setTimeout(() => {
      setLinks((prev) => prev.filter((l) => l.id !== id))
      setRevokingIds((prev) => { const n = new Set(prev); n.delete(id); return n })
    }, 450)
  }

  return (
    <div className="grid grid-cols-12 gap-6 max-lg:gap-5">
      {/* creation panel */}
      <div className="col-span-5 max-lg:col-span-12">
        <Card className="p-5">
          <CardTitle sub={t('scopeDiagramNote')}>{t('newShare')}</CardTitle>
          <div className="flex flex-col gap-4">
            <Field id="share-file" label={t('shareFile')}>
              <PillSelect id="share-file" value={file} onChange={(e) => setFile(e.target.value)}>
                {FILES.filter((f) => !f.vault).map((f) => (
                  <option key={f.id} value={f.name}>{f.name}</option>
                ))}
              </PillSelect>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field id="share-expiry" label={t('expiry')}>
                <PillSelect id="share-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                  <option value="1h">{t('hour1')}</option>
                  <option value="24h">{t('hours24')}</option>
                  <option value="7d">{t('days7')}</option>
                  <option value="30d">{t('days30')}</option>
                </PillSelect>
              </Field>
              <Field id="share-auth" label={t('authMethod')}>
                <PillSelect id="share-auth" value={auth} onChange={(e) => setAuth(e.target.value)}>
                  <option value="password">{t('authPassword')}</option>
                  <option value="otc">{t('authOtc')}</option>
                  <option value="none">{t('authNone')}</option>
                </PillSelect>
              </Field>
            </div>
            <div>
              <p className="text-[12px] font-semibold text-ink-3 uppercase tracking-[0.06em] mb-2">{t('networkScope')}</p>
              <Segmented
                ariaLabel={t('networkScope')}
                options={[
                  { value: 'vlan', label: t('scopeVlan') },
                  { value: 'subnet', label: t('scopeSubnet') },
                  { value: 'any', label: t('scopeAny') },
                ]}
                value={scope}
                onChange={setScope}
              />
            </div>
            <div className="rounded-[var(--r-tile)] border border-line bg-sunken p-3">
              <ScopeDiagram t={t} scope={scope} />
            </div>
            {scope === 'any' && (
              <p className="text-[12px] font-medium rounded-[10px] px-3 py-2" style={{ background: 'var(--warn-soft)', color: 'var(--warn)' }} role="status">
                {t('chipAnyNetwork')} — {t('scopeDiagramNote')}
              </p>
            )}
            <Btn variant="primary" onClick={createLink}>
              <Plus size={15} strokeWidth={1.8} />
              {t('createShare')}
            </Btn>
          </div>
        </Card>
      </div>

      {/* active links */}
      <div className="col-span-7 max-lg:col-span-12">
        <Card className="overflow-hidden">
          <div className="px-5 pt-5 pb-3 flex items-center gap-2">
            <Link2 size={16} strokeWidth={1.5} className="text-ink-3" />
            <h2 className="text-[16px] font-semibold text-ink">{t('activeLinks')}</h2>
            <Chip tone="neutral" className="ml-auto">{links.length}</Chip>
          </div>
          <div className="overflow-x-auto">
            <div className="min-w-[720px]">
              <div
                className="grid gap-3 px-4 py-2 border-b border-line text-[11px] font-semibold text-ink-3 uppercase tracking-[0.06em]"
                style={{ gridTemplateColumns: 'minmax(150px, 1fr) 104px 100px 84px 36px 88px' }}
              >
                <span>{t('shareFile')}</span>
                <span>{t('colScope')}</span>
                <span className="max-md:hidden">{t('colAuth')}</span>
                <span>{t('colExpiresIn')}</span>
                <span className="max-md:hidden">{t('colCreatedBy')}</span>
                <span>{t('colHits')}</span>
                <span />
              </div>
              {links.map((link) => (
                <LinkRow key={link.id} t={t} link={link} now={now} revoking={revokingIds.has(link.id)} onAskRevoke={setAskRevoke} />
              ))}
            </div>
          </div>
        </Card>
      </div>

      {/* two-step revoke confirm — the filename is stated explicitly */}
      <Modal open={!!askRevoke} onClose={() => setAskRevoke(null)} width={440} labelledBy="revoke-title">
        <ModalClose onClose={() => setAskRevoke(null)} label={t('cancel')} />
        <h2 id="revoke-title" className="text-[18px] font-semibold text-ink">{t('revokeTitle')}</h2>
        <p className="text-[13.5px] text-ink-2 mt-3 leading-relaxed">
          {askRevoke && t('revokeBody', { name: askRevoke.file })}
        </p>
        <div className="flex gap-2.5 mt-6">
          <Btn variant="outline" className="flex-1" onClick={() => setAskRevoke(null)}>{t('cancel')}</Btn>
          <Btn variant="danger" className="flex-1" onClick={confirmRevoke}>{t('confirmRevoke')}</Btn>
        </div>
      </Modal>
    </div>
  )
}
