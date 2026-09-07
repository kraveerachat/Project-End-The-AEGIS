// src/agent.js — AEGIS host telemetry agent · assembly
//
// Construction is side-effect free on purpose: nothing samples and nothing
// binds until start() is called, so the wiring can be asserted in a test
// without a socket or a real /proc.
import fspDefault from 'node:fs/promises'

import { loadAgentConfig } from './config.js'
import { createSampler } from './sampler.js'
import { createTelemetryServer } from './server.js'
import { createFileReaders } from './sources.js'
import { readHostTemperature } from './thermal.js'

/**
 * Build the complete agent from the environment.
 *
 * @param {{ env?: NodeJS.ProcessEnv, readFile?: Function }} [options]
 */
export function createAgent({ env = process.env, readFile, readdir = fspDefault.readdir } = {}) {
  const config = loadAgentConfig(env)
  const readers = createFileReaders(config.sources, readFile ? { readFile } : {})
  // The thermal reader is assembled here rather than in sources.js because it
  // needs a directory listing, which that module deliberately cannot express.
  // It still routes every byte through the same injected readFile, so a test
  // that stubs readFile still sees every file this agent opens.
  readers.hostTemperature = () => readHostTemperature({
    readdir,
    readFile: readFile ?? fspDefault.readFile,
    root: config.thermalRoot,
  })
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
