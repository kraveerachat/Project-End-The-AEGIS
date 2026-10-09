// src/lib/bulkZipDownload.js — AEGIS Drive (IDEA1) · ZIP หลายไฟล์แบบสตรีม: orchestrator + แหล่งข้อมูล
//
// ⚠️ ไฟล์นี้คือที่เดียวที่ถือ "ลำดับที่ความปลอดภัยขึ้นอยู่กับมัน" (spec §13, §16–§20):
//    ตัวเลือกไฟล์ (await แรก ยังอยู่ใน user gesture) → hasher → pre-flight → effective plan
//    → createWritable → ต่อรายการ: open → addEntry (ไบต์แรกของ local header) → pump → ปิดรายการ
//    → finish → ตรวจ signal/isPurged ครั้งสุดท้าย → close()
// ⚠️ ความล้มเหลวใด ๆ ก่อน close() เริ่ม = abort() หนึ่งครั้ง และไม่เคย close() — ZIP ที่ขาดไฟล์แต่เปิดได้
//    คือคำโกหกที่แย่ที่สุด เพราะผู้ใช้จะไม่รู้ว่ามันไม่ครบ
// ⚠️ หลัง pre-flight ทุกขนาด/ความยาว/ความคืบหน้าอ่านจาก effective plan เท่านั้น (SC-4) — ขนาดชั่วคราว
//    ของแผนเดิมไม่มีวันถูกใช้นับไบต์
import { createZipStreamWriter } from './zipStreamWriter.js'
import { zipLayout } from './bulkDownloadPlan.js'
import {
  authenticateVaultV2Entry, createBufferedSink, downloadVaultV2, MAX_BUFFERED_PLAINTEXT_BYTES,
} from './vaultChunkedDownload.js'
import { apiFetchStream } from './api.js'
import { openWorkerStreamSink } from './downloadStreamSession.js'

const ZIP_PICKER_TYPES = [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }]

const isQuota = (err) => err?.name === 'QuotaExceededError'
// BUFFER_LIMIT = ตัวกันหลังสุดของทางบัฟเฟอร์ (spec §14): archive เกินเพดานนโยบาย ไม่ใช่ดิสก์เสีย
const writeReason = (err) => (isQuota(err) ? 'localDiskFull' : err?.code === 'BUFFER_LIMIT' ? 'too-large' : 'write')

/**
 * ทางสำรองของเบราว์เซอร์ที่ไม่มี File System Access: ประกอบ archive ที่บัฟเฟอร์ไว้ (≤ 64 MiB) เป็น Blob
 * แล้วให้เบราว์เซอร์ดาวน์โหลดผ่าน anchor
 * ⚠️ ที่เดียวในโมดูล ZIP ที่อนุญาตให้สร้าง Blob ทั้งก้อน (spec §15 allow-list) — ขนาดถูกจำกัดก่อนถึงตรงนี้แล้ว
 * ⚠️ Vault: URL ถูกลงทะเบียนกับ unlockedState เพื่อให้การล็อกเพิกถอนมันทันที
 */
