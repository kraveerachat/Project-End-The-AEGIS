import { useEffect, useRef, useState } from 'react'
import { ShieldCheck, Activity, HardDrive, ExternalLink, Plug } from 'lucide-react'
import { Card, CardTitle, Chip, Btn, Segmented, Field, PillSelect, SkeletonLoader, ErrorState, EmptyState } from './ui.jsx'
import { fmtBytes, fmtDateTime } from '../lib/format.js'
import { apiFetch } from '../lib/api.js'

/* ── The three kinds of Settings row ────────────────────────────────────────
   Every panel in Security & Privacy / Storage & Data / Administrator declares
   which kind it is, so the user can tell "I can change this" from "the system
   decides this" at a glance — and so a row that is *architecturally* fixed never
   reads as a control someone forgot to wire up.

     configurable   a real value this account can change and save
     action         no setting to change, but a real thing to do
     system         decided by architecture or infrastructure outside Drive

   ⚠️ A `system` row must never be rendered as a disabled input. A greyed-out
      select says "temporarily broken"; a value with a System-managed chip says
      "this is not yours to set", which is the truth we actually mean. */
const CATEGORY = {
  configurable: { key: 'setCatConfigurable', tone: 'accent' },
  action: { key: 'setCatActionable', tone: 'accent' },
  system: { key: 'setCatSystemManaged', tone: 'neutral' },
}

export function CategoryChip({ t, kind }) {
  const cat = CATEGORY[kind]
  if (!cat) return null
  return <Chip tone={cat.tone}>{t(cat.key)}</Chip>
}

/* ── Fact row — label left, measured value right ────────────────────────────
   A definition list, not a table: these are name/value pairs, and screen readers
   announce them as such. `tone` colours only the values that carry a status;
   plain facts stay ink so the page does not turn into a colour chart. */
export function FactRow({ label, value, tone = null, mono = true, hint = null }) {
  const color = tone ? `var(--${tone})` : undefined
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 border-b border-line last:border-b-0 flex-wrap">
      <dt className="text-[12.5px] text-ink-2 min-w-0">
        {label}
        {hint && <span className="block text-[11.5px] text-ink-3 leading-relaxed max-w-[52ch] mt-0.5">{hint}</span>}
      </dt>
      <dd
        className={`text-[12.5px] text-ink text-right ${mono ? 'font-mono' : 'font-medium'}`}
        style={color ? { color } : undefined}
      >
        {value}
      </dd>
    </div>
  )
}

export function FactList({ children, className = '' }) {
  return <dl className={`flex flex-col ${className}`}>{children}</dl>
}

/** Section heading inside a panel that groups several fact lists. */
function GroupLabel({ children }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-3 mt-4 first:mt-0 mb-1">
      {children}
    </p>
  )
}

/* ── Security overview ──────────────────────────────────────────────────────
   Deliberately NOT a score. Every line is either a value the server just told
   us or a fixed architectural fact; nothing here is derived by weighting one
   against another, because a single number would invite the user to treat
   "8/10" as a safety guarantee the system cannot make. */
