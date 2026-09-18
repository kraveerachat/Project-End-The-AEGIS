// tests/helpers/sparseContainers.mjs — AEGIS Drive (IDEA1) · sparse MP4/WebM fixtures ที่ "ถูกต้องเชิงโครงสร้าง" (plan Task 16)
//
// ⚠️ ทำไมต้อง sparse: ไฟล์ 10–20 GiB จริงสร้าง/เก็บไม่ไหวใน gate — เราจึงเอาคอนเทนเนอร์สั้น ๆ ที่ถูกต้อง มาแทรก "ช่องว่าง"
//    (MP4: กล่อง free ขนาด 64-bit / WebM: element Void) ที่ไม่เคยถูกเขียน (sparse) แล้ว "ย้าย offset ทุกตัว" ให้ถูกต้อง
//    (stco→co64, SeekPosition, CueClusterPosition) — ffprobe/ffmpeg ต้องอ่านมันได้เหมือนไฟล์จริง ไม่ใช่ zero padding
// ⚠️ ไม่ใช้ ffmpeg ในการสร้าง (Node ล้วน) — ffmpeg ใช้ตอน "ตรวจ" เท่านั้น; builder ที่เจอกล่อง/element ที่ไม่รู้จักจะ throw
//    และชุดทดสอบต้องรายงาน NOT_PROVEN ไม่ใช่ผ่านเงียบ ๆ
import fs from 'node:fs/promises'
import { open } from 'node:fs/promises'
import { execFile } from 'node:child_process'

const exec = (bin, args, timeoutMs = 60_000) => new Promise((resolve) => {
  execFile(bin, args, { shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
    resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), err })
  })
})

/* ════════════════════════════════════════════════════════════════════════════
   MP4 (ISO BMFF)
   ═══════════════════════════════════════════════════════════════════════════ */
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta'])

/** อ่านกล่องระดับบนสุดของไฟล์ (รองรับ largesize) */
function parseBoxes(buf, start = 0, end = buf.length) {
  const boxes = []
  let off = start
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    let header = 8
    if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); header = 16 }
    else if (size === 0) size = end - off
    if (size < header || off + size > end) throw new Error(`mp4: bad box ${type} at ${off} size ${size}`)
    boxes.push({ type, offset: off, size, header })
    off += size
  }
  if (off !== end) throw new Error(`mp4: trailing ${end - off} bytes`)
  return boxes
}

/** สร้าง moov ใหม่: stco → co64 (+delta ต่อ chunk) และแก้ขนาดกล่องแม่ทุกชั้น — คืน Buffer ใหม่ */
function rewriteMoov(buf, box, delta) {
  const body = rewriteChildren(buf, box.offset + box.header, box.offset + box.size, delta)
  return wrapBox(box.type, body)
}
function wrapBox(type, body) {
  const size = 8 + body.length
  const head = Buffer.alloc(8)
  head.writeUInt32BE(size, 0); head.write(type, 4, 'latin1')
  return Buffer.concat([head, body])
}
function rewriteChildren(buf, start, end, delta) {
  const out = []
  for (const child of parseBoxes(buf, start, end)) {
    if (CONTAINERS.has(child.type)) {
      out.push(rewriteMoov(buf, child, delta))
    } else if (child.type === 'stco' || child.type === 'co64') {
      const p = child.offset + child.header
      const verFlags = buf.subarray(p, p + 4)
      const count = buf.readUInt32BE(p + 4)
      const body = Buffer.alloc(8 + count * 8)
      verFlags.copy(body, 0); body.writeUInt32BE(count, 4)
      for (let i = 0; i < count; i += 1) {
        const v = child.type === 'stco' ? BigInt(buf.readUInt32BE(p + 8 + i * 4)) : buf.readBigUInt64BE(p + 8 + i * 8)
        body.writeBigUInt64BE(v + BigInt(delta), 8 + i * 8)
      }
      out.push(wrapBox('co64', body))
    } else {
      out.push(buf.subarray(child.offset, child.offset + child.size))
    }
  }
  return Buffer.concat(out)
}
/** ขนาด moov หลังแปลง stco→co64 (ไม่ขึ้นกับ delta) */
const moovSizeAfter = (buf, box) => rewriteMoov(buf, box, 0).length

