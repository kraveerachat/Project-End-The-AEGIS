// src/components/vault/VaultTransferPanel.jsx — AEGIS Drive (IDEA1) · แถบสถานะการโอนของ Vault V2
// ใช้ร่วมกันระหว่างจอเลกาซี (Vault.jsx) และจอต้นไม้ (VaultTreeScreen.jsx)
import { Btn } from '../ui.jsx'
import { fmtBytes } from '../../lib/format.js'
import { transferRateLine } from '../../lib/transferRate.js'

/* ── แถบสถานะการโอนของ Vault V2 ──────────────────────────────────────
   ⚠️ กติกาข้อเดียวที่คอมโพเนนต์นี้มีไว้รักษา: **ทุกตัวเลขบนแถบนี้ต้องมาจากงานจริง**
      เปอร์เซ็นต์คำนวณจากไบต์ที่ผ่านไปแล้ว และ "ส่วนที่ X จาก N" คือดัชนี chunk จริง
      ไม่มี setInterval ที่ขยับแถบเอง — แถบที่เดินต่อขณะเน็ตหยุดคือการโกหกผู้ใช้ว่างาน
      ยังคืบหน้า แล้วเขาจะรอต่อไปแทนที่จะกดทำต่อหรือแก้ปัญหาเครือข่าย
   ⚠️ สถานะ 'unsupported' ไม่ใช่ความล้มเหลวและไม่มีปุ่มลองใหม่ — มันคือความจริงเกี่ยวกับ
      เบราว์เซอร์ที่ใช้อยู่ ปุ่ม "ลองใหม่" ตรงนั้นจะทำให้ผู้ใช้กดวนไปเรื่อย ๆ โดยไม่มีทางสำเร็จ */
