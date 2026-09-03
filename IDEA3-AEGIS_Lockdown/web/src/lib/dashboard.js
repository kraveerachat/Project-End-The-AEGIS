const statusPriority = Object.freeze({
  FAILED: 5,
  STALE: 4,
  DEGRADED: 3,
  NOT_CONFIGURED: 2,
  UNKNOWN: 1,
  DISABLED: 0,
  HEALTHY: -1,
})

const issueCopy = Object.freeze({
  COMPONENT_FAILED: 'องค์ประกอบ runtime ยังไม่มีหลักฐานยืนยันที่เพียงพอ',
  STATUS_STALE: 'หลักฐานล่าสุดเก่าเกินช่วงเวลาที่ระบบยอมรับ',
  ADAPTER_UNAVAILABLE: 'ไม่สามารถอ่านหลักฐานจาก adapter ได้',
  BROKER_DISCONNECTED: 'MQTT broker ไม่พร้อมรับส่งหลักฐาน',
  DEVICE_OFFLINE: 'ไม่พบ heartbeat ล่าสุดจากอุปกรณ์',
})

export function evidenceStatus(value = {}) {
  if (value.freshness === 'STALE') return 'STALE'
  return Object.hasOwn(statusPriority, value.status) ? value.status : 'UNKNOWN'
}

export function engineState(value) {
  return ['RUNNING', 'DEGRADED', 'STOPPED'].includes(value) ? value : 'UNKNOWN'
}

export function engineStatus(value) {
  return ({ RUNNING: 'HEALTHY', DEGRADED: 'DEGRADED', STOPPED: 'FAILED' })[engineState(value)] || 'UNKNOWN'
}

export function activeRuntimeModes(runtime = {}) {
  const modes = runtime.modes || {}
  return [
    ['MONITOR ONLY', modes.monitorOnly],
    ['DRY RUN', modes.dryRun],
    ['ARMED', modes.armed],
    ['AUTO CONTAIN', modes.autoContain],
    ['RECOVERY AUTH', modes.recoveryAuthorized],
  ].filter(([, enabled]) => enabled).map(([label]) => label)
}

export function runtimeComponent(runtime = {}, id) {
  return runtime.components?.find((component) => component.id === id) || { id, name: id, status: 'UNKNOWN' }
}

function addIssue(items, issue) {
  if (!items.some((item) => item.key === issue.key)) items.push(issue)
}

export function dashboardIssues(snapshot, { apiConnected = true } = {}) {
  const items = []
  const incident = snapshot.incidents?.[0]
  const device = snapshot.devices?.[0]
  const relay = runtimeComponent(snapshot.runtime, 'relay')

  if (!apiConnected) {
    addIssue(items, {
      key: 'api-disconnected', status: 'FAILED', component: 'Security Center API', route: 'settings',
      title: 'API ขาดการเชื่อมต่อ', detail: 'กำลังแสดงหลักฐานล่าสุดที่เก็บไว้ ตรวจสอบบริการ API ก่อนดำเนินการ',
    })
  }

  if (incident?.severity === 'CRITICAL') {
    addIssue(items, {
      key: `incident-${incident.id}`, status: 'FAILED', component: incident.id, route: 'incidents',
      title: 'มี Critical Incident ที่ต้องตรวจสอบ', detail: `เชื่อมโยงกับ ${incident.id}`,
    })
  }

  for (const [key, label, domain, route] of [
    ['idea1', 'IDEA1 Access Security', snapshot.idea1, 'idea1'],
    ['idea2', 'IDEA2 Detection', snapshot.idea2, 'idea2'],
  ]) {
    const status = evidenceStatus(domain)
    if (status !== 'HEALTHY') {
      addIssue(items, {
        key, status, component: label, route,
        title: status === 'STALE' ? `${label} มีหลักฐานเก่าเกินกำหนด` : `${label} ต้องตรวจสอบ`,
        detail: 'เปิดหน้ารายละเอียดเพื่อตรวจแหล่งหลักฐานและสถานะ adapter',
      })
    }
  }

  const physicalRelayState = device?.physicalRelayState
  if (!physicalRelayState || physicalRelayState === 'UNKNOWN' || relay.status === 'UNKNOWN') {
    addIssue(items, {
      key: 'relay-not-verified', status: 'UNKNOWN', component: 'IDEA3 relay evidence', route: 'lockdown',
      title: 'IDEA3 relay evidence ยังไม่พร้อมตรวจสอบ',
      detail: 'Requested state และ ACK ไม่ใช่หลักฐานยืนยันสถานะ Relay ทางกายภาพ',
    })
  }

  if (snapshot.auditIntegrity?.status !== 'HEALTHY') {
    addIssue(items, {
      key: 'audit-integrity', status: evidenceStatus(snapshot.auditIntegrity), component: 'Audit Store', route: 'audit',
      title: 'Audit store ยังไม่เป็น durable verified storage', detail: snapshot.auditIntegrity?.detail || 'ยังไม่มีหลักฐานยืนยันความสมบูรณ์ของ Audit',
    })
  }

  for (const issue of snapshot.runtime?.issues || []) {
    addIssue(items, {
      key: `runtime-${issue.code}-${issue.component}`,
      status: issue.severity === 'CRITICAL' ? 'FAILED' : 'DEGRADED',
      component: issue.component,
      route: issue.component?.includes('relay') ? 'lockdown' : 'devices',
      title: issueCopy[issue.code] || 'Runtime มีประเด็นที่ต้องตรวจสอบ',
      detail: `${issue.code} · พบ ${issue.count ?? 1} ครั้ง`,
    })
  }

  return items
    .sort((a, b) => (statusPriority[b.status] ?? 0) - (statusPriority[a.status] ?? 0))
    .slice(0, 5)
}

export function recommendedActions(issues) {
  return issues.slice(0, 3).map((issue) => ({
    ...issue,
    action: issue.route === 'incidents' ? `ตรวจสอบ Incident ${issue.component}`
      : issue.route === 'lockdown' ? 'ตรวจสอบสถานะอุปกรณ์ IDEA3'
        : issue.route === 'audit' ? 'ตรวจสอบ Audit configuration'
          : issue.route === 'settings' ? 'ตรวจสอบการตั้งค่า Production'
            : `เปิดรายละเอียด ${issue.component}`,
  }))
}
