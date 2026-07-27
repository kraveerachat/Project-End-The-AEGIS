import { useRef, useState } from 'react'
import { UploadCloud, FileText, File as FileIcon } from 'lucide-react'
import { Card, CardTitle, Chip, ScrambleHash, ErrorState, EmptyState, SkeletonLoader } from '../components/ui.jsx'
import { useApi, useNow } from '../lib/hooks.js'
import { apiFetch } from '../lib/api.js'
import { fmtBytes, fmtRelative } from '../lib/format.js'

/* ไม่มีการจำลองในจอนี้เลย —
   - แฮชคำนวณจริงจากไบต์ของไฟล์ที่ผู้ใช้เลือก ด้วย window.crypto.subtle.digest('SHA-256')
     (checksum นี้ถูกส่งไปให้เซิร์ฟเวอร์ "เทียบ" กับไบต์ที่ได้รับจริง — ดู POST
     /api/files/upload: ไม่ตรงกัน = ปฏิเสธทั้งคำขอ ไม่เก็บของที่รู้ว่าไม่ครบ)
   - "transferring" = POST /api/files/upload จริง และ **ตัว binary เดินทางไปกับคำขอนี้ด้วย**
     (multipart → เขียนลงดิสก์ผ่าน multer diskStorage)
     ⚠️ คอมเมนต์เดิมเขียนว่า "Phase นี้ส่ง metadata; ตัว binary ผ่าน multipart →
     Storage Layer ใน Phase 3" ซึ่งไม่จริงแล้ว — ไบต์ถูกเขียนลง Storage Layer จริงมาตั้งแต่
     งาน upload/download รอบก่อน (ชุดทดสอบดาวน์โหลดกลับมาเทียบทีละไบต์อยู่)
   - ประวัติการอัปโหลดมาจาก GET /api/files — ไม่มีลิสต์แต่งขึ้น
   - อัปโหลดชื่อเดิมทับของตัวเอง = สร้างเวอร์ชันใหม่ ไบต์ชุดเก่าถูกเก็บไว้ (ดูจอ File history) */

const STAGE_KEY = { staged: 'stStaged', hashing: 'stHashing', transferring: 'stTransferring', indexed: 'stIndexed', failed: 'stFailed' }

// ต้องตรงกับ MAX_UPLOAD_BYTES ใน server/storage/fileStore.js — เช็คฝั่ง client เป็นแค่
// ความสะดวก (บอกผู้ใช้ทันทีโดยไม่ต้องอัปโหลดขึ้นไปให้ถูกปฏิเสธ) การบังคับจริงอยู่ที่เซิร์ฟเวอร์
const MAX_UPLOAD_BYTES = 1_073_741_824 // 1 GiB

