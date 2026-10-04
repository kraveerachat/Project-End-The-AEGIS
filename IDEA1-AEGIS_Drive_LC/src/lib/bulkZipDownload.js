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
import { createBufferedSink, MAX_BUFFERED_PLAINTEXT_BYTES } from './vaultChunkedDownload.js'

const ZIP_PICKER_TYPES = [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }]

const isQuota = (err) => err?.name === 'QuotaExceededError'
const writeReason = (err) => (isQuota(err) ? 'localDiskFull' : 'write')

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
  createBufferedSink: makeBufferedSink = createBufferedSink, createRateEstimator, clock = () => globalThis.performance?.now?.() ?? Date.now(),
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
    const buffered = plan.transport === 'buffered'
    let handle = null
    if (!buffered) {
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
    if (buffered) {
      target = makeBufferedSink({ limitBytes: MAX_BUFFERED_PLAINTEXT_BYTES })
    } else {
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
    emit('done', { done: true })
    return buffered ? { status: 'done', parts } : { status: 'done' }
  }
}
