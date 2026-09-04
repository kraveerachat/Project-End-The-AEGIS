import { useEffect, useMemo, useState } from 'react'
import { ArchiveRestore, Clock3, File, LockKeyhole, Search, ShieldCheck, Trash2 } from 'lucide-react'
import {
  Btn, Card, Chip, EmptyState, ErrorState, Field, Modal, ModalClose,
  PillInput, PillSelect, SkeletonLoader,
} from '../components/ui.jsx'
import { apiFetch } from '../lib/api.js'
import { fmtBytes } from '../lib/format.js'

const remainingLabel = (t, purgeAt, now) => {
  const remaining = Math.max(0, new Date(purgeAt).getTime() - now)
  const days = Math.ceil(remaining / 86_400_000)
  if (days > 1) return t('trashDaysLeft').replace('{n}', String(days))
  const hours = Math.max(1, Math.ceil(remaining / 3_600_000))
  return t('trashHoursLeft').replace('{n}', String(hours))
}

export function Trash({ t }) {
  const [phase, setPhase] = useState('loading')
  const [password, setPassword] = useState('')
  const [items, setItems] = useState([])
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('deleted')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState(null)
  const [restore, setRestore] = useState(null)
  const [purge, setPurge] = useState(null)
  const [empty, setEmpty] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [destructivePassword, setDestructivePassword] = useState('')
  const [modalError, setModalError] = useState(false)
  const [now, setNow] = useState(Date.now())

  const loadItems = async () => {
    setError(null)
    const result = await apiFetch('/api/trash')
    if (result.status === 423) {
      setItems([])
      setPhase('locked')
      return
    }
    if (!result.ok) {
      setError(result.errorKind ?? 'server')
      setPhase('unlocked')
      return
    }
    setItems(result.data?.items ?? [])
    setPhase('unlocked')
  }

  useEffect(() => {
    let active = true
    apiFetch('/api/trash/status').then((result) => {
      if (!active) return
      if (!result.ok || !result.data?.unlocked) setPhase('locked')
      else loadItems()
    })
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    const authorizationTimer = setInterval(() => {
      apiFetch('/api/trash/status').then((result) => {
        if (active && (!result.ok || !result.data?.unlocked)) {
          setItems([])
          setPhase('locked')
        }
      })
    }, 5_000)
    return () => { active = false; clearInterval(timer); clearInterval(authorizationTimer) }
  }, [])

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const rows = needle ? items.filter((item) => item.name.toLocaleLowerCase().includes(needle)) : [...items]
    rows.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name)
      if (sort === 'size') return b.size - a.size
      if (sort === 'purge') return new Date(a.purgeAt) - new Date(b.purgeAt)
      return new Date(b.deletedAt) - new Date(a.deletedAt)
    })
    return rows
  }, [items, query, sort])

  const unlock = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const result = await apiFetch('/api/trash/unlock', {
      method: 'POST', body: { password }, suppressAuthHandler: true,
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.status === 429 ? 'locked' : result.errorKind ?? 'server')
      return
    }
    setPassword('')
    setFeedback(t('trashUnlocked'))
    await loadItems()
  }

  const lock = async () => {
    await apiFetch('/api/trash/lock', { method: 'POST' })
    setItems([])
    setFeedback(null)
    setPhase('locked')
  }

  const restoreItem = async () => {
    if (!restore) return
    setModalError(false)
    setBusy(true)
    const result = await apiFetch(`/api/trash/${encodeURIComponent(restore.id)}/restore`, {
      method: 'POST', body: restore.name === restore.originalName ? {} : { name: restore.name },
    })
    setBusy(false)
    if (result.status === 409 && result.data?.code === 'NAME_CONFLICT') {
      setRestore((current) => ({ ...current, name: result.data.suggestedName, conflict: true }))
      return
    }
    if (!result.ok) {
      setModalError(true)
      return
    }
    setRestore(null)
    setFeedback(t('trashRestored'))
    await loadItems()
  }

  const purgeItem = async () => {
    if (!purge) return
    setModalError(false)
    setBusy(true)
    const result = await apiFetch(`/api/trash/${encodeURIComponent(purge.id)}`, {
      method: 'DELETE', body: { password: destructivePassword }, suppressAuthHandler: true,
    })
    setBusy(false)
    if (!result.ok) {
      setModalError(true)
      return
    }
    setPurge(null)
    setDestructivePassword('')
    setFeedback(t('trashPurged'))
    await loadItems()
  }

  const emptyTrash = async () => {
    setModalError(false)
    setBusy(true)
    const result = await apiFetch('/api/trash/empty', {
      method: 'POST', body: { password: destructivePassword, confirmation: confirmText }, suppressAuthHandler: true,
    })
    setBusy(false)
    if (!result.ok) {
      setModalError(true)
      return
    }
    setEmpty(false)
    setConfirmText('')
    setDestructivePassword('')
    setItems([])
    setFeedback(t('trashEmptied').replace('{n}', String(result.data.deletedCount)))
    setPhase('locked')
  }

  if (phase === 'loading') return <SkeletonLoader type="table" />

  if (phase === 'locked') {
    return (
      <Card className="max-w-[720px] mx-auto overflow-hidden">
        <div className="hatch hatch-ink3 px-8 py-10 max-md:px-5">
          <div className="max-w-[440px] mx-auto rounded-[var(--r-card)] border border-line bg-card p-7 text-center" style={{ boxShadow: 'var(--elev-1)' }}>
            <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent-ink">
              <LockKeyhole size={22} strokeWidth={1.5} aria-hidden />
            </span>
            <h2 className="mt-4 text-[18px] font-semibold text-ink">{t('trashLockedTitle')}</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{t('trashLockedBody')}</p>
            <form onSubmit={unlock} className="mt-6 text-left">
              <Field id="trash-password" label={t('trashCurrentPassword')}>
                <PillInput
                  id="trash-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  data-modal-autofocus
                />
              </Field>
              {error && <p role="alert" className="mt-3 text-[12.5px] font-medium text-danger">{error === 'locked' ? t('trashRateLimited') : t('trashUnlockFailed')}</p>}
              <Btn type="submit" variant="primary" className="mt-5 w-full" disabled={busy || !password}>
                <ShieldCheck size={16} strokeWidth={1.5} />
                {busy ? t('trashUnlocking') : t('trashUnlock')}
              </Btn>
            </form>
          </div>
        </div>
      </Card>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
        <div className="flex items-center gap-2.5">
          <Chip tone="warn"><Clock3 size={12} />{t('trashRetention')}</Chip>
          <span className="text-[12.5px] text-ink-3">{t('trashRetentionBody')}</span>
        </div>
        <div className="flex items-center gap-2">
          <Btn variant="ghost" size="sm" onClick={lock}><LockKeyhole size={14} />{t('trashLock')}</Btn>
          <Btn variant="dangerSoft" size="sm" onClick={() => { setModalError(false); setEmpty(true) }} disabled={!items.length}>
            <Trash2 size={14} />{t('trashEmpty')}
          </Btn>
        </div>
      </div>

      {feedback && <div role="status" className="mb-4 rounded-xl border border-line bg-card px-4 py-3 text-[13px] font-medium text-ink">{feedback}</div>}

      <div className="flex items-center gap-2.5 mb-5 flex-wrap">
        <label className="relative flex-1 min-w-[220px] max-w-md">
          <span className="sr-only">{t('trashSearch')}</span>
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('trashSearch')} className="w-full h-10 pl-10 pr-4 rounded-full bg-sunken border border-line text-[13.5px] text-ink outline-none focus:border-accent" />
        </label>
        <div className="w-48 max-md:flex-1">
          <PillSelect value={sort} onChange={(event) => setSort(event.target.value)} aria-label={t('sortBy')}>
            <option value="deleted">{t('trashSortDeleted')}</option>
            <option value="purge">{t('trashSortPurge')}</option>
            <option value="name">{t('sortName')}</option>
            <option value="size">{t('sortSize')}</option>
          </PillSelect>
        </div>
      </div>

      {error ? <Card><ErrorState t={t} kind={error} onRetry={loadItems} /></Card> : visible.length === 0 ? (
        <Card><EmptyState icon={ArchiveRestore} title={query ? t('trashNoMatches') : t('trashEmptyTitle')} hint={query ? undefined : t('trashEmptyBody')} /></Card>
      ) : (
        <div className="grid gap-3">
          {visible.map((item) => (
            <Card key={item.id} className="px-5 py-4">
              <div className="flex items-center gap-4 max-md:items-start">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-sunken text-ink-3"><File size={18} strokeWidth={1.5} /></span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold text-ink">{item.name}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-3" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    <span>{fmtBytes(item.size)}</span>
                    <span>{t('trashVersions').replace('{n}', String(item.versionCount))}</span>
                    <span className="font-mono">SHA-256 {item.sha256Prefix ?? '—'}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 max-md:flex-col max-md:items-end">
                  <Chip tone="warn">{remainingLabel(t, item.purgeAt, now)}</Chip>
                  <div className="flex items-center gap-1">
                    <Btn size="sm" variant="outline" onClick={() => { setModalError(false); setRestore({ ...item, originalName: item.name }) }}><ArchiveRestore size={14} />{t('trashRestore')}</Btn>
                    <Btn size="sm" variant="dangerSoft" onClick={() => { setModalError(false); setPurge(item); setDestructivePassword('') }}><Trash2 size={14} />{t('trashDeleteForever')}</Btn>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={Boolean(restore)} onClose={() => setRestore(null)} width={460} labelledBy="trash-restore-title">
        <ModalClose onClose={() => setRestore(null)} label={t('cancel')} />
        <h2 id="trash-restore-title" className="text-[18px] font-semibold text-ink">{t('trashRestoreTitle')}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{t('trashRestoreBody')}</p>
        <div className="mt-5"><Field id="trash-restore-name" label={t('colName')}><PillInput id="trash-restore-name" value={restore?.name ?? ''} onChange={(event) => setRestore((current) => ({ ...current, name: event.target.value }))} /></Field></div>
        {restore?.conflict && <p role="alert" className="mt-3 text-[12.5px] text-warn">{t('trashNameConflict')}</p>}
        {modalError && <p role="alert" className="mt-3 text-[12.5px] font-medium text-danger">{t('trashActionFailed')}</p>}
        <div className="mt-6 flex justify-end gap-2"><Btn onClick={() => setRestore(null)}>{t('cancel')}</Btn><Btn variant="primary" onClick={restoreItem} disabled={busy || !restore?.name}>{t('trashRestore')}</Btn></div>
      </Modal>

      <Modal open={Boolean(purge)} onClose={() => setPurge(null)} width={460} labelledBy="trash-purge-title">
        <ModalClose onClose={() => setPurge(null)} label={t('cancel')} />
        <h2 id="trash-purge-title" className="text-[18px] font-semibold text-danger">{t('trashDeleteForeverTitle')}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{t('trashDeleteForeverBody').replace('{name}', purge?.name ?? '')}</p>
        <div className="mt-5"><Field id="trash-purge-password" label={t('trashCurrentPassword')}><PillInput id="trash-purge-password" type="password" autoComplete="current-password" value={destructivePassword} onChange={(event) => setDestructivePassword(event.target.value)} /></Field></div>
        {modalError && <p role="alert" className="mt-3 text-[12.5px] font-medium text-danger">{t('trashActionFailed')}</p>}
        <div className="mt-6 flex justify-end gap-2"><Btn onClick={() => setPurge(null)}>{t('cancel')}</Btn><Btn variant="danger" onClick={purgeItem} disabled={busy || !destructivePassword}>{t('trashDeleteForever')}</Btn></div>
      </Modal>

      <Modal open={empty} onClose={() => setEmpty(false)} width={480} labelledBy="trash-empty-title">
        <ModalClose onClose={() => setEmpty(false)} label={t('cancel')} />
        <h2 id="trash-empty-title" className="text-[18px] font-semibold text-danger">{t('trashEmptyTitleConfirm')}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{t('trashEmptyBodyConfirm')}</p>
        <div className="mt-5 grid gap-4">
          <Field id="trash-empty-confirm" label={t('trashTypeDelete')}><PillInput id="trash-empty-confirm" value={confirmText} onChange={(event) => setConfirmText(event.target.value)} /></Field>
          <Field id="trash-empty-password" label={t('trashCurrentPassword')}><PillInput id="trash-empty-password" type="password" autoComplete="current-password" value={destructivePassword} onChange={(event) => setDestructivePassword(event.target.value)} /></Field>
        </div>
        {modalError && <p role="alert" className="mt-3 text-[12.5px] font-medium text-danger">{t('trashActionFailed')}</p>}
        <div className="mt-6 flex justify-end gap-2"><Btn onClick={() => setEmpty(false)}>{t('cancel')}</Btn><Btn variant="danger" onClick={emptyTrash} disabled={busy || confirmText !== 'DELETE' || !destructivePassword}>{t('trashEmpty')}</Btn></div>
      </Modal>
    </div>
  )
}