export function finalizeBufferedZip(parts, name, { registerObjectUrl } = {}) {
  const url = URL.createObjectURL(new Blob(parts, { type: 'application/zip' }))
  registerObjectUrl?.(url)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * ดาวน์โหลดหลายไฟล์เป็น ZIP เดียว
 *
 * ⚠️ ห้ามมี await ใดก่อน showSaveFilePicker ในฟังก์ชันนี้ และผู้เรียกต้องเรียกจาก click (Files) หรือ
 *    Confirm (Vault) โดยตรง — งานก่อนตัวเลือกไฟล์มีแค่ตรวจ busy / isPurged / signal แบบซิงโครนัส
 *
 * @returns {Promise<{ status: 'done'|'failed'|'cancelled'|'busy', reason?: string,
 *                     failedEntry?: { index: number, name: string }, parts?: Uint8Array[] }>}
 */
export async function runBulkZip({
  plan, source, scope = globalThis, busyRef, signal, isPurged = () => false, onProgress,
  createWriter = createZipStreamWriter, computeLayout = zipLayout, createHasher,
  createBufferedSink: makeBufferedSink = createBufferedSink, registerObjectUrl, createRateEstimator,
  createStreamDestination = openWorkerStreamSink,
  clock = () => globalThis.performance?.now?.() ?? Date.now(),
}) {
  if (busyRef?.current) return { status: 'busy' }
  if (signal?.aborted || isPurged()) return { status: 'cancelled' }
  if (busyRef) busyRef.current = true
  try {
    return await archive()
  } finally {
    if (busyRef) busyRef.current = false
  }

  async function archive() {
    // transport: 'fsa' (ค่าเริ่มต้น — เส้นทางเดิมไม่เปลี่ยน) | 'worker-stream' | 'buffered'
    const workerStream = plan.transport === 'worker-stream'
    let buffered = plan.transport === 'buffered'
    const fsa = !buffered && !workerStream
    let handle = null
    if (fsa) {
      try {
        handle = await scope.showSaveFilePicker({ suggestedName: plan.suggestedName, types: ZIP_PICKER_TYPES })
      } catch (err) {
        return err?.name === 'AbortError' ? { status: 'cancelled' } : { status: 'failed', reason: 'picker' }
      }
    }

    /* ── ความคืบหน้า: ตัวเลขทุกตัวมาจากไบต์ที่เขียนจริง ไม่มีตัวจับเวลาขยับแถบเอง ── */
    let totalBytes = 0
    let transferred = 0
    let lastPercent = 0
    let current = { index: 0, count: plan.entries.length, name: null }
    const rate = createRateEstimator?.()
    const emit = (stage, { done = false } = {}) => {
      let percent = totalBytes === 0 ? 0 : Math.floor((transferred / totalBytes) * 1000) / 10
      percent = done ? 100 : Math.min(99.9, Math.max(lastPercent, percent))
      lastPercent = percent
      onProgress?.({
        kind: 'download', stage, ...current, transferredBytes: transferred, totalBytes, percent,
        rate: rate ? rate.sample(transferred, clock(), { totalBytes }) : null,
      })
    }
    emit('preparing')

    /* ── ปลายทางของ archive: บันทึกข้อผิดพลาดการเขียนครั้งแรกไว้ — แหล่งข้อมูลบางตัว (downloadVaultV2)
          กลืนข้อผิดพลาดของ sink เป็น 'failed' แต่ "ดิสก์เต็ม" ต้องยังรายงานเป็นดิสก์เต็ม ── */
    let target = null
    let firstWriteError = null
    const archiveSink = {
      async write(bytes) {
        if (firstWriteError) throw firstWriteError
        try {
          await target.write(bytes)
        } catch (err) {
          firstWriteError ??= err
          throw err
        }
      },
    }
    let abortAttempted = false
    const abortOnce = async () => {
      if (abortAttempted || !target) return
      abortAttempted = true
      try { await target.abort?.() } catch { /* ปลายทางอาจปิด/ตายไปแล้ว — ยังต้องรายงานล้มเหลว */ }
    }
    const cancelledNow = () => Boolean(signal?.aborted) || isPurged()
    const failed = async (reason, index = null) => {
      await abortOnce()
      if (cancelledNow() || reason === 'cancelled') return { status: 'cancelled' }
      const finalReason = firstWriteError ? writeReason(firstWriteError) : reason
      const res = { status: 'failed', reason: finalReason }
      if (index !== null) res.failedEntry = { index, name: plan.entries[index]?.name ?? null }
      return res
    }

    const writer = createWriter({ sink: archiveSink, createHasher, now: new Date() })
    try {
      await writer.begin()
    } catch {
      return failed('write')
    }
    if (cancelledNow()) return failed('cancelled')

    /* ── pre-flight (Vault): พิสูจน์ซองทุกใบก่อนเปิดปลายทาง แล้วได้ effective plan ใบใหม่ ── */
    let effectivePlan = plan
    if (source.preflight) {
      let pre
      try {
        pre = await source.preflight(plan, signal)
      } catch {
        pre = { ok: false, reason: 'failed' }
      }
      if (!pre?.ok) return failed(pre?.reason ?? 'failed', Number.isInteger(pre?.index) ? pre.index : null)
      effectivePlan = pre.effectivePlan
    }
    if (effectivePlan.entries.length !== plan.entries.length) return failed('integrity')
    const layout = computeLayout(effectivePlan.entries)
    totalBytes = effectivePlan.entries.reduce((s, e) => s + e.size, 0)
    // ⚠️ 64 MiB คือเพดานนโยบายของขนาด archive ที่บัฟเฟอร์ ไม่ใช่การรับประกันหน่วยความจำของโปรเซส
    if (buffered && layout.total > MAX_BUFFERED_PLAINTEXT_BYTES) return failed('too-large')
    if (cancelledNow()) return failed('cancelled')

    /* ── เปิดปลายทาง — หลังพิสูจน์ทุกอย่างแล้วเท่านั้น ── */
    if (workerStream) {
      // ไม่มีตัวเลือกไฟล์ ไม่มี Blob ทั้งก้อน: ไบต์ไหลผ่าน Service Worker ตัวเดิมไปที่ตัวจัดการดาวน์โหลดของเบราว์เซอร์
      let opened
      try {
        opened = await createStreamDestination({
          filename: plan.suggestedName, totalBytes: layout.total, source: plan.source, signal,
        })
      } catch {
        opened = null
      }
      if (opened?.ok) {
        target = opened.sink
      } else if (cancelledNow() || opened?.reason === 'cancelled') {
        return { status: 'cancelled' }
      } else if (layout.total <= MAX_BUFFERED_PLAINTEXT_BYTES) {
        // ยังไม่มีไบต์ใดถูกเขียน — archive เล็กพอสำหรับทางบัฟเฟอร์เดิมภายใต้เพดาน 64 MiB เดิม
        buffered = true
      } else {
        return { status: 'failed', reason: 'stream-unavailable' }
      }
    }
    if (buffered) {
      target = makeBufferedSink({ limitBytes: MAX_BUFFERED_PLAINTEXT_BYTES })
    } else if (fsa) {
      try {
        target = await handle.createWritable()
      } catch {
        return { status: 'failed', reason: 'destination' }
      }
    }

    const entries = effectivePlan.entries
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]
      if (cancelledNow()) return failed('cancelled', i)
      current = { index: i + 1, count: entries.length, name: plan.entries[i]?.name ?? entry.name }
      emit('archiving')

      let opened
      try {
        opened = await source.open(entry, signal)
      } catch {
        opened = { ok: false, reason: 'failed' }
      }
      if (!opened?.ok) return failed(opened?.reason ?? 'failed', i)

      // ⚠️ ตั้งแต่ open() สำเร็จ ตัวจัดการเป็นของ orchestrator จนรายการปิดสำเร็จ — ล้มเมื่อไร dispose ครั้งเดียว
      let disposed = false
      const fail = async (reason) => {
        if (!disposed) {
          disposed = true
          try { opened.dispose?.(reason) } catch { /* ทำความสะอาดแบบพยายามที่สุด */ }
        }
        return failed(reason, i)
      }

      if (opened.size !== entry.size) return fail('size-mismatch')
      if (cancelledNow()) return fail('cancelled')

      let entrySink
      try {
        entrySink = await writer.addEntry({ name: entry.name, size: entry.size })
      } catch (err) {
        return fail(writeReason(firstWriteError ?? err))
      }
      const countingSink = {
        async write(bytes) {
          await entrySink.write(bytes)
          transferred += bytes.length
          if (bytes.length > 0) emit('archiving')
        },
        close: () => entrySink.close(),
        abort: () => entrySink.abort(),
      }

      let res
      try {
        res = await opened.pump(countingSink, signal)
      } catch (err) {
        res = { ok: false, reason: isQuota(firstWriteError ?? err) ? 'localDiskFull' : 'failed' }
      }
      if (!res?.ok) return fail(res?.reason ?? 'failed')
      try {
        await entrySink.close()
      } catch (err) {
        return fail(writeReason(firstWriteError ?? err))
      }
    }

    try {
      await writer.finish()
    } catch (err) {
      return failed(writeReason(firstWriteError ?? err))
    }

    // ⚠️ ยกเลิก/ล็อกหลังระเบียนสุดท้ายแต่ก่อน close() = ต้อง abort ไม่ใช่ประกาศว่าสำเร็จ
    if (cancelledNow()) return failed('cancelled')

    // ตั้งแต่ตรงนี้ การยกเลิกรับประกันไม่ได้แล้วว่าเบราว์เซอร์จะไม่ commit ไฟล์ — UI ซ่อนปุ่ม Cancel (spec §17, §20)
    emit('finalizing')
    let parts
    try {
      parts = await target.close()
    } catch (err) {
      await abortOnce()
      return { status: 'failed', reason: isQuota(err) ? 'localDiskFull' : 'finalizeFailed' }
    }
    if (buffered) {
      // ทางบัฟเฟอร์: สำเร็จเชิงตรรกะ = สร้าง Blob และสั่งดาวน์โหลดแล้ว (การบันทึกจริงเป็นของเบราว์เซอร์)
      try {
        finalizeBufferedZip(parts, plan.suggestedName, { registerObjectUrl })
      } catch {
        return { status: 'failed', reason: 'finalizeFailed' }
      }
    }
    emit('done', { done: true })
    return { status: 'done' }
  }
}

