// src/lib/vaultTreeCanonical.js — AEGIS Drive (IDEA1) · Private Vault encrypted hierarchy · canonical serialization
//
// "รูปแบบ plaintext ของ manifest" ถูกนิยามที่นี่ ไม่ใช่ที่ JSON.stringify:
//   - canonical JSON UTF-8: key เรียงตาม UTF-16 code unit, ไม่มี whitespace, จำนวนเต็มปลอดภัยเท่านั้น,
//     สตริงคงรูป Unicode ตามที่ให้มา (ไม่ normalize ที่ชั้นนี้), control char < 0x20 ถูก escape
//   - `nodes` (Map) ถูกเขียนเป็น array ของคู่ [nodeId, node] เรียงตาม nodeId — ลำดับของ Map ไม่ถูกเชื่อ
//   - parser เขียนเองแบบเข้มงวด: ปฏิเสธ key ซ้ำทุกระดับ, ตัวเลขที่ไม่ใช่จำนวนเต็มปลอดภัย, ความลึกเกิน,
//     ไบต์ต่อท้าย, และ key ที่ไม่อยู่ในสคีมา (รวม __proto__/constructor) — JSON.parse ไม่ทำสักข้อ
//   - padding: plaintext ‖ 0x00… ‖ u8 version ‖ u32be(plaintextLength) เต็ม bucket เล็กสุดที่พอ
//
// ⚠️ ทุกอย่างที่ถอดออกมาคือ "ข้อมูลที่ไม่น่าเชื่อถือ" จนกว่า vaultTreeManifest.validateManifest จะผ่าน —
//    ชั้นนี้รับประกันแค่รูปแบบและขอบเขตไบต์ ไม่ใช่ความถูกต้องของกราฟ
// ⚠️ ไม่มี I/O ไม่มี crypto ในไฟล์นี้

import { PADDING_BUCKETS, VAULT_TREE_CLIENT_LIMITS } from './vaultTreeLimits.js'

const te = new TextEncoder()
const td = new TextDecoder('utf-8', { fatal: true })

export const CANONICAL_FORMAT_VERSION = 1
export const PADDING_VERSION = 1
/** u8 version + u32 big-endian plaintext length */
export const PADDING_TRAILER_BYTES = 5

export class CanonicalError extends Error {
  /** @param {'DUPLICATE_KEY'|'BAD_NUMBER'|'DEPTH'|'TRAILING'|'UNKNOWN_KEY'|'LIMIT_DECODED_BYTES'|'BAD_STRING'|'BAD_SYNTAX'|'BAD_PADDING'|'BAD_TYPE'} code */
  constructor(code, message = code) {
    super(message)
    this.name = 'CanonicalError'
    this.code = code
  }
}

// ── สคีมาของ key (whitelist) — key อื่นใดที่ระดับนั้น = UNKNOWN_KEY ─────────────────────
const TOP_KEYS = new Set(['schemaVersion', 'treeId', 'generation', 'revisionId', 'baseRevisionId', 'rootNodeId', 'createdAtClient', 'nodes', 'recentOperationIds'])
const NODE_KEYS = new Set(['nodeId', 'kind', 'parentNodeId', 'name', 'createdAtClient', 'modifiedAtClient', 'lifecycle', 'blobRef', 'mediaType', 'plainSize'])
const LIFECYCLE_KEYS = new Set(['state', 'trashedAtClient', 'trashedFromParentNodeId'])
const BLOBREF_KEYS = new Set(['formatVersion', 'id'])

// ── encoder ──────────────────────────────────────────────────────────────────

function encodeString(s) {
  let out = '"'
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 0x22) out += '\\"'
    else if (c === 0x5c) out += '\\\\'
    else if (c === 0x08) out += '\\b'
    else if (c === 0x0c) out += '\\f'
    else if (c === 0x0a) out += '\\n'
    else if (c === 0x0d) out += '\\r'
    else if (c === 0x09) out += '\\t'
    else if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0')
    else if (c === 0x2028 || c === 0x2029) throw new CanonicalError('BAD_STRING', 'line/paragraph separator not allowed')
    else if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1)
      if (!(d >= 0xdc00 && d <= 0xdfff)) throw new CanonicalError('BAD_STRING', 'unpaired surrogate')
      out += s[i] + s[i + 1]; i++
    } else if (c >= 0xdc00 && c <= 0xdfff) throw new CanonicalError('BAD_STRING', 'unpaired surrogate')
    else out += s[i]
  }
  if (s.includes('\u0000')) throw new CanonicalError('BAD_STRING', 'NUL not allowed')
  return out + '"'
}