export function SecurityOverviewCard({ t, sessions, sessionsLoading, settings, onManageSessions }) {
  const sessionCount = sessions?.length ?? null
  const shareDefaultsSet = Boolean(settings)

  return (
    <Card className="p-5">
      <CardTitle sub={t('secOverviewSub')} right={<CategoryChip t={t} kind="system" />}>
        {t('secOverviewTitle')}
      </CardTitle>

      <div className="grid grid-cols-2 gap-x-8 max-md:grid-cols-1">
        <div>
          <GroupLabel>{t('secGroupAccount')}</GroupLabel>
          <FactList>
            <FactRow label={t('secPassword')} value={t('secPasswordSet')} />
            <FactRow
              label={t('secSessionsCount')}
              value={sessionsLoading ? '…' : (sessionCount ?? '—')}
            />
            <FactRow label={t('secCurrentSession')} value={t('thisDevice')} />
          </FactList>
          <Btn variant="outline" size="sm" className="mt-2.5" onClick={onManageSessions}>
            {t('secManageSessions')}
          </Btn>
        </div>

        <div>
          <GroupLabel>{t('secGroupVault')}</GroupLabel>
          <FactList>
            <FactRow label={t('secVaultEncryption')} value={t('secVaultZeroKnowledge')} tone="ok" />
            <FactRow label={t('secVaultServerKey')} value={t('valNone')} />
            <FactRow label={t('secVaultRecovery')} value={t('valNotSupported')} />
          </FactList>
        </div>

        <div>
          <GroupLabel>{t('secGroupSharing')}</GroupLabel>
          <FactList>
            <FactRow label={t('secShares')} value={t('valAvailable')} />
            <FactRow
              label={t('secShareDefaults')}
              value={shareDefaultsSet ? t('valConfigured') : t('valDefaults')}
            />
          </FactList>
        </div>

        <div>
          <GroupLabel>{t('secGroupRemote')}</GroupLabel>
          <FactList>
            <FactRow label={t('secRemoteChannel')} value="Twingate" />
            {/* ⚠️ "Not measured" — never "Offline". Drive has no approved source
                for connector health, and absence of a reading is not a reading. */}
            <FactRow label={t('secRemoteTelemetry')} value={t('valNotMeasured')} />
          </FactList>
        </div>
      </div>
    </Card>
  )
}

/* ── Private Vault protection ───────────────────────────────────────────────
   Replaces the bare hatched "CIPHERTEXT · NOT READABLE BY SERVER" tile. Same
   claim, but itemised, so a reader can check each property instead of taking one
   slogan on trust.

   ⚠️ There is no live "Locked / Unlocked" readout and no "Lock now" button here,
      and that is a statement about the architecture rather than an omission:
      the KEK lives in the Vault screen's own React state (screens/Vault.jsx), and
      App.jsx constructs exactly one screen at a time. Opening Settings unmounts
      Vault, which discards the key. From this page the vault is ALWAYS locked, so
      a button would report a success it did not cause and a status line would be
      a constant dressed up as a measurement. The row below says so plainly. */
export function VaultProtectionCard({ t }) {
  return (
    <Card className="p-5">
      <CardTitle sub={t('vaultProtectionSub')} right={<CategoryChip t={t} kind="system" />}>
        {t('vaultProtectionTitle')}
      </CardTitle>
      <FactList>
        <FactRow label={t('vaultProtModel')} value={t('secVaultZeroKnowledge')} tone="ok" />
        <FactRow label={t('vaultProtDerivation')} value={t('vaultProtDerivationValue')} />
        <FactRow label={t('vaultProtServerKey')} value={t('valNone')} />
        <FactRow label={t('vaultProtPlaintext')} value={t('valNo')} />
        <FactRow label={t('vaultProtRecovery')} value={t('valNotSupported')} />
        <FactRow
          label={t('vaultProtLockScope')}
          value={t('vaultProtLockScopeValue')}
          mono={false}
        />
      </FactList>
      <p className="text-[11.5px] text-ink-3 leading-relaxed mt-3 max-w-[62ch]">
        {t('vaultProtLockScopeNote')}
      </p>
    </Card>
  )
}

/* ── Vault auto-lock — the one genuinely new configurable security value ────
   The number is enforced where it matters (the browser holding the key) and
   bounded where it is stored (CHECK constraint + server validation). Changing it
   cannot widen anything server-side, because the server never had the key. */
const AUTO_LOCK_CHOICES = [5, 10, 15, 30, 60]