/** กล่อง free ขนาด 64-bit ที่ payload เป็น sparse: เขียนแค่ header 16 ไบต์ แล้ว truncate ให้ยาว */
function freeHeader(spanBytes) {
  const h = Buffer.alloc(16)
  h.writeUInt32BE(1, 0); h.write('free', 4, 'latin1'); h.writeBigUInt64BE(BigInt(16 + spanBytes), 8) // largesize รวม header 16 ไบต์
  return h
}

/**
 * @param {{ src: string, spanBytes: number, layout: 'faststart'|'moov-at-end', out: string }} o
 * @returns {Promise<{ bytes: number, moovOffset: number, mdatOffset: number, layout: string }>}
 */
export async function makeSparseMp4({ src, spanBytes, layout, out }) {
  const buf = await fs.readFile(src)
  const boxes = parseBoxes(buf)
  const ftyp = boxes.find((b) => b.type === 'ftyp'); const moov = boxes.find((b) => b.type === 'moov'); const mdat = boxes.find((b) => b.type === 'mdat')
  if (!ftyp || !moov || !mdat) throw new Error('mp4: ftyp/moov/mdat required')
  const others = boxes.filter((b) => !['ftyp', 'moov', 'mdat', 'free', 'skip'].includes(b.type))
  if (others.length) throw new Error(`mp4: unsupported top-level boxes ${others.map((b) => b.type).join(',')}`)
  const ftypBuf = buf.subarray(ftyp.offset, ftyp.offset + ftyp.size)
  const mdatBuf = buf.subarray(mdat.offset, mdat.offset + mdat.size)
  const newMoovSize = moovSizeAfter(buf, moov)
  const span = 16 + spanBytes // free header + sparse payload
  let parts, moovOffset, mdatOffset
  if (layout === 'faststart') {
    // ftyp | moov(co64) | free(sparse) | mdat
    mdatOffset = ftypBuf.length + newMoovSize + span
    const delta = mdatOffset - mdat.offset
    const moovBuf = rewriteMoov(buf, moov, delta)
    moovOffset = ftypBuf.length
    parts = [{ buf: ftypBuf }, { buf: moovBuf }, { buf: freeHeader(spanBytes), sparse: spanBytes }, { buf: mdatBuf }]
  } else if (layout === 'moov-at-end') {
    // ftyp | free(sparse) | mdat | moov(co64) — moov คือกล่องสุดท้ายของไฟล์สุดท้าย
    mdatOffset = ftypBuf.length + span
    const delta = mdatOffset - mdat.offset
    const moovBuf = rewriteMoov(buf, moov, delta)
    moovOffset = mdatOffset + mdatBuf.length
    parts = [{ buf: ftypBuf }, { buf: freeHeader(spanBytes), sparse: spanBytes }, { buf: mdatBuf }, { buf: moovBuf }]
  } else throw new Error(`mp4: unknown layout ${layout}`)
  const bytes = await writeSparse(out, parts)
  return { bytes, moovOffset, mdatOffset, layout }
}

/** เขียนชิ้นส่วนลงไฟล์ — ชิ้นที่มี sparse จะถูก "ข้าม" ด้วยการเลื่อนตำแหน่งเขียน (ไม่มีไบต์ศูนย์ถูกเขียนจริง) */
async function writeSparse(out, parts) {
  const fh = await open(out, 'w')
  let pos = 0
  try {
    for (const p of parts) {
      if (p.buf?.length) { await fh.write(p.buf, 0, p.buf.length, pos); pos += p.buf.length }
      if (p.sparse) { pos += p.sparse; await fh.truncate(pos) }
    }
  } finally { await fh.close() }
  return pos
}

/* ════════════════════════════════════════════════════════════════════════════
   WebM (EBML / Matroska)
   ═══════════════════════════════════════════════════════════════════════════ */
const ID = { EBML: 0x1A45DFA3, SEGMENT: 0x18538067, SEEKHEAD: 0x114D9B74, SEEK: 0x4DBB, SEEKID: 0x53AB, SEEKPOSITION: 0x53AC, INFO: 0x1549A966, TRACKS: 0x1654AE6B, CLUSTER: 0x1F43B675, CUES: 0x1C53BB6B, CUEPOINT: 0xBB, CUETIME: 0xB3, CUETRACKPOSITIONS: 0xB7, CUECLUSTERPOSITION: 0xF1, VOID: 0xEC, TAGS: 0x1254C367 }
const UNKNOWN_SIZE = -1

