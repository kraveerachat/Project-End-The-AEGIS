import { useEffect, useState } from 'react'
import { RefreshCw, ServerOff, UserPlus } from 'lucide-react'
import { ini } from '../data.js'
import { EmptyState, FeedChrome, StaleBadge } from '../components/ui.jsx'
import { useApi } from '../lib/hooks.js'
import { AddOperatorModal, TempPasswordModal } from '../components/AddOperator.jsx'
import { getViewState, VIEW_STATE } from '../lib/viewState.js'
import { useLocale } from '../lib/Locale.jsx'

// ⚠️ กรอบภาพสด: ใช้ proxy เดียวกับ Live canvas (GET /api/cameras/:id/stream) —
//    ไม่ต่อตรงไปหา Detection Engine เด็ดขาด เหมือนทุกจุดที่แสดงภาพกล้องในระบบนี้
//    เบา/เรียบง่ายกว่า components/LiveFeed.jsx โดยตั้งใจ (ไม่มี backoff/reconnect
//    เต็มรูปแบบ) เพราะที่นี่เป็นแค่ thumbnail ภาพรวมของทั้ง fleet ไม่ใช่จอเฝ้าดูหลัก
//    — โหลดพังก็แค่ตกกลับไปโชว์ placeholder เฉย ๆ ไม่ต้อง retry loop
function NodeThumb({ camera }) {
  const { t } = useLocale()
  const [broken, setBroken] = useState(false)
  const [nonce, setNonce] = useState(0)

  // กล้องเปลี่ยนสถานะ online/offline → รีเซ็ต ลองโหลดใหม่อีกครั้งเสมอ
  useEffect(() => {
    setBroken(false)
    setNonce((n) => n + 1)
  }, [camera.online])

  const showPlaceholder = !camera.online || broken

  return (
    <div
      className="nodethumb"
      style={{ position: 'relative', aspectRatio: '16 / 9', borderRadius: 10, overflow: 'hidden', background: '#05060e' }}
    >
      {showPlaceholder ? (
        <FeedChrome />
      ) : (
        <img
          key={nonce}
          src={`${import.meta.env.BASE_URL}api/cameras/${camera.id}/stream?t=${nonce}`}
          alt={t('{camera} live preview', { camera: camera.id })}
          draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          onError={() => setBroken(true)}
        />
      )}
    </div>
  )
}

