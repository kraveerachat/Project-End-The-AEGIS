// tests/fixtures/vaultTreeBackend.js — AEGIS Drive (IDEA1) · PR #157 Task 3.3
// ตัวแบ็กเอนด์ tree ในหน่วยความจำสำหรับชุดทดสอบจอ migration — ต่อยอด
// vaultScreenBackend.js (control plane เดิม __VAULT_BACKEND__) ด้วยเส้นทาง
// /api/vault/tree/* ที่ runGenesis ขับ พร้อม "ประตู" ที่เทสต์เปิดเอง ไม่ใช่การหน่วงเวลา
//
// ⚠️ จุดประสงค์เดียวกับ vaultScreenBackend: ชุดนี้ทดสอบ state machine ของจอ/ไดอะล็อก
//    โมดูล tree ตัวจริง (vaultTreeApi/vaultTreeMigration/vaultTreeKeys/vaultTreeManifest*)
//    ถูกโหลดตัวจริงผ่าน harness — มีเพียง './api.js' กับ metadata-decryption ที่ถูกสตับ
//    ให้วิ่งเข้า control plane เดียวกัน รูปทรงคำตอบจึงเหมือนเซิร์ฟเวอร์จริงทุกประการ
import * as screenBackend from './vaultScreenBackend.js'

export * from './vaultScreenBackend.js'
const { makeVaultBackend, serverBlob } = screenBackend

export const TREE_DEFAULT_FLAGS = Object.freeze({
  schemaAvailable: true,
  protocolEnabled: true,
  genesisMigrationEnabled: true,
  treeUiEnabled: false,
  mediaPreviewEnabled: false,
  destructivePurgeEnabled: false,
})

const mkId = (ch) => ch.repeat(22)

// รูปทรง genesis ที่เซิร์ฟเวอร์ประกาศ (server/routes/vaultTree.js) — ตัวแบ็กเอนด์ปฏิเสธ
// ทุก body ที่คีย์เกิน/ขาด เพื่อให้ชุดจอตรวจ "ลูกค้าส่งเกินสิ่งที่ประกาศ" ได้ด้วย
const GENESIS_KEYS = ['epoch', 'frozenInventoryId', 'idempotencyKey', 'keyEnvelope', 'leaseId', 'ownerScopeIdB64', 'revision', 'treeId']
const GENESIS_REVISION_KEYS = ['ivB64', 'manifestSchemaVersion', 'revisionId', 'wrapIvB64', 'wrappedManifestDekB64']