function readVintId(buf, off) {
  const first = buf[off]
  let len = 1
  while (len <= 4 && !(first & (0x80 >> (len - 1)))) len += 1
  if (len > 4) throw new Error(`ebml: bad id at ${off}`)
  let v = 0
  for (let i = 0; i < len; i += 1) v = v * 256 + buf[off + i]
  return { value: v, length: len }
}
function readVintSize(buf, off) {
  const first = buf[off]
  let len = 1
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len += 1
  if (len > 8) throw new Error(`ebml: bad size at ${off}`)
  let v = BigInt(first & (0xff >> len))
  let allOnes = (first & (0xff >> len)) === (0xff >> len)
  for (let i = 1; i < len; i += 1) { v = v * 256n + BigInt(buf[off + i]); if (buf[off + i] !== 0xff) allOnes = false }
  return { value: allOnes ? UNKNOWN_SIZE : Number(v), length: len }
}
function parseElements(buf, start, end) {
  const els = []
  let off = start
  while (off < end) {
    const id = readVintId(buf, off)
    const size = readVintSize(buf, off + id.length)
    const header = id.length + size.length
    const dataSize = size.value === UNKNOWN_SIZE ? end - (off + header) : size.value
    if (off + header + dataSize > end) throw new Error(`ebml: element 0x${id.value.toString(16)} at ${off} overruns`)
    els.push({ id: id.value, offset: off, header, dataOffset: off + header, dataSize, size: header + dataSize, unknownSize: size.value === UNKNOWN_SIZE })
    off += header + dataSize
  }
  return els
}
const encodeId = (id) => { const b = []; let v = id; while (v > 0) { b.unshift(v & 0xff); v = Math.floor(v / 256) } return Buffer.from(b) }
/** ขนาดแบบ 8 ไบต์คงที่ (0x01 + 7 ไบต์) — ให้ค่าใหญ่ได้เสมอโดยไม่ต้องคิดความยาวใหม่ */
function encodeSize8(n) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n) | (1n << 56n)); return b }
function readUint(buf, off, len) { let v = 0n; for (let i = 0; i < len; i += 1) v = v * 256n + BigInt(buf[off + i]); return v }
function uintElement(id, value) { const data = Buffer.alloc(8); data.writeBigUInt64BE(BigInt(value)); return Buffer.concat([encodeId(id), Buffer.from([0x88]), data]) }
function element(id, body) { return Buffer.concat([encodeId(id), encodeSize8(body.length), body]) }

/** เขียน SeekHead ใหม่ด้วย SeekPosition ที่ปรับแล้ว (ค่าเป็น 8 ไบต์คงที่) */
function rebuildSeekHead(buf, el, remap) {
  const seeks = []
  for (const seek of parseElements(buf, el.dataOffset, el.dataOffset + el.dataSize)) {
    if (seek.id === ID.VOID) continue
    if (seek.id !== ID.SEEK) throw new Error(`ebml: unexpected 0x${seek.id.toString(16)} in SeekHead`)
    let seekId = null, pos = null
    for (const c of parseElements(buf, seek.dataOffset, seek.dataOffset + seek.dataSize)) {
      if (c.id === ID.SEEKID) seekId = buf.subarray(c.dataOffset, c.dataOffset + c.dataSize)
      else if (c.id === ID.SEEKPOSITION) pos = Number(readUint(buf, c.dataOffset, c.dataSize))
    }
    if (!seekId || pos == null) throw new Error('ebml: Seek without id/position')
    seeks.push(element(ID.SEEK, Buffer.concat([element(ID.SEEKID, seekId), uintElement(ID.SEEKPOSITION, remap(pos))])))
  }
  return element(ID.SEEKHEAD, Buffer.concat(seeks))
}
/** เขียน Cues ใหม่ด้วย CueClusterPosition ที่ปรับแล้ว */
function rebuildCues(buf, el, delta) {
  const points = []
  for (const cp of parseElements(buf, el.dataOffset, el.dataOffset + el.dataSize)) {
    if (cp.id === ID.VOID) continue
    if (cp.id !== ID.CUEPOINT) throw new Error(`ebml: unexpected 0x${cp.id.toString(16)} in Cues`)
    const parts = []
    for (const c of parseElements(buf, cp.dataOffset, cp.dataOffset + cp.dataSize)) {
      if (c.id === ID.CUETRACKPOSITIONS) {
        const inner = []
        for (const d of parseElements(buf, c.dataOffset, c.dataOffset + c.dataSize)) {
          if (d.id === ID.CUECLUSTERPOSITION) inner.push(uintElement(ID.CUECLUSTERPOSITION, Number(readUint(buf, d.dataOffset, d.dataSize)) + delta))
          else inner.push(buf.subarray(d.offset, d.offset + d.size))
        }
        parts.push(element(ID.CUETRACKPOSITIONS, Buffer.concat(inner)))
      } else parts.push(buf.subarray(c.offset, c.offset + c.size))
    }
    points.push(element(ID.CUEPOINT, Buffer.concat(parts)))
  }
  return element(ID.CUES, Buffer.concat(points))
}

