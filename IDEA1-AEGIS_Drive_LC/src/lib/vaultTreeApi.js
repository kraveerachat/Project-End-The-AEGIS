// src/lib/vaultTreeApi.js — AEGIS Drive (IDEA1) · Private Vault encrypted hierarchy · client API wrappers
//
// ทรานสปอร์ตชั้นบาง ๆ ของ TREE_V1: ทุกฟังก์ชันส่งเฉพาะฟิลด์ opaque ที่เซิร์ฟเวอร์ประกาศไว้เท่านั้น
// (เซิร์ฟเวอร์ไม่เคยเห็นชื่อ/โครงสร้างต้นไม้/เนื้อหา) และแมป { code } ของเซิร์ฟเวอร์เป็น TreeApiError
// เพื่อให้ UI ตัดสินจากโค้ดจริง (เช่น TREE_LEASE_STALE) ไม่ใช่แค่สถานะ HTTP
//
// ⚠️ ไม่มี retry, ไม่มี cache, ไม่มี storage ในไฟล์นี้ — การตัดสินใจทั้งหมดเป็นของผู้เรียก

import { apiFetch, apiFetchBytes } from './api.js'

/** ข้อผิดพลาดจากเซิร์ฟเวอร์ tree: code = data.code, หรือ errorKind, หรือ HTTP_<status> */
export class TreeApiError extends Error {
  constructor(code, { status = 0, data = null, message = undefined } = {}) {
    super(message ?? code)
    this.name = 'TreeApiError'
    this.code = code
    this.status = status
    this.data = data
  }
}

function treeApiErrorFrom(r) {
  const code = r?.data?.code ?? r?.errorKind ?? `HTTP_${r?.status ?? 0}`
  return new TreeApiError(code, { status: r?.status ?? 0, data: r?.data ?? null })
}

function assertTreeOk(r) {
  if (!r || r.ok !== true) throw treeApiErrorFrom(r)
  return r.data
}

/** แต่ละฟังก์ชันรับ opts ตัวท้าย { fetchJson, fetchBytes, signal } เพื่อให้เทสต์ฉีด transport ได้ */
function parts(opts = {}) {
  return { fetchJson: opts.fetchJson ?? apiFetch, fetchBytes: opts.fetchBytes ?? apiFetchBytes, signal: opts.signal }
}

export async function getTreeState(opts) {
  const { fetchJson, signal } = parts(opts)
  return assertTreeOk(await fetchJson('/api/vault/tree/state', { method: 'GET', signal }))
}

export async function getTreeHead(opts) {
  const { fetchJson, signal } = parts(opts)
  return assertTreeOk(await fetchJson('/api/vault/tree/head', { method: 'GET', signal }))
}

/** ciphertext ดิบของ revision — คืน Uint8Array เท่านั้น (ถอดที่ชั้น manifest crypto) */
export async function getRevisionCiphertext(revisionId, opts) {
  const { fetchBytes, signal } = parts(opts)
  const r = await fetchBytes(`/api/vault/tree/revisions/${encodeURIComponent(revisionId)}`, { signal })
  if (!r || r.ok !== true) throw treeApiErrorFrom(r)
  return r.bytes
}

export async function publishRevision(meta, opts) {
  const { fetchJson, signal } = parts(opts)
  return assertTreeOk(await fetchJson('/api/vault/tree/revisions', { method: 'POST', body: meta, signal }))
}

/** bytes ดิบผ่าน apiFetch (กิ่ง Uint8Array) — เซิร์ฟเวอร์เก็บตรง ๆ ไม่แตะความหมาย */
export async function putRevisionCiphertext(revisionId, bytes, opts) {
  const { fetchJson, signal } = parts(opts)
  return assertTreeOk(await fetchJson(`/api/vault/tree/revisions/${encodeURIComponent(revisionId)}/ciphertext`, { method: 'PUT', body: bytes, signal }))
}

export async function casHead(body, opts) {
  const { fetchJson, signal } = parts(opts)
  return assertTreeOk(await fetchJson('/api/vault/tree/head', { method: 'POST', body, signal }))
}

export async function casKeyEnvelope(body, opts) {
  const { fetchJson, signal } = parts(opts)
  return assertTreeOk(await fetchJson('/api/vault/tree/key-envelope', { method: 'POST', body, signal }))
}

/** บัญชี blob ทึบ + lifecycle; `lifecycle` (ไม่บังคับ) กรองฝั่งเซิร์ฟเวอร์ เช่น 'UNREFERENCED' = orphan ที่กู้ได้ (Task 4.3) */
export async function listTreeBlobs(opts = {}) {
  const { fetchJson, signal } = parts(opts)
  const q = opts.lifecycle ? `?lifecycle=${encodeURIComponent(opts.lifecycle)}` : ''
  return assertTreeOk(await fetchJson(`/api/vault/tree/blobs${q}`, { method: 'GET', signal }))
}

export async function beginMigration(opts) {
  const { fetchJson, signal } = parts(opts)
  return assertTreeOk(await fetchJson('/api/vault/tree/migration/begin', { method: 'POST', body: {}, signal }))
}

export async function takeoverMigration(opts) {
  const { fetchJson, signal } = parts(opts)
  return assertTreeOk(await fetchJson('/api/vault/tree/migration/takeover', { method: 'POST', body: {}, signal }))
}

export async function abandonMigration(body, opts) {
  const { fetchJson, signal } = parts(opts)
  return assertTreeOk(await fetchJson('/api/vault/tree/migration/abandon', { method: 'POST', body, signal }))
}

export async function commitGenesis(body, opts) {
  const { fetchJson, signal } = parts(opts)
  return assertTreeOk(await fetchJson('/api/vault/tree/genesis', { method: 'POST', body, signal }))
}

export async function confirmPurge(body, opts) {
  const { fetchJson, signal } = parts(opts)
  return assertTreeOk(await fetchJson('/api/vault/tree/purge/confirm', { method: 'POST', body, signal }))
}

export { treeApiErrorFrom, assertTreeOk }
