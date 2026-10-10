import { useMemo } from 'react'
import { Download, RefreshCw, SearchX, ServerOff } from 'lucide-react'
import { EmptyState } from '../components/ui.jsx'
import { useApi } from '../lib/hooks.js'
import { getViewState, VIEW_STATE } from '../lib/viewState.js'
import { useLocale } from '../lib/Locale.jsx'

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

const THAILAND_TIME_ZONE = 'Asia/Bangkok'
const archiveFormats = Object.fromEntries(Object.entries({
  th: 'th-TH-u-ca-buddhist-nu-latn', en: 'en-GB', zh: 'zh-CN',
}).map(([lang, locale]) => [lang, {
  date: new Intl.DateTimeFormat(locale, {
    timeZone: THAILAND_TIME_ZONE, day: 'numeric', month: 'short', year: 'numeric',
  }),
  time: new Intl.DateTimeFormat(locale, {
    timeZone: THAILAND_TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }),
}]))

function formatThailandWindow(startMs, durationSeconds, lang) {
  const { date, time } = archiveFormats[lang] ?? archiveFormats.en
  const start = Number(startMs)
  const end = start + clipDurationSeconds({ durationSec: durationSeconds }) * 1000
  const startDate = date.format(start)
  const endDate = date.format(end)
  const startTime = time.format(start)
  const endTime = time.format(end)
  return startDate === endDate
    ? `${startDate} · ${startTime}–${endTime}`
    : `${startDate} ${startTime} – ${endDate} ${endTime}`
}

// ⚠️ `cameras` มาจาก GET /api/cameras — ขอบเขตถูกกรองผ่าน camera_assignment
// "ฝั่งเซิร์ฟเวอร์" แล้ว ตัวกรองกล้องใน UI เป็นความสะดวก ไม่ใช่ control:
// รายการคลิปถูกจำกัดตามขอบเขตนี้เสมอ ไม่ว่า client จะเลือกอะไร
//
// ⚠️ Phase 2: คลิปมาจาก GET /api/clips เท่านั้น (server ผูก camName ให้แล้ว) —
// ไม่มีการ generate mock ฝั่ง client อีกต่อไป
export default function Archive({ cameras = [], arcCam, setArcCam, arcResult, setArcResult }) {
  const { t, lang } = useLocale()
  const clipsApi = useApi('/api/clips', { refreshMs: 30_000 })
  const visibleIds = useMemo(() => new Set(cameras.map((c) => c.id)), [cameras])

  const allClips = clipsApi.data?.clips ?? []
  const state = getViewState(clipsApi, (data) => (data?.clips ?? []).length === 0)

  const clips = useMemo(() => {
    let list = allClips.filter((c) => visibleIds.has(c.cam))
    if (arcCam !== 'all' && visibleIds.has(arcCam)) list = list.filter((c) => c.cam === arcCam)
    if (arcResult !== 'all') {
      list = list.filter((c) => c.kind === arcResult)
    }
    return list
  }, [allClips, arcCam, arcResult, visibleIds])

  const reset = () => { setArcCam('all'); setArcResult('all') }

  if (state === VIEW_STATE.ERROR) {
    return (
      <EmptyState icon={ServerOff} title={t('Could not load archival footage')}
        hint={t('The Monitor backend did not respond. Check the server, then retry.')}
        action={<button type="button" className="ackbtn" onClick={clipsApi.retry}><RefreshCw aria-hidden="true" size={13} style={{ marginRight: 6 }} />{t('Retry')}</button>} />
    )
  }

  if (state === VIEW_STATE.LOADING) {
    return <EmptyState icon={ServerOff} title={t('Loading archival footage')} hint={t('Retrieving the current retention window.')} />
  }

  return (
    <>
      <div className="pagehead">
        <div>
          <h1 className="h1">{t('Archival footage')}</h1>
          <p className="sub">{t('Continuous recording rolls into 5-minute clips. Logout/session end preserves the final partial clip at its actual duration; verified clips are archived to the NAS.')}</p>
        </div>
      </div>
      <div className="filterbar">
        <label className="flbl" htmlFor="arc-cam">{t('Camera')}</label>
        <select id="arc-cam" className="fsel" value={arcCam} onChange={(e) => setArcCam(e.target.value)}>
          <option value="all">{cameras.length === 1 ? `${cameras[0].id} · ${cameras[0].name}` : t('All cameras')}</option>
          {cameras.length > 1 && cameras.map((c) => <option key={c.id} value={c.id}>{c.id} · {c.name}</option>)}
        </select>
        <label className="flbl" htmlFor="arc-res">{t('Result')}</label>
        <select id="arc-res" className="fsel" value={arcResult} onChange={(e) => setArcResult(e.target.value)}>
          <option value="all">{t('All results')}</option>
          <option value="auth">{t('Authorized only')}</option>
          <option value="unknown">{t('Unknown present')}</option>
        </select>
      </div>
      {state === VIEW_STATE.SUCCESS_EMPTY || clips.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title={t('No clips match these filters')}
          hint={t('Nothing in the current retention window matches this camera and result combination.')}
          action={<button type="button" className="ackbtn" onClick={reset}>{t('Reset filters')}</button>}
        />
      ) : (
        <div className="clipgrid">
          {clips.map((cl, i) => {
            const durationSec = clipDurationSeconds(cl)
            const window = formatThailandWindow(cl.start, durationSec, lang)
            const videoUrl = `${import.meta.env.BASE_URL}api/clips/${cl.id}/video`
            const downloadUrl = `${import.meta.env.BASE_URL}api/clips/${cl.id}/download`
            return (
              <article key={cl.id} className="clip rise" style={{ '--i': Math.min(i, 8) }}>
                <div className="clipthumb">
                  {/* Same-origin video route enforces session, camera scope and
                      verified-NAS storage without exposing a filesystem path. */}
                  <video
                    className="clipvideo"
                    src={videoUrl}
                    aria-label={t('{camera} recording · {window}', { camera: cl.cam, window })}
                    controls
                    preload="metadata"
                  />
                  <span className="clipid mono">{cl.cam}</span>
                  {cl.live
                    ? <span className="clipdur mono reclive"><span className="rec" />{formatDuration(durationSec)}</span>
                    : <span className="clipdur mono">{formatDuration(durationSec)}</span>}
                </div>
                <div className="clipbody">
                  <div className="cliprow">
                    <div>
                      <div className="clipstart mono">{window} · {formatDuration(durationSec)}</div>
                      <div className="clipcam">
                        {cl.cam} · {cl.camName ?? cl.cam}{cl.nodeId ? ` · ${cl.nodeId}` : ''}
                      </div>
                    </div>
                    <a className="ackbtn" href={downloadUrl} download aria-label={t('Download {camera} clip · {window}', { camera: cl.cam, window })}>
                      <Download aria-hidden="true" size={13} style={{ marginRight: 6 }} />{t('Download')}
                    </a>
                  </div>
                  <div className="tags">
                    {cl.kind === 'unavailable' ? (
                      <span className="tag">{t('Detection result unavailable')}</span>
                    ) : cl.kind === 'auth' ? (
                      <span className="tag auth">{t('Authorized only')}</span>
                    ) : (
                      <>
                        {cl.hasAuthorized ? <span className="tag auth">{t('Authorized')}</span> : null}
                        <span className="tag unk">{t('Unknown present')}</span>
                      </>
                    )}
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </>
  )
}
