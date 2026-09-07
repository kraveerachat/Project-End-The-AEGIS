// src/agent.js — AEGIS host telemetry agent · assembly
//
// Construction is side-effect free on purpose: nothing samples and nothing
// binds until start() is called, so the wiring can be asserted in a test
// without a socket or a real /proc.
import { loadAgentConfig } from './config.js'
import { createSampler } from './sampler.js'
import { createTelemetryServer } from './server.js'
import { createFileReaders } from './sources.js'

/**
 * Build the complete agent from the environment.
 *
 * @param {{ env?: NodeJS.ProcessEnv, readFile?: Function }} [options]
 */
export function createAgent({ env = process.env, readFile } = {}) {
  const config = loadAgentConfig(env)
  const readers = createFileReaders(config.sources, readFile ? { readFile } : {})
  const sampler = createSampler({
    intervalMs: config.intervalMs,
    interfaceName: config.interfaceName,
    readers,
  })
  const server = createTelemetryServer({
    sampler,
    socketPath: config.socketPath,
    socketMode: config.socketMode,
  })

  return {
    config,
    sampler,
    server,
    async start() {
      sampler.start()
      await server.start()
    },
    async stop() {
      sampler.stop()
      await server.stop()
    },
  }
}