function encodeNumber(n) {
  if (!Number.isSafeInteger(n) || Object.is(n, -0)) throw new CanonicalError('BAD_NUMBER')
  return String(n)
}

function encodeValue(v, depth, limits) {
  if (depth > limits.maxJsonDepth) throw new CanonicalError('DEPTH')
  if (v === null) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return encodeNumber(v)
  if (typeof v === 'string') return encodeString(v)
  if (v instanceof Map) {
    const keys = [...v.keys()]
    for (const k of keys) if (typeof k !== 'string') throw new CanonicalError('BAD_TYPE', 'map keys must be strings')
    keys.sort()
    return '[' + keys.map((k) => '[' + encodeString(k) + ',' + encodeValue(v.get(k), depth + 1, limits) + ']').join(',') + ']'
  }
  if (Array.isArray(v)) return '[' + v.map((x) => encodeValue(x, depth + 1, limits)).join(',') + ']'
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
    return '{' + keys.map((k) => encodeString(k) + ':' + encodeValue(v[k], depth + 1, limits)).join(',') + '}'
  }
  throw new CanonicalError('BAD_TYPE', typeof v)
}

/**
 * manifest (plain object; `nodes` เป็น Map) → canonical UTF-8 bytes
 * ⚠️ ตรวจ maxDecodedBytes กับผลลัพธ์: plaintext ที่ใหญ่เกิน bucket สุดท้ายต้องไม่ถูกสร้าง
 */
export function canonicalEncode(manifest, limits = VAULT_TREE_CLIENT_LIMITS) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest instanceof Map) throw new CanonicalError('BAD_TYPE', 'manifest must be an object')
  const bytes = te.encode(encodeValue(manifest, 1, limits))
  if (bytes.length > limits.maxDecodedBytes) throw new CanonicalError('LIMIT_DECODED_BYTES')
  return bytes
}

// ── strict parser ─────────────────────────────────────────────────────────────
// ไวยากรณ์ JSON (RFC 8259) แต่ "canonical" = มีได้แค่รูปเดียว: ไม่ยอมรับ whitespace ที่ใดเลย
// (encoder ไม่เคยผลิตมัน; ไบต์ที่ต่างจากรูป canonical แม้ช่องว่างเดียวคือข้อมูลที่ไม่ใช่ของเรา)