export function makeVaultTreeBackend({ flags = {} } = {}) {
  const ctl = makeVaultBackend()
  ctl.tree = {
    protocolState: 'FLAT',
    lease: null,        // รูปทรงเดียวกับที่ GET /api/vault/tree/state คืน: { held, epoch, expiresAt }
    activeLease: null,  // คำตอบเต็มของ begin/takeover — ใช้ตรวจ genesis ว่าผูกกับ lease นี้จริง
    head: null,
    genesisBodies: [],
    ciphertexts: [],
    failGenesisCode: null,
  }
  ctl.treeFlags = { ...TREE_DEFAULT_FLAGS, ...flags }

  // อ่านสดทุก render — จอเห็น protocolState ปัจจุบันของ "เซิร์ฟเวอร์" เสมอ
  Object.defineProperty(ctl.state, '/api/vault/tree/state', {
    enumerable: true,
    get: () => ({
      loading: false,
      data: {
        protocolState: ctl.tree.protocolState,
        minProtocolVersion: 1,
        flags: ctl.treeFlags,
        lease: ctl.tree.lease,
        head: ctl.tree.head,
        purgeBarrierGeneration: 0,
      },
      error: null,
    }),
  })

  // ประตูของเทสต์: คำขอที่ตรง holdPath จะค้างเป็น promise — release() เปิดเอง (ไม่มี timer)
  let held = null
  ctl.holdPath = null
  ctl.release = (reply) => {
    ctl.holdPath = null
    if (!held) return false
    const resolve = held
    held = null
    resolve(reply)
    return true
  }

  const frozenBlobs = () => ctl.tree.frozenBlobs ?? ctl.state['/api/vault'].data?.blobs ?? []

  const issueLease = (epoch) => {
    const lease = {
      leaseId: mkId('L'),
      epoch,
      expiresAt: Date.now() + 600_000,
      frozenInventoryId: mkId('F'),
      blobs: frozenBlobs(),
    }
    ctl.tree.activeLease = lease
    ctl.tree.lease = { held: true, epoch, expiresAt: lease.expiresAt }
    ctl.tree.protocolState = 'MIGRATING_TREE_V1'
    return lease
  }

  const leaseEnvelope = (lease, status) => ({ ok: true, status, data: lease, errorKind: null })
  const srvErr = (status, code) => ({ ok: false, status, data: { error: 'e', code }, errorKind: 'server' })

  ctl.respond = async ({ path, method, options }) => {
    // คำขอที่เทสต์จับค้างไว้ — ปล่อยด้วย ctl.release ตามจังหวะของเทสต์เอง
    if (ctl.holdPath && String(path).includes(ctl.holdPath) && !held) {
      return new Promise((resolve) => { held = resolve })
    }
    if (!String(path).startsWith('/api/vault/tree/')) return undefined

    if (path === '/api/vault/tree/state' && method === 'GET') {
      return { ok: true, status: 200, data: ctl.state['/api/vault/tree/state'].data, errorKind: null }
    }
    if (path === '/api/vault/tree/migration/begin' && method === 'POST') {
      if (ctl.tree.protocolState !== 'FLAT') return srvErr(409, 'TREE_STATE_CONFLICT')
      return leaseEnvelope(issueLease((ctl.tree.lease?.epoch ?? 0) + 1), 201)
    }
    if (path === '/api/vault/tree/migration/takeover' && method === 'POST') {
      return leaseEnvelope(issueLease((ctl.tree.lease?.epoch ?? 0) + 1), 200)
    }
    if (path === '/api/vault/tree/migration/abandon' && method === 'POST') {
      ctl.tree.lease = null
      ctl.tree.activeLease = null
      // เซิร์ฟเวอร์จริงคืน FLAT เมื่อ lease ถูกละทิ้งกลางการย้าย
      if (ctl.tree.protocolState === 'MIGRATING_TREE_V1') ctl.tree.protocolState = 'FLAT'
      return { ok: true, status: 200, data: {}, errorKind: null }
    }
    if (path === '/api/vault/tree/revisions' && method === 'POST') {
      const meta = options?.body
      if (!meta || typeof meta.revisionId !== 'string') return srvErr(400, 'TREE_BAD_REQUEST')
      return { ok: true, status: 201, data: { revisionId: meta.revisionId, state: 'CREATED' }, errorKind: null }
    }
    if (/^\/api\/vault\/tree\/revisions\/[^/]+\/ciphertext$/.test(path) && method === 'PUT') {
      const revisionId = decodeURIComponent(path.split('/')[5])
      const bytes = options?.body
      if (!(bytes instanceof Uint8Array)) return srvErr(400, 'TREE_BAD_REQUEST')
      ctl.tree.ciphertexts.push({ revisionId, bytes })
      return { ok: true, status: 200, data: { revisionId, state: 'PUBLISHED', ciphertextSize: bytes.length }, errorKind: null }
    }
    if (path === '/api/vault/tree/genesis' && method === 'POST') {
      const body = options?.body
      if (ctl.tree.failGenesisCode) return srvErr(409, ctl.tree.failGenesisCode)
      const lease = ctl.tree.activeLease
      if (!lease || body?.leaseId !== lease.leaseId || body?.epoch !== lease.epoch || body?.frozenInventoryId !== lease.frozenInventoryId) {
        return srvErr(409, 'TREE_LEASE_STALE')
      }
      if (JSON.stringify(Object.keys(body ?? {}).sort()) !== JSON.stringify(GENESIS_KEYS)) {
        return srvErr(400, 'TREE_BAD_REQUEST')
      }
      if (JSON.stringify(Object.keys(body?.revision ?? {}).sort()) !== JSON.stringify(GENESIS_REVISION_KEYS)) {
        return srvErr(400, 'TREE_BAD_REQUEST')
      }
      ctl.tree.genesisBodies.push(body)
      ctl.tree.head = { revisionId: body.revision.revisionId, generation: 1 }
      ctl.tree.protocolState = 'TREE_V1'
      ctl.tree.lease = null
      ctl.tree.activeLease = null
      return {
        ok: true, status: 201,
        data: { treeId: body.treeId, generation: 1, revisionId: body.revision.revisionId, protocolState: 'TREE_V1' },
        errorKind: null,
      }
    }
    return srvErr(404, 'NOT_FOUND')
  }

  return ctl
}

/** แถว inventory V1 ที่ planMigration ตัวจริงถอดได้ผ่าน vaultCrypto ตัวสตับ */
export function v1Blob(opts) {
  return { ...serverBlob(opts), formatVersion: 1 }
}
