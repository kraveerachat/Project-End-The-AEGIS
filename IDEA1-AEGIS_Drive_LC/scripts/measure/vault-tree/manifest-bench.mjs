// scripts/measure/vault-tree/manifest-bench.mjs — PR #157 Phase 0 Task 0.1 · Node runner
//
// ⚠️ DISPOSABLE. Not part of npm test or the Vite build. Run with --expose-gc for
//    heap deltas:  node --expose-gc scripts/measure/vault-tree/manifest-bench.mjs --out <file.md>
//
// Usage:
//   node --expose-gc scripts/measure/vault-tree/manifest-bench.mjs [--out path] [--quick]
//   --quick limits the grid to nodes ≤ 10 000 (smoke run)
import fs from 'node:fs'
import os from 'node:os'
import { NODE_COUNTS, DEPTHS, NAME_BYTES, measureCell, toMarkdownTable } from './bench-core.js'

const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
const outPath = outIdx >= 0 ? args[outIdx + 1] : null
const quick = args.includes('--quick')

const memory = globalThis.gc
  ? async () => { globalThis.gc(); await new Promise((r) => setTimeout(r, 20)); return process.memoryUsage().heapUsed }
  : null

const rows = []
for (const nodes of NODE_COUNTS) {
  if (quick && nodes > 10_000) continue
  for (const depth of DEPTHS) {
    for (const nameBytes of NAME_BYTES) {
      // 50 000 nodes × 1 024-byte names is ~55 MB of plaintext — measured, but only once.
      const cell = await measureCell({ nodes, depth, nameBytes, memory })
      rows.push(cell)
      process.stderr.write(`nodes=${nodes} depth=${depth} name=${nameBytes} enc=${cell.encodedBytes} pad=${cell.paddedBytes} d+v=${cell.decryptValidateMs}ms heap=${cell.heapDeltaMB}\n`)
    }
  }
}

const header = [
  `## Node bench — ${new Date().toISOString()}`,
  '',
  `- host: ${os.platform()} ${os.release()} ${os.arch()}; cpu: ${os.cpus()[0]?.model ?? 'unknown'}; ram: ${Math.round(os.totalmem() / 1_073_741_824)} GiB`,
  `- node: ${process.version}; gc exposed: ${Boolean(globalThis.gc)}`,
  `- command: node ${globalThis.gc ? '--expose-gc ' : ''}scripts/measure/vault-tree/manifest-bench.mjs${quick ? ' --quick' : ''}`,
  '- times are single-run wall-clock ms (performance.now); heapDeltaMB = heapUsed after − before one cell with gc() before each sample',
  '',
].join('\n')
const md = header + toMarkdownTable(rows) + '\n'
if (outPath) fs.writeFileSync(outPath, md)
else process.stdout.write(md)