class Parser {
  constructor(text, limits) { this.s = text; this.i = 0; this.limits = limits }
  fail(code = 'BAD_SYNTAX', msg) { throw new CanonicalError(code, msg ?? `${code} at ${this.i}`) }
  ws() { /* canonical form has no whitespace; nothing to skip */ }
  value(depth) {
    if (depth > this.limits.maxJsonDepth) this.fail('DEPTH')
    this.ws()
    const c = this.s[this.i]
    if (c === '{') return this.object(depth)
    if (c === '[') return this.array(depth)
    if (c === '"') return this.string()
    if (c === 't' && this.s.startsWith('true', this.i)) { this.i += 4; return true }
    if (c === 'f' && this.s.startsWith('false', this.i)) { this.i += 5; return false }
    if (c === 'n' && this.s.startsWith('null', this.i)) { this.i += 4; return null }
    if (c === '-' || (c >= '0' && c <= '9')) return this.number()
    // NaN / Infinity / +1 / .5 คือ "ตัวเลขที่ไม่ใช่รูปแบบของเรา" — รายงานเป็น BAD_NUMBER ให้ผู้เรียกแยกจากไวยากรณ์พัง
    if (c === 'N' || c === 'I' || c === '+' || c === '.') this.fail('BAD_NUMBER')
    this.fail()
  }
  object(depth) {
    this.i++ // {
    const out = Object.create(null)
    this.ws()
    if (this.s[this.i] === '}') { this.i++; return out }
    for (;;) {
      this.ws()
      if (this.s[this.i] !== '"') this.fail()
      const key = this.string()
      if (key in out) this.fail('DUPLICATE_KEY', `duplicate key ${JSON.stringify(key)}`)
      this.ws()
      if (this.s[this.i] !== ':') this.fail()
      this.i++
      out[key] = this.value(depth + 1)
      this.ws()
      if (this.s[this.i] === ',') { this.i++; continue }
      if (this.s[this.i] === '}') { this.i++; return out }
      this.fail()
    }
  }
  array(depth) {
    this.i++ // [
    const out = []
    this.ws()
    if (this.s[this.i] === ']') { this.i++; return out }
    for (;;) {
      out.push(this.value(depth + 1))
      this.ws()
      if (this.s[this.i] === ',') { this.i++; continue }
      if (this.s[this.i] === ']') { this.i++; return out }
      this.fail()
    }
  }
  string() {
    this.i++ // "
    let out = ''
    for (;;) {
      if (this.i >= this.s.length) this.fail()
      const c = this.s[this.i]
      const code = c.charCodeAt(0)
      if (c === '"') { this.i++; break }
      if (c === '\\') {
        const e = this.s[this.i + 1]
        this.i += 2
        if (e === '"') out += '"'
        else if (e === '\\') out += '\\'
        else if (e === '/') out += '/'
        else if (e === 'b') out += '\b'
        else if (e === 'f') out += '\f'
        else if (e === 'n') out += '\n'
        else if (e === 'r') out += '\r'
        else if (e === 't') out += '\t'
        else if (e === 'u') {
          const h = this.s.slice(this.i, this.i + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(h)) this.fail()
          out += String.fromCharCode(parseInt(h, 16)); this.i += 4
        } else this.fail()
        continue
      }
      if (code < 0x20) this.fail()
      out += c; this.i++
    }
    // เนื้อหาต้องเป็นสตริงที่ encoder ยอมสร้าง: ไม่มี NUL, U+2028/2029, surrogate ค้าง
    for (let k = 0; k < out.length; k++) {
      const u = out.charCodeAt(k)
      if (u === 0 || u === 0x2028 || u === 0x2029) this.fail('BAD_STRING')
      if (u >= 0xd800 && u <= 0xdbff) {
        const d = out.charCodeAt(k + 1)
        if (!(d >= 0xdc00 && d <= 0xdfff)) this.fail('BAD_STRING')
        k++
      } else if (u >= 0xdc00 && u <= 0xdfff) this.fail('BAD_STRING')
    }
    return out
  }
  number() {
    const start = this.i
    if (this.s[this.i] === '-') this.i++
    const d0 = this.i
    while (this.i < this.s.length && this.s[this.i] >= '0' && this.s[this.i] <= '9') this.i++
    const digits = this.s.slice(d0, this.i)
    const next = this.s[this.i]
    if (digits.length === 0 || (digits.length > 1 && digits[0] === '0')) this.fail('BAD_NUMBER')
    if (next === '.' || next === 'e' || next === 'E') this.fail('BAD_NUMBER')
    const text = this.s.slice(start, this.i)
    if (text === '-0') this.fail('BAD_NUMBER')
    const n = Number(text)
    if (!Number.isSafeInteger(n)) this.fail('BAD_NUMBER')
    return n
  }
}

function checkKeys(obj, allowed, where) {
  for (const k of Object.keys(obj)) if (!allowed.has(k)) throw new CanonicalError('UNKNOWN_KEY', `${where}.${k}`)
}

/**
 * canonical bytes → manifest object (nodes เป็น Map) — เข้มงวด ไม่มีการ "เดา"
 * ลำดับการตรวจ: ความยาว → ไวยากรณ์/ความลึก/key ซ้ำ/ตัวเลข → ไบต์ต่อท้าย → สคีมาของ key
 */