export function VaultAutoLockCard({ t, value, onSave, saving, error }) {
  return (
    <Card className="p-5">
      <CardTitle right={<CategoryChip t={t} kind="configurable" />}>{t('vaultAutoLockTitle')}</CardTitle>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium text-ink">{t('vaultAutoLockLabel')}</p>
          <p className="text-[12px] text-ink-3 mt-1 max-w-[56ch] leading-relaxed">{t('vaultAutoLockNote')}</p>
        </div>
        <Segmented
          ariaLabel={t('vaultAutoLockLabel')}
          options={AUTO_LOCK_CHOICES.map((n) => ({ value: n, label: String(n) }))}
          value={value}
          onChange={onSave}
          disabled={saving}
        />
      </div>
      <p className="text-[11.5px] text-ink-3 mt-2">{t('vaultAutoLockUnit', { n: value })}</p>
      {error && (
        <p role="alert" className="text-[12.5px] font-medium mt-2" style={{ color: 'var(--danger)' }}>
          {t('vaultAutoLockSaveFailed')}
        </p>
      )}
    </Card>
  )
}

/* ── Vault recovery policy ──────────────────────────────────────────────────
   ⚠️ This card replaces a permanently-disabled "Generate 12-word recovery
      phrase" button. Do not reintroduce that control in any form. The removed
      generator produced Math.random() words that were never derived from, or
      connected to, the vault KEK — it told users a recoverable backup existed
      when losing the passphrase still meant losing the data. A policy statement
      that says "not supported" is safer than a button that implies otherwise. */
export function VaultRecoveryPolicyCard({ t }) {
  return (
    <Card className="p-5">
      <CardTitle right={<CategoryChip t={t} kind="system" />}>{t('vaultRecoveryPolicyTitle')}</CardTitle>
      <FactList>
        <FactRow label={t('vaultRecMethod')} value={t('valNotSupported')} />
        <FactRow label={t('vaultRecServerAssisted')} value={t('vaultRecDisabled')} />
        <FactRow label={t('vaultRecPhrase')} value={t('valNotConfigured')} />
        <FactRow label={t('vaultRecKeyLoss')} value={t('vaultRecKeyLossValue')} tone="warn" mono={false} />
      </FactList>
      <p className="text-[12.5px] text-ink-2 leading-relaxed mt-3 max-w-[62ch]">{t('vaultRecPolicyBody')}</p>
    </Card>
  )
}

/* ── Secure share defaults ──────────────────────────────────────────────────
   Only values the share contract actually enforces appear here: expiry and scope
   come straight from EXPIRY_MS / SCOPES in server/db/store.js, and the password
   switch maps to authType. There is deliberately no "allow downloads" option —
   the share model has no such field, so offering one would be a control that
   silently does nothing.

   ⚠️ requirePassword stores a boolean, never a password. */
const EXPIRY_CHOICES = [
  { value: '1h', key: 'hour1' },
  { value: '24h', key: 'hours24' },
  { value: '7d', key: 'days7' },
  { value: '30d', key: 'days30' },
]

export function ShareDefaultsCard({ t, value, onSave, saving, error }) {
  return (
    <Card className="p-5">
      <CardTitle sub={t('shareDefaultsSub')} right={<CategoryChip t={t} kind="configurable" />}>
        {t('shareDefaults')}
      </CardTitle>

      <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
        <Field id="share-default-expiry" label={t('shareDefaultExpiry')}>
          <PillSelect
            id="share-default-expiry"
            value={value.expiry}
            disabled={saving}
            onChange={(e) => onSave({ ...value, expiry: e.target.value })}
          >
            {EXPIRY_CHOICES.map((o) => (
              <option key={o.value} value={o.value}>{t(o.key)}</option>
            ))}
          </PillSelect>
        </Field>
        <Field id="share-default-scope" label={t('shareDefaultScope')}>
          <PillSelect
            id="share-default-scope"
            value={value.scope}
            disabled={saving}
            onChange={(e) => onSave({ ...value, scope: e.target.value })}
          >
            <option value="zones">{t('scopeZones')}</option>
            <option value="any">{t('scopeAny')}</option>
          </PillSelect>
        </Field>
      </div>

      <div className="flex items-start justify-between gap-4 mt-4 pt-4 border-t border-line flex-wrap">
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium text-ink">{t('shareDefaultRequirePassword')}</p>
          <p className="text-[12px] text-ink-3 mt-1 max-w-[54ch] leading-relaxed">
            {t('shareDefaultRequirePasswordNote')}
          </p>
        </div>
        <Segmented
          ariaLabel={t('shareDefaultRequirePassword')}
          options={[
            { value: 'on', label: t('requireOn') },
            { value: 'off', label: t('requireOff') },
          ]}
          value={value.requirePassword ? 'on' : 'off'}
          disabled={saving}
          onChange={(v) => onSave({ ...value, requirePassword: v === 'on' })}
        />
      </div>

      <p className="text-[11.5px] text-ink-3 leading-relaxed mt-3 max-w-[62ch]">
        {t('shareDefaultsNoStoredPassword')}
      </p>
      {error && (
        <p role="alert" className="text-[12.5px] font-medium mt-2" style={{ color: 'var(--danger)' }}>
          {t('shareDefaultsSaveFailed')}
        </p>
      )}
    </Card>
  )
}

