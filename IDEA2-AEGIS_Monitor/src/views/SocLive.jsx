import { useLocale } from '../lib/Locale.jsx'
import { useRef, useState } from 'react'
import { ListTree, Maximize2, ShieldCheck } from 'lucide-react'
import { EmptyState, FeedChrome } from '../components/ui.jsx'
import LiveFeed from '../components/LiveFeed.jsx'
import LatestDetectionPeople from '../components/LatestDetectionPeople.jsx'
import { eventText, fmtDate, fmtTime, hasUnk, ini } from '../data.js'
import { useApi } from '../lib/hooks.js'

function SelectedPassiveView({ view, now, views, onSelect }) {
  const { t, lang } = useLocale()
  const heroRef = useRef(null)
  // A component keyed by opaque viewId prevents one Node's old detections from
  // rendering even briefly beside another Node's same-alias video.
  const detectionsApi = useApi(`/api/live/active-views/${encodeURIComponent(view.viewId)}/detections`,
    { refreshMs: 5000 })
  const detections = detectionsApi.data?.detections ?? []
  const heroFrame = detections[0] ?? null
  const grant = heroFrame && !hasUnk(heroFrame) ? heroFrame : null
  const grantPerson = grant?.people?.[0]
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen()
    else heroRef.current?.requestFullscreen?.()
  }

  return <div className="canvas">
    <div className="canvasL">
      <div className="hero" ref={heroRef}>
        <LiveFeed cameraId={view.cameraId} cameraName={view.cameraName} hasStream
          streamPath={`/api/live/active-views/${encodeURIComponent(view.viewId)}/stream`} />
        <FeedChrome /><div className="scanline" /><div className="vign" />
        <span className="corner tl" /><span className="corner tr" />
        <span className="corner bl" /><span className="corner br" />
        <div className="herotop absolute top-4 left-4 flex items-center gap-2 z-10">
          <span className="htag manual">{t("PASSIVE LIVE")}</span>
          <span className="hchip mono text-white font-mono text-xs font-semibold bg-black/40 px-2 py-1 rounded backdrop-blur-sm">
            {view.cameraId} · {view.cameraName} · {view.nodeId}
          </span>
        </div>
        <div className="heroright absolute top-4 right-4 flex items-center gap-2 z-10">
          <button type="button" className="herobtn" onClick={toggleFullscreen} aria-label={t("Toggle fullscreen feed")}>
            <Maximize2 aria-hidden="true" />
          </button>
        </div>
        {/* Genuine face boxes/labels remain in the unchanged Engine frame. */}
        <span className="herots mono">{fmtDate(now, lang)} {fmtTime(now)}</span>
      </div>
      <section className="camera-selector" aria-labelledby="active-view-heading">
        <div className="camera-selector-heading">
          <h2 id="active-view-heading">{t("Active Operator views")} <span>({views.length})</span></h2>
          <span>{t("Passive observation · camera demand belongs to Operators")}</span>
        </div>
        <div className="camera-options" role="group" aria-label={t("Active Operator views")}>
          {views.map(candidate => <button type="button" className="camera-option"
            key={candidate.viewId} aria-pressed={candidate.viewId === view.viewId}
            aria-label={t('View {id} — {name} · {node}', { id: candidate.cameraId, name: candidate.cameraName, node: candidate.nodeId })}
            onClick={() => onSelect(candidate.viewId)}>
            <span className="camera-option-top">
              <span className="camera-option-id">{candidate.cameraId}</span>
              <span className="camera-option-status camera-option-status--live"><span aria-hidden="true" />{t("Live")}</span>
            </span>
            <span className="camera-option-name">{candidate.cameraName} · {candidate.nodeId}</span>
            <span className="camera-option-selection">
              {candidate.viewId === view.viewId ? t("Selected") : t("Select view")}
            </span>
          </button>)}
        </div>
      </section>
    </div>
    <div className="canvasR">
      <section className="panel glass acpanel">
        <div className="ptitle"><span className="fx ac gap9"><ShieldCheck aria-hidden="true" />{t("Access control · result")}</span></div>
        <p className="live-camera-context">{view.cameraId} · {view.nodeId} · {t('Selected view only')}</p>
        {grantPerson ? <div key={grant.id}>
          <div className="acbig"><span className="accheck" aria-hidden="true">✓</span> {t("Access authorized")}</div>
          <div className="acid"><div className="acav" aria-hidden="true">{ini(grantPerson.name)}</div>
            <div><div className="acname">{grantPerson.name}</div><div className="acrole">{t("Authorized · Staff")}</div></div>
          </div>
          {Number.isFinite(grantPerson.conf) && grantPerson.conf >= 0 && grantPerson.conf <= 100 &&
            <div className="acstats"><div className="acstat">
              <div className="acslab">{t("Match score · latest detection")}</div>
              <div className="acsval mono teal">{grantPerson.conf}%</div>
            </div></div>}
          <p className="sub">{fmtDate(grant.at, lang)} {fmtTime(grant.at)}</p>
        </div> : <p className="sub" style={{ margin: 0 }}>
          {heroFrame ? t("No authorization in the latest detection.") : t("No recent detection for this live view")}
        </p>}
        <LatestDetectionPeople people={grantPerson ? heroFrame.people.slice(1) : heroFrame?.people} />
      </section>
      <section className="panel glass streampanel">
        <div className="ptitle"><span className="fx ac gap9"><ListTree aria-hidden="true" />{t("Event stream")}</span></div>
        <p className="live-camera-context">{view.cameraId} · {view.nodeId} · {t('Selected view only')}</p>
        <div className="streamlist">
          {!detections.length && <p className="sub">{t("No recent detection for this live view")}</p>}
          {detections.map(event => <div key={event.id} className="srow live-event-row">
            <span className="sts mono">{fmtTime(event.at)}</span>
            <span className={`sdot ${hasUnk(event) ? 'warn' : 'ok'}`} aria-hidden="true" />
            <span className="stext">{eventText(event, lang)}</span>
          </div>)}
        </div>
      </section>
    </div>
  </div>
}

export default function SocLive({ now, activeViews, error }) {
  const { t, lang } = useLocale()
  const [selectedId, setSelectedId] = useState(null)
  if (error && activeViews === null) return <>
    <div className="pagehead"><div><h1 className="h1">{t("Live canvas")}</h1></div></div>
    <EmptyState title={t("Active view registry unavailable")} hint={t("Live sources cannot be verified right now.")} />
  </>
  if (activeViews === null) return <div className="pagehead"><div>
    <h1 className="h1">{t("Live canvas")}</h1><p className="sub">{t("Finding active Operator views...")}</p>
  </div></div>
  const view = activeViews.find(candidate => candidate.viewId === selectedId) ?? activeViews[0]
  if (!view) return <>
    <div className="pagehead"><div><h1 className="h1">{t("Live canvas")}</h1>
      <p className="sub">{t("Passive observation begins only when an authorized Operator is live.")}</p></div></div>
    <EmptyState title={t("No active Operator live views")}
      hint={t("An Operator must start an authorized Live viewer before SOC can observe it.")} />
  </>
  return <>
    <div className="pagehead"><div><h1 className="h1">{t("Live canvas")}</h1>
      <p className="sub">{t('Passive observation')} · {view.cameraId} · {view.nodeId}</p></div></div>
    <SelectedPassiveView key={view.viewId} view={view} now={now} views={activeViews} onSelect={setSelectedId} />
  </>
}
