// src/components/preview/PreviewModalShell.jsx — AEGIS Drive (IDEA1) · Unified Preview P0 · shared preview modal (spec §2, §19)
//
// One modal shell for Normal Files and the Private Vault. The renderer (image/video/…) is the
// child; the shell owns what must be identical everywhere:
//   • name, detected type label, size
//   • a truthful status — loading (role=status), failed (role=alert), unsupported, too-large
//   • a Download action that NO preview outcome can remove or disable (spec §2 rule 1)
//   • loading can never spin forever: after `loadingTimeoutMs` it becomes a failure
import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { Btn, Modal, ModalClose } from '../ui.jsx'
import { fmtBytes } from '../../lib/format.js'

export const PREVIEW_LOADING_TIMEOUT_MS = 45_000
const STATUSES = new Set(['loading', 'ready', 'failed', 'unsupported', 'too-large'])

/**
 * @param {{ t: Function, open: boolean, title: string, meta?: { typeLabel?: string, size?: number },
 *   status: 'loading'|'ready'|'failed'|'unsupported'|'too-large', reason?: string|null,
 *   onClose: Function, onDownload?: Function|null, loadingTimeoutMs?: number, labelledBy?: string, width?: number,
 *   bodyProps?: object, children?: any }} props
 */
export function PreviewModalShell({
  t, open, title, meta = {}, status, reason = null, onClose, onDownload = null,
  loadingTimeoutMs = PREVIEW_LOADING_TIMEOUT_MS, labelledBy = 'preview-shell-title', width = 880, bodyProps = {}, children = null,
}) {
  const requested = STATUSES.has(status) ? status : 'failed'
  // timeout is keyed to the loading episode: a new loading status restarts it
  const [timedOutEpisode, setTimedOutEpisode] = useState(null)
  const episode = `${title}|${requested}`
  useEffect(() => {
    if (!open || requested !== 'loading' || !(loadingTimeoutMs > 0)) return undefined
    const id = setTimeout(() => setTimedOutEpisode(episode), loadingTimeoutMs)
    return () => clearTimeout(id)
  }, [open, requested, loadingTimeoutMs, episode])
  const effective = requested === 'loading' && timedOutEpisode === episode ? 'failed' : requested

  const message = effective === 'failed' ? (reason ?? t('previewUnavailable'))
    : effective === 'unsupported' ? (reason ?? t('previewUnsupported'))
      : effective === 'too-large' ? (reason ?? t('previewTooLarge'))
        : null
  const typeLabel = meta.typeLabel || t('previewTypeUnknown')
  return (
    <Modal open={open} onClose={onClose} width={width} labelledBy={labelledBy}>
      <ModalClose onClose={onClose} label={t('close')} />
      <h2 id={labelledBy} className="text-[16px] font-semibold text-ink pr-8 truncate">{title}</h2>
      <p className="text-[12px] text-ink-3 mt-1" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {typeLabel}{Number.isFinite(meta.size) ? ` · ${fmtBytes(meta.size)}` : ''}
      </p>
      <div
        {...bodyProps}
        data-preview-shell="1"
        data-preview-state={effective}
        className="mt-4 rounded-[var(--r-tile)] bg-sunken border border-line flex items-center justify-center overflow-hidden relative"
        style={{ minHeight: 220, ...(bodyProps.style ?? {}) }}
      >
        {effective === 'loading' && (
          <p role="status" className="absolute text-[13px] text-ink-3">{t('previewLoading')}</p>
        )}
        {effective === 'failed' ? (
          <p role="alert" className="text-[13px] font-medium px-6 py-10 text-center max-w-md" style={{ color: 'var(--danger)' }}>{message}</p>
        ) : effective === 'unsupported' || effective === 'too-large' ? (
          <p role="status" className="text-[13px] text-ink-2 px-6 py-10 text-center max-w-md">{message}</p>
        ) : children}
      </div>
      <div className="flex gap-2.5 mt-5 justify-end">
        <Btn variant="outline" onClick={onClose}>{t('close')}</Btn>
        {onDownload && (
          <Btn variant="primary" data-preview-download="1" onClick={() => onDownload()}>
            <Download size={14} strokeWidth={1.5} />
            {t('download')}
          </Btn>
        )}
      </div>
    </Modal>
  )
}
