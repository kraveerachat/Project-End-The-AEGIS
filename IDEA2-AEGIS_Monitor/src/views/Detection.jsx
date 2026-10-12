import { useMemo } from 'react'
import { RefreshCw, SearchX, ServerOff } from 'lucide-react'
import { fmtTime, hasUnk, ini, isTail } from '../data.js'
import { EmptyState } from '../components/ui.jsx'
import { getViewState, VIEW_STATE } from '../lib/viewState.js'
import { useLocale } from '../lib/Locale.jsx'

const NAS_PENDING_MS = 90_000

/* ⚠️ Phase 2: detections มาจาก GET /api/detections — กรองตาม camera_assignment
   ฝั่งเซิร์ฟเวอร์แล้ว; แต่ละ frame มี people[] หลายคน = tailgating มองเห็นได้
   แต่ละคนใน frame เดียวกัน render เป็น "แถวของตัวเอง" แยกกัน (ไม่ใช่ chip ซ้อนในแถว
   เดียว) — ผู้ตรวจสอบเห็นแต่ละบุคคลชัดเจนเป็นรายการเดี่ยว พร้อม badge บอกว่ามาจาก
   frame ที่มีคนหลายคน (tailgating) หรือไม่ */
export default function Detection({ now, link, detections, api, cameras = [], detCam, setDetCam, detResult, setDetResult }) {
  const { t } = useLocale()
  const state = getViewState(api, (data) => (data?.detections ?? []).length === 0)
  const frames = useMemo(() => {
    let list = detections
    if (detCam !== 'all') list = list.filter((f) => f.cam === detCam)
    if (detResult !== 'all') {
      list = list.filter((f) => (detResult === 'auth' ? !hasUnk(f) : hasUnk(f)))
    }
    return list
  }, [detections, detCam, detResult])

  const reset = () => { setDetCam('all'); setDetResult('all') }

  if (state === VIEW_STATE.ERROR) {
    return (
      <EmptyState icon={ServerOff} title={t('Could not load the detection stream')}
        hint={t('The Monitor backend did not respond. Check the server, then retry.')}
        action={<button type="button" className="ackbtn" onClick={api.retry}><RefreshCw aria-hidden="true" size={13} style={{ marginRight: 6 }} />{t('Retry')}</button>} />
    )
  }

  if (state === VIEW_STATE.LOADING) {
    return <EmptyState icon={ServerOff} title={t('Loading detection stream')} hint={t('Retrieving the current recognition record.')} />
  }

  return (
    <>
      <div className="pagehead">
        <div>
          <h1 className="h1">{t('AI detection stream')}</h1>
          <p className="sub">{t('Per-frame recognition record · multi-subject frames reveal tailgating. Identity is name only.')}</p>
        </div>
      </div>
      <div className="filterbar">
        <label className="flbl" htmlFor="det-cam">{t('Camera')}</label>
        <select id="det-cam" className="fsel" value={detCam} onChange={(e) => setDetCam(e.target.value)}>
          <option value="all">{t('All cameras')}</option>
          {cameras.map((c) => <option key={c.id} value={c.id}>{c.id} · {c.name}</option>)}
        </select>
        <label className="flbl" htmlFor="det-res">{t('Result')}</label>
        <select id="det-res" className="fsel" value={detResult} onChange={(e) => setDetResult(e.target.value)}>
          <option value="all">{t('All results')}</option>
          <option value="auth">{t('Authorized')}</option>
          <option value="unknown">{t('Unknown present')}</option>
        </select>
      </div>
      {state === VIEW_STATE.SUCCESS_EMPTY || frames.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title={t('No frames match these filters')}
          hint={t('The recognition record for this window has no frames from this camera and result combination.')}
          action={<button type="button" className="ackbtn" onClick={reset}>{t('Reset filters')}</button>}
        />
      ) : (
        <div className="dstream">
          {frames.flatMap((f, i) => {
            const multi = f.people.length > 1
            const tail = isTail(f)
            const pending = now - f.at < NAS_PENDING_MS
            const queued = pending && link.status !== 'online'
            return f.people.map((p, j) => (
              <article
                key={`${f.id}-${j}`}
                className={`${tail ? 'dcard glass tail' : 'dcard glass'} rise`}
                style={{ '--i': Math.min(i, 8) }}
              >
                <div className="dwhen">
                  <div className="dts mono">{fmtTime(f.at)}</div>
                  <div className="dcam mono">{f.cam}</div>
                </div>
                <div className="dcount">
                  <div className={multi ? 'dcnum multi' : 'dcnum'}>{multi ? `${j + 1}/${f.people.length}` : '1'}</div>
                  <div className="dclab">{multi ? t('In frame') : t('Solo frame')}</div>
                </div>
                <div className={p.k === 'auth' ? 'entity auth' : 'entity unk'}>
                  <div className="eav" aria-hidden="true">{p.k === 'auth' ? ini(p.name) : '?'}</div>
                  <div>
                    <div className="ename">{p.k === 'auth' ? p.name : t('Unknown')}</div>
                    <div className="etag">
                      {p.k === 'auth' ? t('Authorized') : t('Unknown')}
                      <span className="econf mono"> · {p.conf}%</span>
                    </div>
                  </div>
                </div>
                {tail && <span className="tailbadge">{t('Tailgating frame')}</span>}
                <div className="dnas">
                  <span className={pending ? 'nasstate pend' : 'nasstate ok'}>
                    {queued ? t('⟳ queued') : pending ? t('⟳ pending') : t('✓ synced')}
                  </span>
                  <div className="naslab">{t('NAS sync')}</div>
                </div>
              </article>
            ))
          })}
        </div>
      )}
    </>
  )
}
