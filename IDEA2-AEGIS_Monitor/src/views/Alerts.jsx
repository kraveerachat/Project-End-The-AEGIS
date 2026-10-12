import { Check, RefreshCw, Send, ShieldAlert, ShieldCheck } from 'lucide-react'
import { fmtHM } from '../data.js'
import { EmptyState, TBox } from '../components/ui.jsx'
import { getViewState, VIEW_STATE } from '../lib/viewState.js'
import { useLocale } from '../lib/Locale.jsx'

/* ⚠️ Phase 2: alerts มาจาก GET /api/alerts (SOC-Responder เท่านั้น — requireRole
   ฝั่งเซิร์ฟเวอร์) · camName/route ถูกคำนวณฝั่งเซิร์ฟเวอร์จาก camera_assignment
   Acknowledge = POST จริง — การเขียนเดียวของ console นี้ (review-only) */
export default function Alerts({ alerts, ackAlert, api }) {
  const { t } = useLocale()
  const state = getViewState(api, (data) => (data?.alerts ?? []).length === 0)

  if (state === VIEW_STATE.ERROR) {
    return (
      <EmptyState icon={ShieldAlert} title={t('Could not load alerts')}
        hint={t('The Monitor backend did not respond. Check the server, then retry.')}
        action={<button type="button" className="ackbtn" onClick={api.retry}><RefreshCw aria-hidden="true" size={13} style={{ marginRight: 6 }} />{t('Retry')}</button>} />
    )
  }

  if (state === VIEW_STATE.LOADING) {
    return <EmptyState icon={ShieldAlert} title={t('Loading alerts')} hint={t('Retrieving the current alert queue.')} />
  }

  const sorted = [...alerts].sort((a, b) => b.at - a.at)
  const unacked = alerts.filter((a) => !a.acked).length

  return (
    <>
      <PageHead unackedZero={unacked === 0} />
      <div className="banner">
        <ShieldCheck aria-hidden="true" />
        <p>{t("Telegram is a one-way notification mirror. Each alert is pushed only to the operator assigned to that camera via this app's camera assignment.")}</p>
      </div>
      {state === VIEW_STATE.SUCCESS_EMPTY ? (
        <EmptyState
          icon={ShieldCheck}
          title={t('No alerts in this window')}
          hint={t("Unknown-person detections will raise alerts here and push to the assigned operator's Telegram.")}
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
                  {/* Translate only known Engine copy; arbitrary alert payload text is data. */}
                  <div className={a.sev === 'red' ? 'atype red' : 'atype amber'}>{a.type === 'unknown_face' ? t('unknown_face') : a.type}</div>
                  <div className="atitle">{a.title === 'Unknown person detected' ? t('Unknown person detected') : a.title}</div>
                  <div className="ameta"><span className="mono">{a.cam} · {a.camName ?? a.cam}</span></div>
                  <div className="troute">
                    <Send aria-hidden="true" />
                    {t('Routed to Telegram ➔ {route}', { route: a.route ?? 'SOC-Team' })}
                  </div>
                </div>
                <div className="aright">
                  <span className="atime mono">{fmtHM(a.at)}</span>
                  {a.acked ? (
                    <span className="ackdone"><Check aria-hidden="true" size={14} /> {t('Acknowledged')}{a.ackedBy ? ` · ${a.ackedBy}` : ''}</span>
                  ) : (
                    <button type="button" className="ackbtn" onClick={() => ackAlert(a.id)}>
                      {t('Acknowledge')}
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
  const { t } = useLocale()
  return (
    <div className="pagehead">
      <div>
        <h1 className="h1">{t('Active alerts')}</h1>
        <p className="sub">{t('Events awaiting acknowledgment, newest first. Review-only.')}</p>
      </div>
      {unackedZero && (
        <span className="ackdone"><Check aria-hidden="true" size={14} /> {t('All clear — nothing awaiting acknowledgment')}</span>
      )}
    </div>
  )
}
