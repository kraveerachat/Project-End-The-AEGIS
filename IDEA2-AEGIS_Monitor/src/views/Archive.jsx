import { useMemo, useState } from 'react'
import { Download, Play, RefreshCw, SearchX, ServerOff } from 'lucide-react'
import { fmtHM, fmtTime } from '../data.js'
import { EmptyState, FeedChrome } from '../components/ui.jsx'
import { useApi } from '../lib/hooks.js'
import { getViewState, VIEW_STATE } from '../lib/viewState.js'

function clipDurationSeconds(clip) {
  const value = Number(clip?.durationSec)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`
}

// Convert a clip's optional segment bar into reviewable time markers using the
// measured clip duration. Final logout/session clips can be shorter than 5 min.
function segMarkers(clip) {
  const out = []
  const totalSec = clipDurationSeconds(clip)
  if (totalSec <= 0) return out
  let cum = 0
  for (const s of clip.segs ?? []) {
    if (s.k === 'warn') {
      const a = clip.start + (cum / 100) * totalSec * 1000
      const b = clip.start + ((cum + s.w) / 100) * totalSec * 1000
      out.push({ from: a, to: b })
    }
    cum += s.w
  }
  return out
}

// ⚠️ `cameras` มาจาก GET /api/cameras — ขอบเขตถูกกรองผ่าน camera_assignment
// "ฝั่งเซิร์ฟเวอร์" แล้ว ตัวกรองกล้องใน UI เป็นความสะดวก ไม่ใช่ control:
// รายการคลิปถูกจำกัดตามขอบเขตนี้เสมอ ไม่ว่า client จะเลือกอะไร
//
// ⚠️ Phase 2: คลิปมาจาก GET /api/clips เท่านั้น (server ผูก camName ให้แล้ว) —
// ไม่มีการ generate mock ฝั่ง client อีกต่อไป
export default function Archive({ cameras = [], arcCam, setArcCam, arcResult, setArcResult }) {
  const [openClip, setOpenClip] = useState(null)
  const clipsApi = useApi('/api/clips', { refreshMs: 30_000 })
  const visibleIds = useMemo(() => new Set(cameras.map((c) => c.id)), [cameras])

  const allClips = clipsApi.data?.clips ?? []
  const state = getViewState(clipsApi, (data) => (data?.clips ?? []).length === 0)

  const clips = useMemo(() => {
    let list = allClips.filter((c) => visibleIds.has(c.cam))
    if (arcCam !== 'all' && visibleIds.has(arcCam)) list = list.filter((c) => c.cam === arcCam)
    if (arcResult !== 'all') {
      list = list.filter((c) => (arcResult === 'auth' ? c.kind === 'auth' : c.kind === 'unknown'))
    }
    return list
  }, [allClips, arcCam, arcResult, visibleIds])

  const reset = () => { setArcCam('all'); setArcResult('all') }

  if (state === VIEW_STATE.ERROR) {
    return (
      <EmptyState icon={ServerOff} title="Could not load archival footage"
        hint="The Monitor backend did not respond. Check the server, then retry."
        action={<button type="button" className="ackbtn" onClick={clipsApi.retry}><RefreshCw aria-hidden="true" size={13} style={{ marginRight: 6 }} />Retry</button>} />
    )
  }

  if (state === VIEW_STATE.LOADING) {
    return <EmptyState icon={ServerOff} title="Loading archival footage" hint="Retrieving the current retention window." />
  }

  return (
    <>
      <div className="pagehead">
        <div>
          <h1 className="h1">Archival footage</h1>
          <p className="sub">Continuous recording rolls into 5-minute clips. Logout/session end preserves the final partial clip at its actual duration; verified clips are archived to the NAS.</p>
        </div>
      </div>
      <div className="filterbar">
        <label className="flbl" htmlFor="arc-cam">Camera</label>
        <select id="arc-cam" className="fsel" value={arcCam} onChange={(e) => setArcCam(e.target.value)}>
          <option value="all">{cameras.length === 1 ? `${cameras[0].id} · ${cameras[0].name}` : 'All cameras'}</option>
          {cameras.length > 1 && cameras.map((c) => <option key={c.id} value={c.id}>{c.id} · {c.name}</option>)}
        </select>
        <label className="flbl" htmlFor="arc-res">Result</label>
        <select id="arc-res" className="fsel" value={arcResult} onChange={(e) => setArcResult(e.target.value)}>
          <option value="all">All results</option>
          <option value="auth">Authorized only</option>
          <option value="unknown">Unknown present</option>
        </select>
      </div>
      {state === VIEW_STATE.SUCCESS_EMPTY || clips.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="No clips match these filters"
          hint="Nothing in the current retention window matches this camera and result combination."
          action={<button type="button" className="ackbtn" onClick={reset}>Reset filters</button>}
        />
      ) : (
        <div className="clipgrid">
          {clips.map((cl, i) => {
            const open = openClip === cl.id
            const markers = segMarkers(cl)
            const durationSec = clipDurationSeconds(cl)
            const videoUrl = `${import.meta.env.BASE_URL}api/clips/${cl.id}/video`
            const downloadUrl = `${import.meta.env.BASE_URL}api/clips/${cl.id}/download`
            return (
              <article key={cl.id} className="clip rise" style={{ '--i': Math.min(i, 8) }}>
                <button
                  type="button"
                  className="clipthumb"
                  aria-expanded={open}
                  aria-label={`${cl.cam} clip from ${fmtHM(cl.start)} — ${open ? 'hide' : 'show'} segment review`}
                  onClick={() => setOpenClip(open ? null : cl.id)}
                >
                  <FeedChrome />
                  <span className="clipid mono">{cl.cam}</span>
                  {cl.live
                    ? <span className="clipdur mono reclive"><span className="rec" />{formatDuration(durationSec)}</span>
                    : <span className="clipdur mono">{formatDuration(durationSec)}</span>}
                  <span className="play" aria-hidden="true"><Play /></span>
                  <span className="segbar" aria-hidden="true">
                    {(cl.segs ?? []).map((sg, j) => <span key={j} className={`seg ${sg.k}`} style={{ width: sg.w + '%' }} />)}
                  </span>
                </button>
                <div className="clipbody">
                  <div className="cliprow">
                    <div>
                      <div className="clipstart mono">{fmtHM(cl.start)} – {fmtHM(cl.start + durationSec * 1000)} · {formatDuration(durationSec)}</div>
                      <div className="clipcam">{cl.camName ?? cl.cam}</div>
                    </div>
                    <a className="ackbtn" href={downloadUrl} download aria-label={`Download ${cl.cam} clip from ${fmtHM(cl.start)}`}>
                      <Download aria-hidden="true" size={13} style={{ marginRight: 6 }} />Download
                    </a>
                  </div>
                  <div className="tags">
                    {cl.kind === 'auth' ? (
                      <span className="tag auth">Authorized only</span>
                    ) : (
                      <>
                        <span className="tag auth">Authorized</span>
                        <span className="tag unk">Unknown</span>
                      </>
                    )}
                  </div>
                </div>
                {open && (
                  <div className="clipdetail">
                    {/* Finalized clips are read by Monitor through its read-only
                        NAS mount. The browser never receives a filesystem path;
                        same-origin /api/clips/:id/video enforces session + camera
                        scope and preserves the /monitor/ gateway prefix. */}
                    <video
                      key={cl.id}
                      className="clipvideo"
                      src={videoUrl}
                      controls
                      preload="metadata"
                      style={{ width: '100%', borderRadius: 8, marginBottom: 10, background: '#000' }}
                    />
                    {markers.length === 0 ? (
                      <div className="mkrow"><span className="mkdot" />No flagged windows — authorized activity only.</div>
                    ) : (
                      markers.map((m, j) => (
                        <div key={j} className="mkrow warn">
                          <span className="mkdot" />
                          <span className="mono">{fmtTime(m.from)} – {fmtTime(m.to)}</span>
                          <span>Unknown present · flagged</span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </article>
            )
          })}
        </div>
      )}
    </>
  )
}