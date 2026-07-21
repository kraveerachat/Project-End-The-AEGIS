import { SearchX } from 'lucide-react'

export function Ping({ tone = 'ok' }) {
  const cls = tone === 'ok' ? 'png' : tone === 'amb' ? 'png amb' : 'png down'
  return (
    <span className={cls} aria-hidden="true">
      <i className="ring" /><i className="core" />
    </span>
  )
}

export function BBox({ kind, label, top, left, width, height }) {
  return (
    <div className={`bbox ${kind}`} style={{ top, left, width, height }}>
      <span className="c tl" /><span className="c tr" /><span className="c bl" /><span className="c br" />
      {label && <span className="bblab"><span>{label}</span></span>}
    </div>
  )
}

export function TBox({ kind, top, left, width, height }) {
  return <div className={`tbox ${kind}`} style={{ top, left, width, height }} />
}

export function FeedChrome() {
  return <div className="grid2" aria-hidden="true" />
}

export function EmptyState({ icon: Icon = SearchX, title, hint, action }) {
  return (
    <div className="empty" role="status">
      <Icon aria-hidden="true" />
      <div className="empty-t">{title}</div>
      {hint && <p className="empty-s">{hint}</p>}
      {action}
    </div>
  )
}

export function StaleBadge({ red = false, label = 'Stale' }) {
  return <span className={red ? 'stale red' : 'stale'}>{label}</span>
}