/* ── Remote access ──────────────────────────────────────────────────────────
   ⚠️ The previous version showed a neutral "Inactive" chip in the connector
      status row. "Inactive" is a measurement result, and Drive has never taken
      that measurement — a reader could reasonably conclude remote access was
      down when in fact nothing had been asked. Every row below either states a
      configured fact or says explicitly that the value is not measured. */
export function RemoteAccessCard({ t }) {
  return (
    <Card className="p-5">
      <CardTitle sub={t('remoteAccessDocNote')} right={<CategoryChip t={t} kind="system" />}>
        {t('remoteAccessTitle')}
      </CardTitle>
      <FactList>
        <FactRow label={t('remoteChannelLabel')} value={t('remoteChannelValue')} />
        <FactRow label={t('remoteReachableResource')} value="AEGIS Drive · NAS :443" />
        <FactRow label={t('remoteAccessModel')} value={t('remoteLeastPrivilege')} mono={false} />
        <FactRow label={t('remoteTelemetryLabel')} value={t('valNotMeasured')} />
        <FactRow label={t('remoteLiveStateLabel')} value={t('valUnavailable')} />
      </FactList>
      <p className="text-[11.5px] text-ink-3 leading-relaxed mt-3 max-w-[64ch]">{t('remoteTelemetryNote')}</p>
    </Card>
  )
}

/* ── Current connection test ────────────────────────────────────────────────
   Measures exactly one thing: can THIS browser reach the authenticated Drive API
   over the connection it is already using, right now.

   ⚠️ It is not a Twingate connector health check and must never be labelled as
      one. A request that succeeds proves the path this browser took works; it
      says nothing about the connector, about other clients, or about whether the
      path went through Twingate at all. The card title and the note both say so. */
export function ConnectionTestCard({ t, lang }) {
  const [state, setState] = useState(null) // null | 'running' | { ok, transport, at }
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const run = async () => {
    setState('running')
    const res = await apiFetch('/api/me')
    if (!alive.current) return
    setState({
      ok: res.ok,
      // The transport is read from the page's own origin — the browser knows how
      // it connected. Nothing here is reported by the server about itself.
      transport: typeof globalThis.location === 'undefined'
        ? null
        : globalThis.location.protocol.replace(':', '').toUpperCase(),
      at: Date.now(),
    })
  }

  const result = state && state !== 'running' ? state : null

  return (
    <Card className="p-5">
      <CardTitle right={<CategoryChip t={t} kind="action" />}>{t('connTestTitle')}</CardTitle>

      <div className="flex items-center gap-3 flex-wrap">
        <Btn variant="outline" size="sm" onClick={run} disabled={state === 'running'}>
          <Plug size={14} strokeWidth={1.5} />
          {state === 'running' ? t('connTestRunning') : t('connTestAction')}
        </Btn>
      </div>

      {result && (
        <FactList className="mt-4">
          <FactRow
            label={t('connTestReachability')}
            value={result.ok ? t('connTestPass') : t('connTestFail')}
            tone={result.ok ? 'ok' : 'danger'}
          />
          <FactRow label={t('connTestTransport')} value={result.transport ?? '—'} />
          <FactRow label={t('connTestCheckedAt')} value={fmtDateTime(result.at, lang)} />
        </FactList>
      )}

      <p className="text-[11.5px] text-ink-3 leading-relaxed mt-3 max-w-[62ch]">{t('connTestScopeNote')}</p>
    </Card>
  )
}

