import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import LiveFeed from './LiveFeed.jsx'
import { cameraHeartbeat, cameraStatus } from '../lib/liveCamera.js'
import './CameraSelector.css'

// Paint the selected player's decoded frame locally; never open a second
// MJPEG connection for its thumbnail or persist camera pixels anywhere.
function SelectedPreview({ sourceRef, camera }) {
  const canvasRef = useRef(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas.getContext('2d')
    if (!context) return
    const paint = () => {
      context.clearRect(0, 0, canvas.width, canvas.height)
      const image = sourceRef.current?.querySelector('img.feedimg')
      if (!image?.getAttribute('src') || !image.naturalWidth || !image.naturalHeight) return
      const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight)
      const width = image.naturalWidth * scale
      const height = image.naturalHeight * scale
      try {
        context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
      } catch {
        // The source can disappear during a camera change or reconnect.
      }
    }
    paint()
    const timer = setInterval(paint, 100)
    return () => { clearInterval(timer); context.clearRect(0, 0, canvas.width, canvas.height) }
  }, [sourceRef, camera.id])
  return <canvas ref={canvasRef} width={320} height={180} role="img"
    aria-label={`Live preview — ${camera.id} ${camera.name}`} />
}

function CameraCard({ camera, selected, heartbeat, streamState, sourceRef, onSelect }) {
  const [previewState, setPreviewState] = useState(null)
  const hasStream = Boolean(heartbeat?.hasStream)
  useLayoutEffect(() => { setPreviewState(null) }, [selected, hasStream])
  const status = cameraStatus(heartbeat, selected ? streamState : previewState?.state)
  const waiting = status === 'Online' ? 'Connecting' : status
  return (
    <button type="button" className="camera-option"
      aria-pressed={selected} aria-label={`View ${camera.id} — ${camera.name}`}
      onClick={() => onSelect(camera.id)}>
      <span className="camera-preview">
        {hasStream && (selected
          ? streamState === 'live' && <SelectedPreview sourceRef={sourceRef} camera={camera} />
          : <LiveFeed cameraId={camera.id} cameraName={camera.name} hasStream compact
              onStateChange={setPreviewState} />)}
        {status !== 'Live' && <span className="camera-preview-message">{waiting}</span>}
      </span>
      <span className="camera-option-top">
        <span className="camera-option-id">{camera.id}</span>
        <span className={`camera-option-status camera-option-status--${status.toLowerCase()}`}>
          <span aria-hidden="true" />{status}
        </span>
      </span>
      <span className="camera-option-name">{camera.name}</span>
      <span className="camera-option-selection">
        {selected ? <><Check size={12} aria-hidden="true" /> Selected</> : 'Select camera'}
      </span>
    </button>
  )
}

// User-approved concurrent previews, bounded to the current three-camera page.
// Selection also determines the page, so the main camera always belongs to it.
export default function CameraSelector({ cameras, selectedId, link, streamState, sourceRef, onSelect }) {
  const start = Math.floor(Math.max(0, cameras.findIndex(camera => camera.id === selectedId)) / 3) * 3
  const visible = cameras.slice(start, start + 3)
  return (
    <section className="camera-selector" aria-labelledby="camera-selector-heading">
      <div className="camera-selector-heading">
        <h2 id="camera-selector-heading">Cameras <span>({cameras.length})</span></h2>
        <span>Live previews · Choose a camera to view</span>
      </div>
      <div className="camera-options" role="group" aria-label="Assigned cameras">
        {visible.map(camera => <CameraCard key={camera.id} camera={camera}
          selected={camera.id === selectedId} heartbeat={cameraHeartbeat(link, camera.id)}
          streamState={streamState} sourceRef={sourceRef} onSelect={onSelect} />)}
      </div>
      {cameras.length > 3 && <nav className="camera-pages" aria-label="Camera pages">
        <button type="button" disabled={start === 0} aria-label="Previous cameras"
          onClick={() => onSelect(cameras[start - 3].id)}><ChevronLeft size={16} aria-hidden="true" /> Previous</button>
        <span>{start + 1}–{Math.min(start + 3, cameras.length)} of {cameras.length}</span>
        <button type="button" disabled={start + 3 >= cameras.length} aria-label="Next cameras"
          onClick={() => onSelect(cameras[start + 3].id)}>Next <ChevronRight size={16} aria-hidden="true" /></button>
      </nav>}
    </section>
  )
}