export function VaultTransferPanel({ t, transfer, onResume, onCancel, onDismiss }) {
  if (!transfer) return null

  const { kind, stage, chunkIndex = 0, chunkCount = 0, transferredBytes = 0, totalBytes = 0, percent = 0 } = transfer
  const humanIndex = Math.min(chunkCount, chunkIndex + 1)
  const vars = { index: humanIndex, count: chunkCount }

  // ZIP หลายไฟล์ (kind 'download'): ขั้นเตรียม/กำลังรวมไฟล์/กำลังปิดท้าย — "เตรียมการเข้ารหัส" คงไว้ให้การอัปโหลดเท่านั้น
  const label = stage === 'preparing' ? t(kind === 'download' ? 'zipPreparing' : 'vaultXferPreparing')
    : stage === 'archiving' ? t('zipArchiving', { index: transfer.index ?? 0, count: transfer.count ?? 0, name: transfer.name ?? '' })
    : stage === 'finalizing' ? t('zipFinalizing')
    : stage === 'encrypting' ? t('vaultXferEncrypting', vars)
      : stage === 'uploading' ? t('vaultXferUploading', vars)
        : stage === 'committing' ? t('vaultXferCommitting')
          : stage === 'downloading' ? t('vaultXferDownloading', vars)
            : stage === 'paused' ? t('vaultXferPaused')
              : stage === 'unsupported' ? t('vaultXferUnsupported')
                : t('vaultXferFailed')

  const reasonKey = {
    network: 'vaultXferReasonNetwork',
    server: 'vaultXferReasonServer',
    tooLarge: 'vaultXferReasonTooLarge',
    noSpace: 'vaultXferReasonNoSpace',
    integrity: 'vaultXferReasonIntegrity',
    expired: 'vaultXferReasonExpired',
    'auth-failed': 'vaultXferReasonAuth',
    // ดิสก์ของผู้ใช้เต็ม ≠ Data Lake เต็ม — ห้ามใช้ข้อความ noSpace (spec §19)
    localDiskFull: 'xferReasonLocalDiskFull',
    finalizeFailed: 'xferReasonFinalizeFailed',
  }[transfer.reason]

  // ⚠️ ความเร็วมีความหมายเฉพาะช่วงที่ไบต์กำลังวิ่งจริง ระหว่าง 'committing' เซิร์ฟเวอร์
  //    กำลังตรวจไบต์ของตัวเองอยู่ ไม่มีอะไรวิ่งบนสาย — การขึ้น "กำลังรอเครือข่าย" ตรงนั้น
  //    จะเป็นคำเตือนปลอมที่ทำให้ผู้ใช้กดยกเลิก commit ที่กำลังทำงานปกติ
  const measuring = stage === 'uploading' || stage === 'encrypting' || stage === 'downloading' || stage === 'archiving'
    || (kind === 'download' && stage === 'preparing')
  const rateLine = transferRateLine(t, transfer.rate)
  const rateBps = transfer.rate?.bytesPerSecond ?? null
  const etaSeconds = transfer.rate?.etaSeconds ?? null

  const active = stage === 'preparing' || stage === 'encrypting' || stage === 'uploading'
    || stage === 'committing' || stage === 'downloading' || stage === 'archiving' || stage === 'finalizing'
  // ⚠️ ระหว่าง finalizing (close() เริ่มแล้ว) การยกเลิกรับประกันไม่ได้ว่าเบราว์เซอร์จะไม่ commit ไฟล์ — ไม่มีปุ่ม Cancel
  const cancellable = active && stage !== 'finalizing'
  const stopped = stage === 'failed' || stage === 'paused' || stage === 'unsupported'
  const tone = stage === 'failed' ? 'var(--danger)' : stage === 'paused' ? 'var(--warn)' : 'var(--ink-2)'

  return (
    <div
      className="rounded-[var(--r-tile)] border border-line bg-sunken px-4 py-3 mb-4"
      data-vault-transfer={kind}
      data-vault-transfer-stage={stage}
    >
      <div className="flex items-baseline gap-3 flex-wrap">
        <p role="status" aria-live="polite" className="text-[12.5px] font-medium" style={{ color: tone }}>
          {label}
        </p>
        <div className="flex-1" />
        {/* ⚠️ ตัวเลขนี้เป็นหน่วยเดียวกับขนาดไฟล์ที่ผู้ใช้เห็นในการ์ด (plaintext)
            ไม่ใช่ขนาด ciphertext ที่วิ่งบนสาย — ผู้ใช้ไม่ควรต้องแปลหน่วยเอง */}
        {stage !== 'unsupported' && (
          <p
            className="text-[12px] text-ink-3 font-mono"
            style={{ fontVariantNumeric: 'tabular-nums' }}
            data-vault-transfer-bytes={String(transferredBytes)}
            data-vault-transfer-total={String(totalBytes)}
          >
            {t('vaultXferProgress', {
              done: fmtBytes(transferredBytes), total: fmtBytes(totalBytes), percent,
            })}
          </p>
        )}
      </div>

      {stage !== 'unsupported' && (
        <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--line)' }}>
          <div
            className="h-full rounded-full transition-[width] duration-[var(--dur-fast)]"
            style={{ width: `${Math.max(0, Math.min(100, percent))}%`, background: stage === 'failed' ? 'var(--danger)' : 'var(--accent)' }}
            role="progressbar"
            aria-valuenow={Math.round(percent)}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
      )}

      {/* ⚠️ พื้นที่นี้ถูกจองความสูงไว้ตลอดช่วงที่กำลังโอน แม้ตอนที่ยังวัดความเร็วไม่ได้ —
          ไม่งั้นแผงจะกระตุกขึ้นลงทุกครั้งที่ตัวเลขปรากฏหรือหายไป */}
      {measuring && (
        <div className="mt-1.5 flex justify-end min-h-[16px]">
          <p
            className="text-[12px] text-ink-3 font-mono"
            style={{ fontVariantNumeric: 'tabular-nums' }}
            data-vault-transfer-rate={rateBps === null ? '' : String(Math.round(rateBps))}
            data-vault-transfer-eta={etaSeconds === null ? '' : String(Math.round(etaSeconds))}
            data-vault-transfer-stalled={transfer.rate?.stalled ? 'yes' : 'no'}
          >
            {rateLine}
          </p>
        </div>
      )}

      {reasonKey && (
        <p className="text-[12px] text-ink-3 mt-2">{t(reasonKey)}</p>
      )}
      {stage === 'failed' && transfer.failedName && (
        <p className="text-[12px] text-ink-3 mt-1" data-vault-transfer-failed-entry="">{t('zipFailedEntry', { name: transfer.failedName })}</p>
      )}

      <div className="flex gap-2 mt-3">
        {stage === 'paused' && (
          <Btn variant="primary" size="sm" onClick={onResume}>{t('vaultXferResume')}</Btn>
        )}
        {cancellable && (
          <Btn variant="outline" size="sm" onClick={onCancel}>{t('vaultXferCancel')}</Btn>
        )}
        {stopped && (
          <Btn variant="outline" size="sm" onClick={onDismiss}>{t('vaultXferDismiss')}</Btn>
        )}
      </div>
    </div>
  )
}
