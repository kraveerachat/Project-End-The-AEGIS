import { Check } from 'lucide-react'
import { cameraHeartbeat, cameraStatus } from '../lib/liveCamera.js'
import './CameraSelector.css'

// Metadata only: cards must never mount LiveFeed or create viewer demand.
export default function CameraSelector({ cameras, selectedId, link, streamState, onSelect }) {
  return (
    <section className="camera-selector" aria-labelledby="camera-selector-heading">
      <div className="camera-selector-heading">
        <h2 id="camera-selector-heading">Cameras <span>({cameras.length})</span></h2>
        <span>Choose a camera to view</span>
      </div>
      <div className="camera-options" role="group" aria-label="Assigned cameras">
        {cameras.map((camera) => {
          const selected = camera.id === selectedId
          const status = cameraStatus(cameraHeartbeat(link, camera.id), selected ? streamState : null)
          return (
            <button key={camera.id} type="button" className="camera-option"
              aria-pressed={selected} aria-label={`View ${camera.id} — ${camera.name}`}
              onClick={() => onSelect(camera.id)}>
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
        })}
      </div>
    </section>
  )
}