/** SHA-256 ของไฟล์จริงในเบราว์เซอร์ — คืนค่า hex 64 ตัว */
async function sha256OfFile(file) {
  const buf = await file.arrayBuffer()
  const digest = await window.crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/* One upload row — สถานะเดินตาม "งานจริง" ไม่ใช่ timer */
function UploadRow({ t, item }) {
  const isCipher = item.stage === 'hashing' || item.stage === 'transferring'
  const chipTone = item.stage === 'indexed' ? 'ok' : item.stage === 'failed' ? 'danger' : item.stage === 'staged' ? 'neutral' : 'accent'

  return (
    <div
      className="relative overflow-hidden rounded-[var(--r-tile)] border border-line transition-colors duration-[var(--dur-base)]"
      style={{ background: item.stage === 'indexed' ? 'var(--ok-soft)' : item.stage === 'failed' ? 'var(--danger-soft)' : 'var(--card)' }}
    >
      {/* the file becoming ciphertext before your eyes */}
      <div
        aria-hidden
        className="absolute inset-0 hatch hatch-ink3 pointer-events-none transition-[clip-path,opacity]"
        style={{
          clipPath: isCipher ? 'inset(0 0 0 0)' : 'inset(0 100% 0 0)',
          opacity: item.stage === 'hashing' ? 0.9 : isCipher ? 0.28 : 0,
          transitionDuration: '600ms',
          transitionTimingFunction: 'var(--ease)',
        }}
      />
      <div className="relative flex items-center gap-3 px-4 py-3">
        <div className="size-8 rounded-[9px] bg-sunken flex items-center justify-center shrink-0">
          <FileIcon size={15} strokeWidth={1.5} className="text-ink-2" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium text-ink truncate">{item.name}</p>
          <p className="text-[11.5px] text-ink-3" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {fmtBytes(item.size)}
          </p>
          {/* บอกเหตุผลที่ล้มเหลว ไม่ใช่แค่ชิป "Failed" — ผู้ใช้ต้องรู้ว่าต้องทำอะไรต่อ */}
          {item.reason === 'tooLarge' && (
            <p role="alert" className="text-[11.5px] font-medium mt-0.5" style={{ color: 'var(--danger)' }}>
              {t('uploadTooLarge')}
            </p>
          )}
        </div>
        {item.stage === 'indexed' && (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <path d="M3 8.5l3.2 3.2L13 4.5" fill="none" stroke="var(--ok)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="draw-check" />
          </svg>
        )}
        <Chip tone={chipTone}>{t(STAGE_KEY[item.stage])}</Chip>
      </div>

      {(item.stage === 'transferring' || item.stage === 'indexed') && item.sha256 && (
        <div className="relative px-4 pb-3 -mt-1">
          <ScrambleHash hash={item.sha256} playing={false} duration={1} groupClass="text-ink-3 !text-[10.5px]" />
        </div>
      )}

      {/* thin live progress under the row */}
      <div className="relative h-0.5 bg-transparent">
        <div
          className="h-full transition-[width] duration-300"
          style={{
            width: item.stage === 'staged' ? '5%' : item.stage === 'hashing' ? '40%' : item.stage === 'transferring' ? '75%' : '100%',
            background: item.stage === 'indexed' ? 'var(--ok)' : item.stage === 'failed' ? 'var(--danger)' : 'var(--accent)',
          }}
        />
      </div>
    </div>
  )
}

export function Uploads({ t }) {
  const now = useNow(30_000)
  const filesApi = useApi('/api/files', { refreshMs: 30_000 })
  const recent = (filesApi.data?.files ?? []).filter((f) => f.type !== 'Folder').slice(0, 6)

  const [dragOver, setDragOver] = useState(false)
  const [queue, setQueue] = useState([])
  const inputRef = useRef(null)
  const idRef = useRef(0)

  const setStage = (id, patch) =>
    setQueue((prev) => prev.map((q) => (q.id === id ? { ...q, ...patch } : q)))

  /** ประมวลผลไฟล์จริง: hash (WebCrypto) → POST ตัวไฟล์จริง (multipart) → indexed/failed
   *  sha256 ที่ส่งไปเป็นแค่ "ค่าที่ client อ้าง" — เซิร์ฟเวอร์คำนวณเองจาก bytes ที่ได้รับ
   *  แล้วเทียบ ถ้าไม่ตรง = ไฟล์เพี้ยนระหว่างทาง เซิร์ฟเวอร์ปฏิเสธ (422) ไม่เก็บของที่ไม่ครบ */
  const processFile = async (file, id) => {
    try {
      setStage(id, { stage: 'hashing' })
      const sha256 = await sha256OfFile(file)
      setStage(id, { stage: 'transferring', sha256 })
      const form = new FormData()
      form.append('sha256', sha256)
      form.append('file', file, file.name) // ต้องต่อท้ายสุด — multer อ่าน field ตามลำดับ stream
      const res = await apiFetch('/api/files/upload', {
        method: 'POST',
        body: form,
        timeoutMs: 10 * 60_000, // ไฟล์ใหญ่ใช้เวลานานกว่า request ปกติมาก
      })
      setStage(id, { stage: res.ok ? 'indexed' : 'failed' })
      if (res.ok) filesApi.retry()
    } catch {
      setStage(id, { stage: 'failed' })
    }
  }

  // ⚠️ เดิมบรรทัดนี้ .filter() ไฟล์ที่ใหญ่กว่า 1 GiB "ออกจากคิวไปเงียบ ๆ" พร้อมคอมเมนต์
  //    ว่าเป็นงานของ Phase 3 — ผู้ใช้ลากไฟล์ 2 GB มาวางแล้ว **ไม่มีอะไรเกิดขึ้นเลย**
  //    ไม่มีแถว ไม่มีข้อความ ไม่มีสัญญาณว่าระบบเห็นไฟล์นั้นไหม ซึ่งแยกไม่ออกจาก
  //    "แอปพัง" การทิ้งงานของผู้ใช้โดยไม่บอกแย่กว่าการปฏิเสธอย่างชัดเจน
  //    เพดาน 1 GiB คือของจริงที่เซิร์ฟเวอร์บังคับ (MAX_UPLOAD_BYTES ใน fileStore.js)
  //    ไม่ใช่ข้อจำกัดชั่วคราวที่รอ phase ถัดไป — จอจึงต้องบอกตามนั้น
  const enqueue = (fileList) => {
    for (const f of [...fileList]) {
      const id = `up-${idRef.current++}`
      if (f.size > MAX_UPLOAD_BYTES) {
        setQueue((prev) => [
          { id, name: f.name, size: f.size, sha256: null, stage: 'failed', reason: 'tooLarge' },
          ...prev,
        ])
        continue
      }
      setQueue((prev) => [{ id, name: f.name, size: f.size, sha256: null, stage: 'staged' }, ...prev])
      processFile(f, id)
    }
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    const dropped = e.dataTransfer?.files
    if (dropped?.length) enqueue(dropped)
  }

  return (
    <div className="grid grid-cols-12 gap-6 max-lg:gap-5">
      <div className="col-span-12">
        {/* drop zone — crisp, instant */}
        <div
          role="button"
          tabIndex={0}
          aria-label={t('dropHere')}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className="flex flex-col items-center justify-center gap-2 rounded-[20px] py-12 px-6 cursor-pointer transition-[background-color,border-color,transform] duration-[var(--dur-fast)] text-center"
          style={{
            border: dragOver ? '2px solid var(--accent)' : '2px dashed var(--line)',
            background: dragOver ? 'var(--accent-soft)' : 'var(--card-sunken)',
            transform: dragOver ? 'scale(1.01)' : 'scale(1)',
            transitionTimingFunction: 'var(--ease)',
          }}
        >
          <UploadCloud size={28} strokeWidth={1.5} style={{ color: dragOver ? 'var(--accent)' : 'var(--ink-3)' }} />
          <p className="text-[15px] font-semibold text-ink">{t('dropHere')}</p>
          <p className="text-[12.5px] text-ink-3">{t('dropSub')}</p>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            aria-hidden
            tabIndex={-1}
            onChange={(e) => {
              if (e.target.files?.length) enqueue(e.target.files)
              e.target.value = ''
            }}
          />
        </div>
      </div>

      {queue.length > 0 && (
        <div className="col-span-12 flex flex-col gap-2.5">
          {queue.map((item) => (
            <UploadRow key={item.id} t={t} item={item} />
          ))}
        </div>
      )}

      <div className="col-span-12">
        <Card className="p-5">
          <CardTitle>{t('recentUploads')}</CardTitle>
          {filesApi.loading ? (
            <div className="flex flex-col gap-2 animate-pulse" aria-busy="true">
              {[0, 1, 2].map((i) => <div key={i} className="h-9 skeleton rounded-[9px]" />)}
            </div>
          ) : filesApi.error ? (
            <ErrorState t={t} kind={filesApi.error} onRetry={filesApi.retry} />
          ) : recent.length === 0 ? (
            <EmptyState icon={UploadCloud} title={t('emptyNoUploads')} hint={t('emptyNoUploadsHint')} />
          ) : (
            <div className="flex flex-col">
              {recent.map((f) => (
                <div key={f.id} className="flex items-center gap-3 py-2.5 border-b border-line last:border-b-0">
                  <FileText size={15} strokeWidth={1.5} className="text-ink-3 shrink-0" />
                  <span className="text-[13.5px] font-medium text-ink truncate flex-1 min-w-0">{f.name}</span>
                  <span className="text-[12.5px] text-ink-3 whitespace-nowrap max-md:hidden" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtBytes(f.size)}</span>
                  <span className="text-[12.5px] text-ink-3 whitespace-nowrap max-md:hidden">{f.uploader}</span>
                  <span className="text-[12.5px] text-ink-3 whitespace-nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtRelative(t, f.modified, now)}</span>
                  <span className="ml-2 shrink-0">
                    <Chip tone="ok">{t('encServer')}</Chip>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
