import { Check, RefreshCw, Send, ShieldAlert, ShieldCheck } from 'lucide-react'
import { fmtHM } from '../data.js'
import { EmptyState, TBox } from '../components/ui.jsx'

/* ⚠️ Phase 2: alerts มาจาก GET /api/alerts (SOC-Responder เท่านั้น — requireRole
   ฝั่งเซิร์ฟเวอร์) · camName/route ถูกคำนวณฝั่งเซิร์ฟเวอร์จาก camera_assignment
   Acknowledge = POST จริง — การเขียนเดียวของ console นี้ (review-only) */
export default function Alerts({ alerts, ackAlert, api }) {
  if (api?.loading) {
    return (
      <>
        <PageHead unackedZero={false} />
        <div className="alertlist" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <article key={i} className="alert glass" style={{ opacity: 0.45 }}>
              <div className="asnap" aria-hidden="true"><div className="grid2" /></div>
              <div className="acol">
                <div className="atype amber">Loading…</div>
                <div className="atitle">​</div>
              </div>
            </article>
          ))}
        </div>
      </>
    )
  }

  if (api?.error) {
    return (
      <>
        <PageHead unackedZero={false} />
        <EmptyState
          icon={ShieldAlert}
          title="Could not load alerts"
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

  const sorted = [...alerts].sort((a, b) => b.at - a.at)
  const unacked = alerts.filter((a) => !a.acked).length

  return (
    <>
      <PageHead unackedZero={unacked === 0} />
      <div className="banner">
        <ShieldCheck aria-hidden="true" />
        <p>Telegram is a one-way notification mirror. Each alert is pushed only to the operator assigned to that camera via this app's camera assignment.</p>
      </div>
      {sorted.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No alerts in this window"
          hint="Unknown-person detections will raise alerts here and push to the assigned operator's Telegram."
        />
      ) : (
        <div className="alertlist">
          {sorted.map((a, i) => {
            const cardCls = a.acked ? 'alert glass acked' : a.sev === 'red' ? 'alert glass red' : 'alert glass amber'
            return (
              <article key={a.id} className={`${cardCls} rise`} style={{ '--i': Math.min(i, 8) }}>
                <div className="asnap" aria-hidden="true">
                  <div className="grid2" />
                  <TBox kind="unk" />
                </div>
                <div className="acol">
                  <div className={a.sev === 'red' ? 'atype red' : 'atype amber'}>{a.type}</div>
                  <div className="atitle">{a.title}</div>
                  <div className="ameta"><span className="mono">{a.cam} · {a.camName ?? a.cam}</span></div>
                  <div className="troute">
                    <Send aria-hidden="true" />
                    Routed to Telegram ➔ {a.route ?? 'SOC-Team'}
                  </div>
                </div>
                <div className="aright">
                  <span className="atime mono">{fmtHM(a.at)}</span>
                  {a.acked ? (
                    <span className="ackdone"><Check aria-hidden="true" size={14} /> Acknowledged{a.ackedBy ? ` · ${a.ackedBy}` : ''}</span>
                  ) : (
                    <button type="button" className="ackbtn" onClick={() => ackAlert(a.id)}>
                      Acknowledge
                    </button>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}
    </>
  )
}

function PageHead({ unackedZero }) {
  return (
    <div className="pagehead">
      <div>
        <h1 className="h1">Active alerts</h1>
        <p className="sub">Events awaiting acknowledgment, newest first. Review-only.</p>
      </div>
      {unackedZero && (
        <span className="ackdone"><Check aria-hidden="true" size={14} /> All clear — nothing awaiting acknowledgment</span>
      )}
    </div>
  )
}
