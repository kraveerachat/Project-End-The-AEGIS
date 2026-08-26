#!/usr/bin/env node
// src/index.js — AEGIS host telemetry agent · process entry
//
// Run under systemd as User=aegis-telemetry with no capabilities. A failure to
// start is fatal by design: a telemetry agent that half-starts would publish a
// socket nobody can read, or read sources nobody can serve.
import { createAgent } from './agent.js'

const agent = createAgent()

const shutdown = (signal) => {
  agent.stop()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[aegis-telemetry] shutdown failed after ${signal}:`, err.message)
      process.exit(1)
    })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

try {
  await agent.start()
  // Deliberately terse: no hostname, no paths beyond the configured socket, and
  // no environment. The journal is readable by more people than the socket is.
  console.log(`[aegis-telemetry] listening on ${agent.config.socketPath} (interface ${agent.config.interfaceName})`)
} catch (err) {
  console.error('[aegis-telemetry] failed to start:', err.message)
  process.exit(1)
}