/* ── Security activity ──────────────────────────────────────────────────────
   Every value comes from GET /api/audit/me, which reads the caller's OWN rows
   from the same audit ledger the Admin screen reads. Nothing is inferred, and a
   missing event renders as "Never" rather than as a zero that looks measured. */
export function SecurityActivityCard({ t, lang, activity, loading, error, onRetry, canViewAudit, onViewAudit }) {
  // ⚠️ `error` มาถึงที่นี่ "หลัง" ผ่าน visibleFetchError แล้ว (ดู Settings.jsx) — การ์ดนี้
  //    จึงไม่เห็น api.error ดิบเลย และไม่มีทางแสดง ErrorState ตอน placeholderMode
  //    ซึ่งเป็นโหมดที่แปลว่า "ยังไม่ได้ต่อ backend" ไม่ใช่ "ต่อแล้วพัง"
  const stamp = (iso) => (iso ? fmtDateTime(Date.parse(iso), lang) : t('valNever'))

  return (
    <Card className="p-5">
      <CardTitle
        sub={activity ? t('secActivitySub', { days: activity.windowDays }) : undefined}
        right={<CategoryChip t={t} kind="system" />}
      >
        {t('secActivityTitle')}
      </CardTitle>

      {loading ? (
        <SkeletonLoader />
      ) : error ? (
        <ErrorState t={t} kind={error} onRetry={onRetry} />
      ) : !activity ? (
        <EmptyState icon={Activity} title={t('valNever')} />
      ) : (
        <>
          <FactList>
            <FactRow label={t('secActivityLastLogin')} value={stamp(activity.lastLoginAt)} />
            <FactRow label={t('secActivityLastPasswordChange')} value={stamp(activity.lastPasswordChangeAt)} />
            <FactRow label={t('secActivityLastVaultUnlock')} value={stamp(activity.lastVaultUnlockAt)} />
            <FactRow
              label={t('secActivityDeniedLogins')}
              value={activity.deniedLoginCount}
              tone={activity.deniedLoginCount > 0 ? 'warn' : null}
            />
            <FactRow
              label={t('secActivityBlockedActions')}
              value={activity.blockedActionCount}
              tone={activity.blockedActionCount > 0 ? 'warn' : null}
            />
          </FactList>
          {activity.truncated && (
            <p className="text-[11.5px] text-ink-3 mt-2 leading-relaxed">{t('secActivityTruncated')}</p>
          )}
        </>
      )}

      {/* The full ledger stays Admin-only; a DataLake-User is not offered a link
          into a screen the server would refuse anyway. */}
      {canViewAudit && (
        <Btn variant="outline" size="sm" className="mt-3" onClick={onViewAudit}>
          <Activity size={14} strokeWidth={1.5} />
          {t('secActivityViewAudit')}
        </Btn>
      )}
    </Card>
  )
}

/* ── Storage overview (Settings copy of the measured numbers) ───────────────
   Read from GET /api/storage, the same document the Storage screen renders.
   `capacityBytes` is null when statfs could not be read — that is "unknown", not
   zero, and it renders as an em dash rather than as 0 B. */
