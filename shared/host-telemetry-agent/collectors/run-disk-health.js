#!/usr/bin/env node
// collectors/run-disk-health.js — AEGIS host disk-health collector · oneshot entry
//
// Run by aegis-disk-health.timer as a Type=oneshot service. One smartctl run,
// one atomic file write, exit. A configuration error is fatal and visible in
// the journal; a device or tool problem is NOT fatal — it is written into the
// evidence file as an explicit `reason`, which is exactly what the Storage
// screen needs to show instead of a blank.
import { collectDiskHealth, loadCollectorConfig, writeEvidenceFile } from './disk-health.js'

let config
try {
  config = loadCollectorConfig()
} catch (err) {
  console.error('[aegis-disk-health] refusing to run:', err.message)
  process.exit(1)
}

try {
  const evidence = await collectDiskHealth(config)
  await writeEvidenceFile(config.outputPath, evidence)
  // Terse by design: no serial, no attribute dump, no paths beyond the one systemd set.
  const summary = evidence.disk.available
    ? `available (warnings: ${evidence.disk.warnings.length})`
    : `unavailable (${evidence.disk.reason})`
  console.log(`[aegis-disk-health] ${config.device}: ${summary}`)
} catch (err) {
  console.error('[aegis-disk-health] failed to write evidence:', err.message)
  process.exit(1)
}
