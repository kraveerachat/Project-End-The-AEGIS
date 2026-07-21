import { RefreshCw, ServerOff } from 'lucide-react'
import { ini } from '../data.js'
import { EmptyState, FeedChrome, StaleBadge } from '../components/ui.jsx'
import { useApi } from '../lib/hooks.js'

// ⚠️ Phase 2: SOC-only view — self-fetches GET /api/nodes (cameras + assignments +
// operators + link, all pre-scoped/joined server-side). No props from App.jsx;
// this view owns its own data lifecycle like Live/Archive/Settings do.
export default function Nodes() {
  const api = useApi('/api/nodes', { refreshMs: 30_000 })

  if (api.loading) {
    return (
      <>
        <PageHead />
        <div className="nodegrid" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <article key={i} className="node glass rise" style={{ opacity: 0.45 }}>
              <div className="nodefeed"><FeedChrome /></div>
            </article>
          ))}
        </div>
      </>
    )
  }

  if (api.error) {
    return (
      <>
        <PageHead />
        <EmptyState
          icon={ServerOff}
          title="Could not load nodes"
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

  const cameras = api.data?.cameras ?? []
  const operators = api.data?.operators ?? []
  const assignments = api.data?.assignments ?? {}
  const link = api.data?.link ?? { status: 'lost' }

  const resolve = (camId) => {
    const v = assignments[camId]
    if (v === 'SOC') return { name: 'SOC-Team', active: true }
    if (!v) return null
    const op = operators.find((o) => o.id === v)
    return op ? { name: op.name, active: op.active } : null
  }

  if (cameras.length === 0) {
    return (
      <>
        <PageHead link={link} />
        <EmptyState
          icon={ServerOff}
          title="No cameras registered"
          hint="No camera nodes are connected to this deployment yet."
        />
      </>
    )
  }

  return (
    <>
      <PageHead link={link} />
      <div className="nodegrid">
        {cameras.map((c, i) => {
          const op = resolve(c.id)
          return (
            <article key={c.id} className="node glass rise" style={{ '--i': Math.min(i, 8) }}>
              <div className="nodefeed">
                <FeedChrome />
                {c.online ? (
                  <>
                    <span className="clipid mono">{c.id}</span>
                    <span className="sflive"><span className="rec" />LIVE</span>
                  </>
                ) : (
                  <div className="nodeoff">
                    <span className="offbadge">Signal lost</span>
                    <span>Camera offline</span>
                  </div>
                )}
              </div>
              <div className="nodebody">
                <div className="nodename">
                  {c.name}
                  {c.online && <span className="recwrap"><span className="rec" />REC</span>}
                </div>
                <div className="nodefields">
                  <div className="nfield"><span className="nflab">Camera ID</span><span className="nfval mono">{c.id}</span></div>
                  <div className="nfield"><span className="nflab">Zone</span><span className="nfval">{c.zone}</span></div>
                  <div className="nfield"><span className="nflab">Resolution</span><span className="nfval mono">{c.res}</span></div>
                  <div className="nfield">
                    <span className="nflab">Assigned to</span>
                    {op ? (
                      <span
                        className={op.active ? 'assigned' : 'assigned un'}
                        title={op.active ? undefined : 'Suspended — alerts route to SOC-Team'}
                      >
                        <span className="av" aria-hidden="true">{ini(op.name)}</span>
                        {op.name}{!op.active && ' · suspended'}
                      </span>
                    ) : (
                      <span className="assigned un">Unassigned</span>
                    )}
                  </div>
                  <div className="nfield">
                    <span className="nflab">Status</span>
                    <span className={c.online ? 'statustag on' : 'statustag off'}>
                      <span className={c.online ? 'tdot on' : 'tdot off'} />
                      {c.online ? 'Online' : 'Offline'}
                    </span>
                  </div>
                </div>
              </div>
            </article>
          )
        })}
      </div>
    </>
  )
}

function PageHead({ link }) {
  return (
    <div className="pagehead">
      <div>
        <h1 className="h1">Nodes &amp; routing</h1>
        <p className="sub">Connected cameras and their responsible operator, per central RBAC assignment.</p>
      </div>
      {link && link.status !== 'online' && <StaleBadge red={link.status === 'lost'} label="Status may be stale" />}
    </div>
  )
}