export function StorageOverviewCard({ t, data, loading, error, onRetry, onViewStorage }) {
  const cap = data?.capacityBytes ?? null
  const diskStatus = data?.diskHealth?.available ? data.diskHealth.status : null
  const pct = cap && cap.totalBytes > 0 ? Math.round((cap.usedBytes / cap.totalBytes) * 100) : null

  return (
    <Card className="p-5">
      <CardTitle sub={t('storageOverviewSub')} right={<CategoryChip t={t} kind="system" />}>
        {t('storageOverviewTitle')}
      </CardTitle>

      {loading ? (
        <SkeletonLoader />
      ) : error ? (
        <ErrorState t={t} kind={error} onRetry={onRetry} />
      ) : (
        <FactList>
          <FactRow label={t('storageFilesystem')} value={cap ? fmtBytes(cap.totalBytes) : '—'} />
          <FactRow label={t('storageUsedLabel')} value={cap ? fmtBytes(cap.usedBytes) : '—'} />
          <FactRow label={t('storageFreeLabel')} value={cap ? fmtBytes(cap.freeBytes) : '—'} />
          <FactRow label={t('storageUsedPct')} value={pct === null ? '—' : `${pct}%`} />
          <FactRow
            label={t('diskHealth')}
            value={diskStatus ?? t('valNotMeasured')}
            tone={diskStatus === 'HEALTHY' ? 'ok' : diskStatus ? 'warn' : null}
          />
          {/* RAID is declared, never probed — there is no array in this deployment. */}
          <FactRow label={t('storageRaidLabel')} value={t('valNotConfigured')} />
        </FactList>
      )}

      <Btn variant="outline" size="sm" className="mt-3" onClick={onViewStorage}>
        <HardDrive size={14} strokeWidth={1.5} />
        {t('storageViewFull')}
      </Btn>
    </Card>
  )
}

/* ── Data protection policies ───────────────────────────────────────────────
   Replaces the "snapshot scheduling is not implemented" placeholder that used to
   be the whole content of this tab. These three protections are real and running;
   naming them is more useful than announcing the absence of a fourth.

   ⚠️ Retention is shown, not edited. Making 30 days configurable would need the
      purge worker's semantics redesigned and retested, which is not this change. */
export function DataProtectionCard({ t }) {
  return (
    <Card className="p-5">
      <CardTitle sub={t('dataProtectionSub')} right={<CategoryChip t={t} kind="system" />}>
        {t('dataProtectionTitle')}
      </CardTitle>

      <GroupLabel>{t('dpTrashTitle')}</GroupLabel>
      <FactList>
        <FactRow label={t('dpStateLabel')} value={t('valEnabled')} tone="ok" />
        <FactRow label={t('dpTrashRetention')} value={t('dpTrashRetentionValue')} />
      </FactList>

      <GroupLabel>{t('dpHistoryTitle')}</GroupLabel>
      <FactList>
        <FactRow label={t('dpStateLabel')} value={t('valEnabled')} tone="ok" />
        <FactRow label={t('dpHistoryModel')} value={t('dpHistoryModelValue')} mono={false} />
      </FactList>
      <p className="text-[11.5px] text-ink-3 leading-relaxed mt-2 max-w-[62ch]">{t('dpHistoryNotSnapshot')}</p>

      <GroupLabel>{t('dpVaultTitle')}</GroupLabel>
      <FactList>
        <FactRow label={t('secVaultEncryption')} value={t('secVaultZeroKnowledge')} tone="ok" />
        <FactRow label={t('dpVaultServerPlaintext')} value={t('valUnavailable')} />
      </FactList>
    </Card>
  )
}

/* ── Backup readiness ───────────────────────────────────────────────────────
   Shown when the host backup agent is not connected. The point is to replace a
   blank disabled form with the actual list of prerequisites, so an operator can
   see what is missing without reading the deployment docs.

   ⚠️ Nothing here is actionable from the browser by design: Drive cannot install
      an agent, mount a target, or accept a path. */
const BACKUP_REQUIREMENTS = [
  'backupReqOffHost', 'backupReqAgent', 'backupReqAllowlist',
  'backupReqDbRole', 'backupReqRun', 'backupReqIntegrity', 'backupReqRestore',
]