/* ── Normal Files source (spec §10) ─────────────────────────────────── */

const SOURCE_IDLE_MS = 60_000

/** ค่าที่ wait() คืนเมื่อ "หยุด" ชนะ — แยกจากผลของ promise ใด ๆ ได้แน่นอน */
export const STOPPED = Symbol('stopped')

/**
 * ประตูหยุดที่ไม่ค้างการสมัครรับ: แต่ละ wait() สมัครรับการหยุด "เฉพาะช่วงที่ promise ของมันยังค้าง"
 * แล้วถอดตัวเองทันทีที่จบ ไม่ว่าฝั่งไหนชนะ
 *
 * ⚠️ ห้ามใช้ Promise.race([x, stopped]) กับ promise ที่อายุยาวกว่า x: race แต่ละครั้งทิ้ง reaction ไว้บน
 *    `stopped` จนกว่ามันจะ settle — ถ้าการอ่านทุกก้อนทำแบบนั้น ทุก chunk ที่อ่านสำเร็จจะถูกอ้างถึงค้างไว้
 *    จนจบรายการ หน่วยความจำจึงโตตามขนาดไฟล์ (เคยวัดได้ ~1.25 GiB บนไฟล์ 1.1 GiB; spec §15 / A11)
 */
export function createStopGate() {
  const waiters = new Set()
  let stopped = false
  return {
    get stopped() { return stopped },
    get activeWaiters() { return waiters.size },
    stop() {
      if (stopped) return
      stopped = true
      const pending = [...waiters]
      waiters.clear()
      for (const w of pending) w()
    },
    /** ผลของ promise หรือ STOPPED ถ้าหยุดก่อน; promise ที่ reject หลังหยุดแล้วถูกกลืน (ไม่มี unhandled rejection) */
    wait(promise) {
      if (stopped) {
        Promise.resolve(promise).catch(() => {})
        return Promise.resolve(STOPPED)
      }
      return new Promise((resolve, reject) => {
        const onStop = () => resolve(STOPPED)
        waiters.add(onStop)
        Promise.resolve(promise).then(
          (value) => { waiters.delete(onStop); resolve(value) },
          (err) => { waiters.delete(onStop); reject(err) },
        )
      })
    },
  }
}
const httpReason = (kind) => (kind === 'network' || kind === 'unauthorized' || kind === 'forbidden' ? kind : 'server')