/**
 * @param {{ src: string, spanBytes: number, cues: boolean, out: string }} o
 * @returns {Promise<{ bytes: number, hasCues: boolean, firstClusterOffset: number, cuesOffset: number|null }>}
 */
export async function makeSparseWebm({ src, spanBytes, cues, out }) {
  const buf = await fs.readFile(src)
  const top = parseElements(buf, 0, buf.length)
  const ebml = top.find((e) => e.id === ID.EBML); const seg = top.find((e) => e.id === ID.SEGMENT)
  if (!ebml || !seg) throw new Error('ebml: EBML header + Segment required')
  const children = parseElements(buf, seg.dataOffset, seg.dataOffset + seg.dataSize)
  const hasCues = children.some((e) => e.id === ID.CUES)
  if (cues && !hasCues) throw new Error('webm: source has no Cues element (build it without -live 1)')
  if (!cues && hasCues) throw new Error('webm: source has Cues but a no-Cues fixture was requested (build the source with -live 1)')
  const firstCluster = children.findIndex((e) => e.id === ID.CLUSTER)
  if (firstCluster < 0) throw new Error('webm: no Cluster')
  for (const e of children) if (![ID.SEEKHEAD, ID.INFO, ID.TRACKS, ID.CLUSTER, ID.CUES, ID.VOID, ID.TAGS].includes(e.id)) throw new Error(`webm: unsupported Segment child 0x${e.id.toString(16)}`)
  const segStart = seg.dataOffset
  // ตำแหน่งใน SeekHead/Cues เป็น "สัมพัทธ์กับจุดเริ่มข้อมูลของ Segment" — เราสร้างข้อมูล Segment ใหม่เป็นชิ้น ๆ แล้วคำนวณ offset ใหม่
  const voidHeader = Buffer.concat([encodeId(ID.VOID), encodeSize8(spanBytes - 9)])
  const voidTotal = spanBytes // header 9 + payload (spanBytes − 9) sparse
  // ผ่านที่ 1: ขนาดใหม่ของ SeekHead (ค่า 8 ไบต์คงที่) เพื่อคำนวณ delta ของทุกอย่างหลังมัน
  const seekHeadEl = children.find((e) => e.id === ID.SEEKHEAD)
  const cuesEl = children.find((e) => e.id === ID.CUES)
  const seekDelta = seekHeadEl ? rebuildSeekHead(buf, seekHeadEl, (p) => p).length - seekHeadEl.size : 0
  const posOf = (idx) => children[idx].offset - segStart
  const voidAt = posOf(firstCluster) // ตำแหน่ง Void (สัมพัทธ์ segment) ในไฟล์ต้นทาง
  // delta สำหรับตำแหน่ง p (สัมพัทธ์ segment เดิม): หลัง SeekHead +seekDelta; ที่/หลัง Cluster แรก +voidTotal ด้วย
  const cuesDelta = cuesEl ? rebuildCues(buf, cuesEl, 0).length - cuesEl.size : 0
  const remap = (p) => {
    let q = p
    if (seekHeadEl && p > seekHeadEl.offset - segStart) q += seekDelta
    if (p >= voidAt) q += voidTotal
    if (cuesEl && p > cuesEl.offset - segStart) q += cuesDelta
    return q
  }
  const parts = []
  let cuesOffset = null, firstClusterOffset = null
  const segParts = []
  for (let i = 0; i < children.length; i += 1) {
    const e = children[i]
    if (i === firstCluster) segParts.push({ buf: voidHeader, sparse: spanBytes - 9 })
    if (e.id === ID.SEEKHEAD) segParts.push({ buf: rebuildSeekHead(buf, e, remap) })
    else if (e.id === ID.CUES) segParts.push({ buf: rebuildCues(buf, e, voidTotal + (seekHeadEl ? seekDelta : 0)), mark: 'cues' })
    else segParts.push({ buf: buf.subarray(e.offset, e.offset + e.size), mark: i === firstCluster ? 'cluster' : null })
  }
  const segDataSize = segParts.reduce((n, p) => n + (p.buf?.length ?? 0) + (p.sparse ?? 0), 0)
  const segHeader = seg.unknownSize ? buf.subarray(seg.offset, seg.dataOffset) : Buffer.concat([encodeId(ID.SEGMENT), encodeSize8(segDataSize)])
  parts.push({ buf: buf.subarray(ebml.offset, ebml.offset + ebml.size) })
  parts.push({ buf: segHeader })
  let pos = ebml.size + segHeader.length
  for (const p of segParts) {
    if (p.mark === 'cues') cuesOffset = pos
    if (p.mark === 'cluster') firstClusterOffset = pos
    parts.push(p)
    pos += (p.buf?.length ?? 0) + (p.sparse ?? 0)
  }
  const bytes = await writeSparse(out, parts)
  return { bytes, hasCues, firstClusterOffset, cuesOffset }
}