export function BackupReadinessCard({ t }) {
  return (
    <Card className="p-5">
      <CardTitle sub={t('backupReadinessSub')} right={<Chip tone="warn">{t('notConnected')}</Chip>}>
        {t('backupReadinessTitle')}
      </CardTitle>
      <ul className="flex flex-col gap-2 mt-1">
        {BACKUP_REQUIREMENTS.map((key) => (
          <li key={key} className="flex items-start gap-2.5 text-[12.5px] text-ink-2 leading-relaxed">
            <span
              aria-hidden
              className="mt-1.5 size-3 shrink-0 rounded-[3px] hatch hatch-ink3 border border-line"
            />
            {t(key)}
          </li>
        ))}
      </ul>
      <p className="text-[11.5px] text-ink-3 leading-relaxed mt-3 max-w-[62ch]">{t('backupReadinessNote')}</p>
    </Card>
  )
}

/* ── Encryption posture (Administrator) ─────────────────────────────────────
   ⚠️ No "rotate encryption key" control appears here, and none should be added:
      there is no AEGIS server master key in this system to rotate. The Vault key
      is derived in the browser and never reaches the server; Data Lake files are
      stored as plaintext. Both facts are stated rather than blurred into a
      generic "encryption: enabled". */
export function EncryptionPostureCard({ t }) {
  return (
    <Card className="p-5">
      <CardTitle right={<CategoryChip t={t} kind="system" />}>{t('encPostureTitle')}</CardTitle>

      <GroupLabel>{t('encPostureVaultGroup')}</GroupLabel>
      <FactList>
        <FactRow label={t('encPostureBrowserEnc')} value={t('valActive')} tone="ok" />
        <FactRow label={t('encPostureServerKey')} value={t('valNone')} />
      </FactList>

      <GroupLabel>{t('encPostureLakeGroup')}</GroupLabel>
      <FactList>
        <FactRow label={t('encPostureAppLayer')} value={t('valNotConfigured')} tone="warn" />
        {/* Drive has no telemetry source for LUKS/dm-crypt state, so it does not
            guess. "Not measured" is the honest value; "off" would be a claim. */}
        <FactRow label={t('encPostureFsLayer')} value={t('valNotMeasured')} />
      </FactList>

      <p className="text-[12.5px] text-ink-2 leading-relaxed mt-3 max-w-[62ch]">{t('encPostureNote')}</p>
    </Card>
  )
}

/* ── Administrative links ───────────────────────────────────────────────────
   Navigation only. Rendered inside the admin tab, which is itself filtered out
   of `groups` for non-admins, so these never reach another role's DOM. */
export function AdminLinksCard({ t, go }) {
  const links = [
    { screen: 'audit', icon: Activity, label: 'adminLinkAudit', note: 'adminLinkAuditNote' },
    { screen: 'access', icon: ShieldCheck, label: 'adminLinkAccess', note: 'adminLinkAccessNote' },
  ]
  return (
    <Card className="p-5">
      <CardTitle right={<CategoryChip t={t} kind="action" />}>{t('adminLinksTitle')}</CardTitle>
      <div className="flex flex-col">
        {links.map(({ screen, icon: Icon, label, note }) => (
          <button
            key={screen}
            type="button"
            onClick={() => go(screen)}
            className="flex items-center gap-3 py-3 border-b border-line last:border-b-0 text-left cursor-pointer group"
          >
            <Icon size={16} strokeWidth={1.5} className="text-ink-3 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-medium text-ink">{t(label)}</span>
              <span className="block text-[12px] text-ink-3 mt-0.5">{t(note)}</span>
            </span>
            <ExternalLink
              size={14}
              strokeWidth={1.5}
              className="text-ink-3 shrink-0 group-hover:text-accent transition-colors duration-[var(--dur-fast)]"
            />
          </button>
        ))}
      </div>
    </Card>
  )
}
