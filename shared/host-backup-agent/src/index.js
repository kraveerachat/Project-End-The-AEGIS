#!/usr/bin/env node
// src/index.js — AEGIS host backup agent · process entry
//
// Run under systemd as User=aegis-backup. A failure to load the static config
// is fatal by design: an agent that starts without knowing its targets would
// publish a socket that can only ever answer NOT_CONFIGURED, and an operator
// would waste time on Drive when the problem is on the host.
import { createAgent } from './agent.js'

let agent
try {
  agent = await createAgent()
  await agent.start()
  console.log(`[aegis-backup] listening on ${agent.config.socketPath} (${agent.config.targets.length} allowlisted target(s))`)
} catch (err) {
  console.error('[aegis-backup] failed to start:', err.message)
  process.exit(1)
}

const shutdown = (signal) => {
  agent.stop()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[aegis-backup] shutdown failed after ${signal}:`, err.message)
      process.exit(1)
    })
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