/* ════════════════════════════════════════════════════════════════════════════
   verification
   ═══════════════════════════════════════════════════════════════════════════ */
/** โครงสร้าง + ffprobe ของ fixture — คืนข้อมูลดิบให้เทสต์ตัดสิน (ไม่ตัดสินเอง) */
export async function verifyFixture(path, { ffprobeBin = 'ffprobe', timeoutMs = 60_000 } = {}) {
  const st = await fs.stat(path)
  const fh = await open(path, 'r')
  const head = Buffer.alloc(Math.min(st.size, 4 * 1024 * 1024))
  await fh.read(head, 0, head.length, 0)
  const out = { bytes: st.size, blocks: st.blocks, allocatedBytes: st.blocks * 512, kind: null, boxes: null, elements: null, moovOffset: null, mdatOffset: null, moovSize: null, hasCues: null, cuesOffset: null, seekPositions: null, cuePositions: null }
  try {
    if (head.toString('latin1', 4, 8) === 'ftyp') {
      out.kind = 'mp4'
      // เดินกล่องบนสุดด้วยการอ่านเฉพาะ header (ไฟล์ใหญ่มาก)
      const boxes = []
      let off = 0
      while (off + 8 <= st.size) {
        const h = Buffer.alloc(16); await fh.read(h, 0, 16, off)
        let size = h.readUInt32BE(0); const type = h.toString('latin1', 4, 8); let header = 8
        if (size === 1) { size = Number(h.readBigUInt64BE(8)); header = 16 } else if (size === 0) size = st.size - off
        boxes.push({ type, offset: off, size, header })
        if (type === 'moov') { out.moovOffset = off; out.moovSize = size }
        if (type === 'mdat') out.mdatOffset = off
        off += size
        if (boxes.length > 64) break
      }
      out.boxes = boxes
    } else if (head.readUInt32BE(0) === ID.EBML) {
      out.kind = 'webm'
      const els = []
      const top = parseElementsFromFile(fh, st.size)
      const ebml = await top.next(); els.push(ebml.value)
      const seg = (await top.next()).value; els.push(seg)
      out.elements = els
      // children ของ Segment: อ่าน header ทีละตัว (ข้าม payload)
      const children = []
      let off = seg.dataOffset
      const end = seg.dataOffset + seg.dataSize
      while (off < end && children.length < 100_000) {
        const h = Buffer.alloc(16); await fh.read(h, 0, 16, off)
        const id = readVintId(h, 0); const size = readVintSize(h, id.length)
        const header = id.length + size.length
        const dataSize = size.value === UNKNOWN_SIZE ? end - (off + header) : size.value
        const el = { id: id.value, offset: off, header, dataOffset: off + header, dataSize, size: header + dataSize }
        children.push(el)
        if (id.value === ID.CUES) out.cuesOffset = off
        off += header + dataSize
      }
      out.segmentChildren = children.map((c) => ({ id: c.id, offset: c.offset, size: c.size }))
      out.hasCues = children.some((c) => c.id === ID.CUES)
      out.firstClusterOffset = children.find((c) => c.id === ID.CLUSTER)?.offset ?? null
      const seekHead = children.find((c) => c.id === ID.SEEKHEAD)
      if (seekHead) {
        const b = Buffer.alloc(seekHead.size); await fh.read(b, 0, b.length, seekHead.offset)
        out.seekPositions = []
        for (const seek of parseElements(b, seekHead.header, b.length)) {
          if (seek.id !== ID.SEEK) continue
          let sid = null, pos = null
          for (const c of parseElements(b, seek.dataOffset, seek.dataOffset + seek.dataSize)) {
            if (c.id === ID.SEEKID) sid = readVintId(b, c.dataOffset).value
            else if (c.id === ID.SEEKPOSITION) pos = Number(readUint(b, c.dataOffset, c.dataSize))
          }
          out.seekPositions.push({ id: sid, position: pos, absolute: seg.dataOffset + pos })
        }
      }
      const cues = children.find((c) => c.id === ID.CUES)
      if (cues) {
        const b = Buffer.alloc(cues.size); await fh.read(b, 0, b.length, cues.offset)
        out.cuePositions = []
        for (const cp of parseElements(b, cues.header, b.length)) {
          if (cp.id !== ID.CUEPOINT) continue
          for (const c of parseElements(b, cp.dataOffset, cp.dataOffset + cp.dataSize)) {
            if (c.id !== ID.CUETRACKPOSITIONS) continue
            for (const d of parseElements(b, c.dataOffset, c.dataOffset + c.dataSize)) if (d.id === ID.CUECLUSTERPOSITION) out.cuePositions.push(seg.dataOffset + Number(readUint(b, d.dataOffset, d.dataSize)))
          }
        }
      }
    }
  } finally { await fh.close() }
  const probe = await exec(ffprobeBin, ['-v', 'error', '-hide_banner', '-probesize', String(32 * 1024 * 1024), '-analyzeduration', '5000000', '-select_streams', 'v:0', '-show_streams', '-show_format', '-print_format', 'json', path], timeoutMs)
  let parsed = null
  try { parsed = JSON.parse(probe.stdout) } catch { parsed = null }
  out.ffprobe = { ok: probe.ok && Boolean(parsed?.streams?.length), format: parsed?.format?.format_name ?? null, durationSeconds: Number(parsed?.format?.duration ?? parsed?.streams?.[0]?.duration ?? NaN), streams: parsed?.streams?.length ?? 0, error: probe.ok ? null : (probe.err?.killed ? 'TIMEOUT' : probe.stderr.trim().split('\n').pop() ?? 'ffprobe failed') }
  return out
}
async function * parseElementsFromFile(fh, size) {
  let off = 0
  while (off < size) {
    const h = Buffer.alloc(16); await fh.read(h, 0, 16, off)
    const id = readVintId(h, 0); const s = readVintSize(h, id.length)
    const header = id.length + s.length
    const dataSize = s.value === UNKNOWN_SIZE ? size - (off + header) : s.value
    yield { id: id.value, offset: off, header, dataOffset: off + header, dataSize, size: header + dataSize }
    off += header + dataSize
  }
}
/** อ่านค่า ID ของ Cluster ที่ตำแหน่งสัมบูรณ์ — ใช้พิสูจน์ว่า CuePosition ชี้ไป Cluster จริง */
export async function idAt(path, absolute) {
  const fh = await open(path, 'r')
  try { const b = Buffer.alloc(4); await fh.read(b, 0, 4, absolute); return readVintId(b, 0).value } finally { await fh.close() }
}
export const EBML_IDS = Object.freeze({ ...ID })
