import { Ping } from './ui.jsx'

const FOOT_TEXT = {
  online: { tone: 'ok', text: 'Edge AI node · online' },
  degraded: { tone: 'amb', text: 'Edge AI node · degraded link' },
  lost: { tone: 'down', text: 'Edge AI node · unreachable' },
}

export default function Footer({ linkStatus }) {
  const f = FOOT_TEXT[linkStatus]
  return (
    <footer className="foot">
      <Ping tone={f.tone} />
      <span className={linkStatus === 'lost' ? 'down-t' : undefined}>{f.text}</span>
      <span className="mono">192.168.1.42 · LAN</span>
      <span className="footv mono">v3.0-spatial</span>
    </footer>
  )
}
