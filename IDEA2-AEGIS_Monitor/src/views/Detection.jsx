import { useMemo } from 'react'
import { RefreshCw, SearchX, ServerOff } from 'lucide-react'
import { fmtTime, hasUnk, ini, isTail } from '../data.js'
import { EmptyState } from '../components/ui.jsx'

const NAS_PENDING_MS = 90_000

/* ⚠️ Phase 2: detections มาจาก GET /api/detections — กรองตาม camera_assignment
   ฝั่งเซิร์ฟเวอร์แล้ว; แต่ละ frame มี people[] หลายคน = tailgating มองเห็นได้
   แต่ละคนใน frame เดียวกัน render เป็น "แถวของตัวเอง" แยกกัน (ไม่ใช่ chip ซ้อนในแถว
   เดียว) — ผู้ตรวจสอบเห็นแต่ละบุคคลชัดเจนเป็นรายการเดี่ยว พร้อม badge บอกว่ามาจาก
   frame ที่มีคนหลายคน (tailgating) หรือไม่ */
export default function Detection({ now, link, detections, api, cameras = [], detCam, setDetCam, detResult, setDetResult }) {
  const frames = useMemo(() => {
    let list = detections
    if (detCam !== 'all') list = list.filter((f) => f.cam === detCam)
    if (detResult !== 'all') {
      list = list.filter((f) => (detResult === 'auth' ? !hasUnk(f) : hasUnk(f)))
    }
    return list
  }, [detections, detCam, detResult])

  const reset = () => { setDetCam('all'); setDetResult('all') }

  if (api?.error) {
    return (
      <>
        <div className="pagehead">
          <div>
            <h1 className="h1">AI detection stream</h1>
            <p className="sub">Per-frame recognition record · multi-subject frames reveal tailgating. Identity is name only.</p>
          </div>
        </div>
        <EmptyState
          icon={ServerOff}
          title="Could not load the detection stream"
          hint="The Monitor backend did not respond. Check the server, then retry."
          action={
            <button type="button" className="ackbtn" onClick={api.retry}>
              <RefreshCw aria-hidden="true" size={13} style={{ marginRight: 6 }} />Retry
            </button>
          }
        />
      </>
    )
  }

  return (
    <>
      <div className="pagehead">
        <div>
          <h1 className="h1">AI detection stream</h1>
          <p className="sub">Per-frame recognition record · multi-subject frames reveal tailgating. Identity is name only.</p>
        </div>
      </div>
      <div className="filterbar">
        <label className="flbl" htmlFor="det-cam">Camera</label>
        <select id="det-cam" className="fsel" value={detCam} onChange={(e) => setDetCam(e.target.value)}>
          <option value="all">All cameras</option>
          {cameras.map((c) => <option key={c.id} value={c.id}>{c.id} · {c.name}</option>)}
        </select>
        <label className="flbl" htmlFor="det-res">Result</label>
        <select id="det-res" className="fsel" value={detResult} onChange={(e) => setDetResult(e.target.value)}>
          <option value="all">All results</option>
          <option value="auth">Authorized</option>
          <option value="unknown">Unknown present</option>
        </select>
      </div>
      {frames.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="No frames match these filters"
          hint="The recognition record for this window has no frames from this camera and result combination."
          action={<button type="button" className="ackbtn" onClick={reset}>Reset filters</button>}
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
                  <div className="dclab">{multi ? 'In frame' : 'Solo frame'}</div>
                </div>
                <div className={p.k === 'auth' ? 'entity auth' : 'entity unk'}>
                  <div className="eav" aria-hidden="true">{p.k === 'auth' ? ini(p.name) : '?'}</div>
                  <div>
                    <div className="ename">{p.k === 'auth' ? p.name : 'Unknown'}</div>
                    <div className="etag">
                      {p.k === 'auth' ? 'Authorized' : 'Unknown'}
                      <span className="econf mono"> · {p.conf}%</span>
                    </div>
                  </div>
                </div>
                {tail && <span className="tailbadge">Tailgating frame</span>}
                <div className="dnas">
                  <span className={pending ? 'nasstate pend' : 'nasstate ok'}>
                    {queued ? '⟳ queued' : pending ? '⟳ pending' : '✓ synced'}
                  </span>
                  <div className="naslab">NAS sync</div>
                </div>
              </article>
            ))
          })}
        </div>
      )}
    </>
  )
}
