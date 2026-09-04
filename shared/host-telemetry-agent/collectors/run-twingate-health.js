#!/usr/bin/env node
// collectors/run-twingate-health.js — AEGIS Twingate connector collector · oneshot entry
//
// Run by aegis-twingate-health.timer as a Type=oneshot service. One
// `docker inspect`, one atomic file write, exit. A configuration error is fatal
// and visible in the journal; a Docker or container problem is NOT fatal — it is
// written into the evidence file as an explicit `reason`, which is exactly what
// Settings needs to show instead of a blank.
import { collectTwingateHealth, loadCollectorConfig, writeEvidenceFile } from './twingate-health.js'

let config
try {
  config = loadCollectorConfig()
} catch (err) {
  console.error('[aegis-twingate-health] refusing to run:', err.message)
  process.exit(1)
}

try {
  const evidence = await collectTwingateHealth(config)
  await writeEvidenceFile(config.outputPath, evidence)
  // Terse by design: the enums only. No container id, no image, no Docker
  // error text, and nothing that was not already published in the evidence.
  const { connector } = evidence
  const summary = connector.available
    ? `${connector.runtimeState} / ${connector.health}`
    : `unavailable (${connector.reason})`
  console.log(`[aegis-twingate-health] ${config.container}: ${summary}`)
} catch (err) {
  console.error('[aegis-twingate-health] failed to write evidence:', err.message)
  process.exit(1)
}