// ⚠️ Phase 2: SOC-only view — self-fetches GET /api/nodes (cameras + assignments +
// operators + link, all pre-scoped/joined server-side). No props from App.jsx;
// this view owns its own data lifecycle like Live/Archive/Settings do.
//
// "Add operator" อยู่ในวิวนี้เพราะทั้งวิวถูกส่งให้เฉพาะ SOC-Responder ผ่าน menu payload
// ฝั่งเซิร์ฟเวอร์ (permissions.js) — ไม่มี client-side role check ที่ไหน CCTV-Operator
// ไม่เคยได้รับวิวนี้ใน DOM เลย และ POST /api/operators ยังบังคับ requireRole ซ้ำอีกชั้น
export default function Nodes() {
  const { t } = useLocale()
  const api = useApi('/api/nodes', { refreshMs: 30_000 })
  const state = getViewState(api, (data) => (data?.cameras ?? []).length === 0)
  // null = ปิด · 'form' = ฟอร์มเพิ่ม operator · { username, tempPassword } = โชว์รหัสครั้งเดียว
  const [modal, setModal] = useState(null)

  const onCreated = (result) => setModal(result) // สลับจากฟอร์มไปหน้าโชว์รหัสชั่วคราว
  const closeAndRefresh = () => {
    const wasSuccess = modal && modal !== 'form'
    setModal(null)
    if (wasSuccess) api.retry() // รีเฟรช Nodes list ให้ operator ใหม่โผล่โดยไม่ต้อง reload เอง
  }

  const head = <PageHead link={api.data?.link} onAdd={api.loading || api.error ? null : () => setModal('form')} />

  if (state === VIEW_STATE.LOADING) {
    return (
      <>
        {head}
        <div className="nodegrid" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <article key={i} className="node node--routing glass rise" style={{ opacity: 0.45 }}>
              <div className="nodebody nodebody--loading" aria-hidden="true">
                <span className="node-skeleton node-skeleton--title" />
                <span className="node-skeleton" />
                <span className="node-skeleton" />
                <span className="node-skeleton" />
              </div>
            </article>
          ))}
        </div>
      </>
    )
  }

  if (state === VIEW_STATE.ERROR) {
    return (
      <EmptyState icon={ServerOff} title={t('Could not load nodes')}
        hint={t('The Monitor backend did not respond. Check the server, then retry.')}
        action={<button type="button" className="ackbtn" onClick={api.retry}><RefreshCw aria-hidden="true" size={13} style={{ marginRight: 6 }} />{t('Retry')}</button>} />
    )
  }

  const cameras = api.data?.cameras ?? []
  const operators = api.data?.operators ?? []
  const assignments = api.data?.assignments ?? {}
  const link = api.data?.link ?? { status: 'lost' }

  const resolve = (camId) => {
    const v = assignments[camId]
    if (v === 'SOC') return { name: 'SOC-Team', active: true, isSoc: true }
    if (!v) return null
    const op = operators.find((o) => o.id === v)
    return op ? { name: op.name, active: op.active } : null
  }

  const modals = (
    <>
      {modal === 'form' && <AddOperatorModal onClose={() => setModal(null)} onCreated={onCreated} />}
      {modal && modal !== 'form' && <TempPasswordModal result={modal} onClose={closeAndRefresh} />}
    </>
  )

  if (state === VIEW_STATE.SUCCESS_EMPTY) {
    return (
      <>
        <PageHead link={link} onAdd={() => setModal('form')} />
        <EmptyState
          icon={ServerOff}
          title={t('No cameras registered')}
          hint={t('No camera nodes are connected to this deployment yet.')}
        />
        {modals}
      </>
    )
  }

  return (
    <>
      <PageHead link={link} onAdd={() => setModal('form')} />
      <div className="nodegrid">
        {cameras.map((c, i) => {
          const op = resolve(c.id)
          return (
            <article key={c.id} className="node node--routing glass rise" style={{ '--i': Math.min(i, 8) }}>
              <NodeThumb camera={c} />
              <div className="nodebody">
                <div className="nodename">
                  {c.name}
                  {c.online && <span className="recwrap"><span className="rec" />{t('REC')}</span>}
                </div>
                <div className="nodefields">
                  <div className="nfield"><span className="nflab">{t('Camera ID')}</span><span className="nfval mono">{c.id}</span></div>
                  <div className="nfield"><span className="nflab">{t('Zone')}</span><span className="nfval">{c.zone}</span></div>
                  <div className="nfield"><span className="nflab">{t('Resolution')}</span><span className="nfval mono">{c.res}</span></div>
                  <div className="nfield">
                    <span className="nflab">{t('Assigned to')}</span>
                    {op ? (
                      <span
                        className={op.active ? 'assigned' : 'assigned un'}
                        title={op.active ? undefined : t('Suspended — alerts route to SOC-Team')}
                      >
                        <span className="av" aria-hidden="true">{ini(op.name)}</span>
                        {op.isSoc ? t('SOC-Team') : op.name}{!op.active && t(' · suspended')}
                      </span>
                    ) : (
                      <span className="assigned un">{t('Unassigned')}</span>
                    )}
                  </div>
                  <div className="nfield">
                    <span className="nflab">{t('Status')}</span>
                    <span className={c.online ? 'statustag on' : 'statustag off'}>
                      <span className={c.online ? 'tdot on' : 'tdot off'} />
                      {t(c.online ? 'Online' : 'Offline')}
                    </span>
                  </div>
                </div>
              </div>
            </article>
          )
        })}
      </div>
      {modals}
    </>
  )
}

function PageHead({ link, onAdd }) {
  const { t } = useLocale()
  return (
    <div className="pagehead">
      <div>
        <h1 className="h1">{t('Nodes & routing')}</h1>
        <p className="sub">{t('Connected cameras and their responsible operator, per central RBAC assignment.')}</p>
      </div>
      <div className="pagehead-actions">
        {link && link.status !== 'online' && <StaleBadge red={link.status === 'lost'} label={t('Status may be stale')} />}
        {onAdd && (
          <button type="button" className="ackbtn" onClick={onAdd}>
            <UserPlus aria-hidden="true" size={13} style={{ marginRight: 6 }} />{t('Add operator')}
          </button>
        )}
      </div>
    </div>
  )
}