export function canonicalDecode(bytes, limits = VAULT_TREE_CLIENT_LIMITS) {
  if (!(bytes instanceof Uint8Array)) throw new CanonicalError('BAD_TYPE', 'bytes must be a Uint8Array')
  if (bytes.length > limits.maxDecodedBytes) throw new CanonicalError('LIMIT_DECODED_BYTES')
  let text
  try { text = td.decode(bytes) } catch { throw new CanonicalError('BAD_SYNTAX', 'invalid UTF-8') }
  const p = new Parser(text, limits)
  p.ws()
  if (p.s[p.i] !== '{') p.fail('BAD_SYNTAX', 'manifest must be an object')
  const top = p.object(1)
  p.ws()
  if (p.i !== p.s.length) p.fail('TRAILING')
  checkKeys(top, TOP_KEYS, 'manifest')
  const out = { ...top }
  if ('nodes' in top) {
    if (!Array.isArray(top.nodes)) throw new CanonicalError('BAD_TYPE', 'nodes must be an array of pairs')
    const map = new Map()
    for (const pair of top.nodes) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || !pair[1] || typeof pair[1] !== 'object' || Array.isArray(pair[1])) throw new CanonicalError('BAD_TYPE', 'node pair')
      if (map.has(pair[0])) throw new CanonicalError('DUPLICATE_KEY', 'duplicate nodeId')
      const node = pair[1]
      checkKeys(node, NODE_KEYS, 'node')
      if (node.lifecycle !== undefined) {
        if (!node.lifecycle || typeof node.lifecycle !== 'object' || Array.isArray(node.lifecycle)) throw new CanonicalError('BAD_TYPE', 'lifecycle')
        checkKeys(node.lifecycle, LIFECYCLE_KEYS, 'node.lifecycle')
      }
      if (node.blobRef !== undefined) {
        if (!node.blobRef || typeof node.blobRef !== 'object' || Array.isArray(node.blobRef)) throw new CanonicalError('BAD_TYPE', 'blobRef')
        checkKeys(node.blobRef, BLOBREF_KEYS, 'node.blobRef')
      }
      map.set(pair[0], { ...node, ...(node.lifecycle ? { lifecycle: { ...node.lifecycle } } : {}), ...(node.blobRef ? { blobRef: { ...node.blobRef } } : {}) })
    }
    out.nodes = map
  }
  return out
}

// ── padding ───────────────────────────────────────────────────────────────────

/**
 * plaintext → bucket เล็กสุดที่ ≥ length + trailer; เติมศูนย์; trailer = u8 version ‖ u32be length
 * @returns {{padded: Uint8Array, paddedLength: number}}
 */
export function padToBucket(bytes, buckets = PADDING_BUCKETS) {
  if (!(bytes instanceof Uint8Array)) throw new CanonicalError('BAD_TYPE', 'bytes must be a Uint8Array')
  const need = bytes.length + PADDING_TRAILER_BYTES
  const bucket = buckets.find((b) => b >= need)
  if (!bucket) throw new CanonicalError('LIMIT_DECODED_BYTES')
  const out = new Uint8Array(bucket)
  out.set(bytes, 0)
  out[bucket - PADDING_TRAILER_BYTES] = PADDING_VERSION
  new DataView(out.buffer).setUint32(bucket - 4, bytes.length, false)
  return { padded: out, paddedLength: bucket }
}

/** ถอด padding — ตรวจ version, ความยาว และว่าไบต์เติมเป็นศูนย์ทั้งหมด (ตรวจทุกไบต์ ไม่หยุดก่อน) */
export function stripPadding(padded) {
  if (!(padded instanceof Uint8Array) || padded.length < PADDING_TRAILER_BYTES) throw new CanonicalError('BAD_PADDING')
  const n = padded.length
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength)
  const version = padded[n - PADDING_TRAILER_BYTES]
  const len = view.getUint32(n - 4, false)
  let bad = version !== PADDING_VERSION || len > n - PADDING_TRAILER_BYTES ? 1 : 0
  if (!bad) for (let i = len; i < n - PADDING_TRAILER_BYTES; i++) bad |= padded[i]
  if (bad) throw new CanonicalError('BAD_PADDING')
  return padded.subarray(0, len)
}