/**
 * แหล่งข้อมูลของไฟล์ปกติ แบบสองจังหวะ (SC-1):
 *   open()  — ขอไฟล์, ตรวจผล HTTP, body ต้องมี, Content-Length ต้องมีและเท่ากับขนาดในรายการ
 *             ⚠️ ไม่เขียนอะไรลง ZIP เลย — รายการที่ล้มตรงนี้จึงไม่มี local header แม้แต่ไบต์เดียว
 *   pump()  — อ่านทีละก้อนจาก reader แล้วเขียนลง entry sink (CRC อยู่ในตัวเขียนเท่านั้น, M-6)
 *
 * ตัวจับเวลา "ต้นทางเงียบ" 60 วินาที วัดเฉพาะช่วงที่รอเครือข่าย (รอ header และรอ read()) — ถูกล้างทันที
 * ที่ได้ไบต์จริงก่อนเขียนลงปลายทาง ดิสก์ที่ช้าจึงไม่กินงบเวลาของเครือข่าย ไม่มีเพดานเวลารวมของการโอน
 */
export function createFilesEntrySource({ fetchStream = apiFetchStream, idleMs = SOURCE_IDLE_MS, stopGate = createStopGate } = {}) {
  return {
    async open(entry, archiveSignal) {
      const fetchCtrl = new AbortController()
      let reader = null
      let timer = null
      let reason = null
      const gate = stopGate()

      // ⚠️ ทางออกเดียวของทุกความล้มเหลว — ซิงโครนัสทั้งหมด และไม่เคย await reader.cancel()
      //    (cancel ที่ค้างไม่มีวันจบต้องไม่ทำให้ archive ค้างตาม)
      const cleanup = (why) => {
        if (reason) return
        reason = why
        if (timer !== null) { clearTimeout(timer); timer = null }
        archiveSignal?.removeEventListener?.('abort', onArchiveAbort)
        fetchCtrl.abort(why)
        if (reader) {
          try { reader.cancel(why)?.catch?.(() => {}) } catch { /* ทำความสะอาดแบบพยายามที่สุด */ }
        }
        gate.stop()
      }
      const onArchiveAbort = () => cleanup('cancelled')
      const arm = () => {
        if (timer === null) timer = setTimeout(() => { timer = null; cleanup('timeout') }, idleMs)
      }
      const disarm = () => {
        if (timer !== null) { clearTimeout(timer); timer = null }
      }
      const failure = () => ({ ok: false, reason })

      if (archiveSignal?.aborted) { cleanup('cancelled'); return failure() }
      archiveSignal?.addEventListener?.('abort', onArchiveAbort, { once: true })

      arm()
      let res
      try {
        res = await gate.wait(fetchStream(`/api/files/${encodeURIComponent(entry.id)}/download`, { signal: fetchCtrl.signal }))
      } catch {
        res = { ok: false, errorKind: 'network' }
      }
      disarm()
      if (reason) return failure()
      if (!res?.ok) { cleanup(httpReason(res?.errorKind)); return failure() }
      if (res.body == null) { cleanup('stream-missing'); return failure() }

      // Content-Length: บังคับ ไม่มีข้อยกเว้น (spec §10 step 4)
      const raw = res.headers?.get?.('Content-Length')
      const text = raw == null ? null : String(raw).trim()
      const declared = text !== null && /^[0-9]+$/.test(text) ? Number(text) : NaN
      if (!Number.isSafeInteger(declared)) { cleanup('invalid-length'); return failure() }
      if (declared !== entry.size) { cleanup('size-mismatch'); return failure() }

      const body = res.body
      return {
        ok: true,
        size: declared,
        dispose: (why) => cleanup(why),
        async pump(entrySink) {
          if (reason) return failure()
          reader = body.getReader()
          let received = 0
          for (;;) {
            arm() // ศูนย์ไบต์ไม่ใช่ความคืบหน้า: ถ้าตั้งไว้แล้ว เส้นตายเดิมยังคงอยู่
            let r
            try {
              r = await gate.wait(reader.read())
            } catch {
              cleanup('network')
            }
            if (reason) return failure()
            if (r.done) {
              disarm()
              if (received !== declared) { cleanup('early-eof'); return failure() }
              try { reader.releaseLock?.() } catch { /* stream จบแล้ว */ }
              archiveSignal?.removeEventListener?.('abort', onArchiveAbort)
              return { ok: true }
            }
            const value = r.value
            if (!value || value.length === 0) continue
            received += value.length
            disarm() // ได้ไบต์จริงแล้ว — หยุดนับก่อนเขียนลงปลายทาง
            if (received > declared) { cleanup('overlong'); return failure() }
            try {
              await entrySink.write(value)
            } catch (err) {
              cleanup(isQuota(err) ? 'localDiskFull' : 'write')
              return failure()
            }
            if (reason) return failure()
          }
        },
      }
    },
  }
}

