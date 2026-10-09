// Blocking output stays on this dedicated worker, never the Boot event loop.
import { parentPort } from 'node:worker_threads'
import { writeSync } from 'node:fs'

let count = 0
const stop = setTimeout(() => parentPort.close(), 300_000)
parentPort.on('message', line => {
  if (count++ >= 128 || typeof line !== 'string' || Buffer.byteLength(line) > 2048) return
  try { writeSync(2, `${line}\n`) } catch { /* diagnostics are best effort */ }
  if (count >= 128) { clearTimeout(stop); parentPort.close() }
})