/* ── Private Vault V2 source (spec §11) ─────────────────────────────── */

const isSafeSize = (x) => Number.isSafeInteger(x) && x >= 0

/**
 * แหล่งข้อมูลของ Vault V2 แบบสองจังหวะ พร้อม pre-flight (SC-1, SC-4):
 *   preflight() — พิสูจน์ซองทุกใบ "ก่อน" createWritable จาก record ในหน่วยความจำ (ไม่มี network)
 *                 แล้วคืน effective plan ใบใหม่ที่ขนาดทุกรายการคือ plainSize ที่พิสูจน์แล้ว
 *   open()      — ไม่มี network; คืนขนาดที่พิสูจน์แล้ว
 *   pump()      — downloadVaultV2 กับ blob "ตัวเดียวกัน" ที่ pre-flight พิสูจน์ — ทุก chunk ผ่าน AEAD
 *                 ก่อนถึง entry sink เสมอ
 * ⚠️ ไม่มี DEK หรือ CryptoKey ใดถูกเก็บข้ามรายการ — downloadVaultV2 แกะ DEK ใหม่เองต่อรายการ
 */
export function createVaultV2EntrySource({
  kek, authenticate = authenticateVaultV2Entry, download = downloadVaultV2, isPurged = () => false,
}) {
  return {
    async preflight(plan, signal) {
      const effective = []
      for (let i = 0; i < plan.entries.length; i += 1) {
        if (signal?.aborted || isPurged()) return { ok: false, reason: 'cancelled', index: i }
        const entry = plan.entries[i]
        const auth = await authenticate({ kek, blob: entry.blob })
        if (!auth?.ok) return { ok: false, reason: 'wrong-key', index: i }
        // ⚠️ ไม่แปลงชนิด: "123", 1.5, -1, NaN หรือค่าที่หายไป คือซองที่เชื่อไม่ได้ ไม่ใช่ค่าที่ต้องซ่อม
        if (!isSafeSize(auth.plainSize)) return { ok: false, reason: 'integrity', index: i }
        if (entry.manifestPlainSize !== undefined
          && (!isSafeSize(entry.manifestPlainSize) || entry.manifestPlainSize !== auth.plainSize)) {
          return { ok: false, reason: 'integrity', index: i }
        }
        effective.push(Object.freeze({
          nodeId: entry.nodeId, name: entry.name, blobRef: entry.blobRef,
          blob: entry.blob, // วัตถุเดียวกับที่เพิ่งพิสูจน์ — ไม่ดึงใหม่จากเซิร์ฟเวอร์
          size: auth.plainSize,
        }))
      }
      if (signal?.aborted || isPurged()) return { ok: false, reason: 'cancelled', index: plan.entries.length - 1 }
      // แผนเดิมไม่ถูกแตะ; layout ชั่วคราวของแผนเดิมไม่ถูกส่งต่อ — orchestrator คำนวณใหม่จากขนาดที่พิสูจน์แล้ว
      const { layout: _provisionalLayout, ...rest } = plan
      return {
        ok: true,
        effectivePlan: Object.freeze({
          ...rest, entries: Object.freeze(effective), totalBytes: effective.reduce((s, e) => s + e.size, 0),
        }),
      }
    },
    async open(entry) {
      let finished = false
      return {
        ok: true,
        size: entry.size,
        dispose() { finished = true },
        async pump(entrySink, signal) {
          if (finished) return { ok: false, reason: 'cancelled' }
          const res = await download({ kek, blob: entry.blob, sink: entrySink, signal })
          finished = true
          if (!res?.ok) return { ok: false, reason: res?.reason ?? 'failed' }
          if (res.bytesWritten !== entry.size) return { ok: false, reason: 'size-mismatch' }
          return { ok: true }
        },
      }
    },
  }
}
