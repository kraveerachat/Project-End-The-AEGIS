import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../server/config.js'

// PR11 Phase 2B overlay contract.
//
// Phase 2B enables the machine listener. The accepted design says it changes
// exactly one value of the Phase 2A overlay, so the Production file at
// /opt/aegis/runtime/idea3/idea3-phase2.yml can be replaced in place, the HUB
// Compose list stays the two accepted files, and the rendered HUB service does
// not change at all — only idea3-web is recreated.
//
// The risk this suite exists for is drift between the two overlays: if anything
// other than the dispatch switch differs, the Phase 2B window would silently
// change the container's hardening, network, secrets or image while everyone
// believes it only flipped a flag. dockerContainerContract.test.js pins the
// Phase 2A file; this file pins the relationship between the two.
const WEB_ROOT = process.cwd()
const OVERLAY_2A = path.join(WEB_ROOT, '..', 'deploy', 'docker-compose.pr11-phase2.yml')
const OVERLAY_2B = path.join(WEB_ROOT, '..', 'deploy', 'docker-compose.pr11-phase2b.yml')

const linesOf = (file) => readFileSync(file, 'utf8').split('\n')

describe('PR11 Phase 2B dispatch overlay', () => {
  it('P2B-1: differs from the Phase 2A overlay only by the phase label and the dispatch switch', () => {
    const a = linesOf(OVERLAY_2A)
    const b = linesOf(OVERLAY_2B)
    expect(b.length).toBe(a.length)

    const changed = a
      .map((line, index) => ({ index, from: line, to: b[index] }))
      .filter(({ from, to }) => from !== to)

    expect(changed.map(({ from, to }) => [from.trim(), to.trim()])).toEqual([
      ['PHASE: 2A', 'PHASE: 2B'],
      ['AEGIS_IDEA3_DISPATCH_ENABLED: "false"', 'AEGIS_IDEA3_DISPATCH_ENABLED: "true"'],
    ])
  })

  it('P2B-2: keeps every hardening, network, secret and image property identical', () => {
    // Compared as text, because these are the exact bytes Compose will read.
    const pinned = [
      'image: aegis-idea3-web:pr11-phase2-dbc9ad92cd3e',
      'pull_policy: never',
      'AEGIS_BIND_HOST: 172.31.243.3',
      'AEGIS_WEB_TRUSTED_PROXY: 172.31.243.2',
      'AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY: 172.31.243.2',
      'AEGIS_IDEA3_DISPATCH_HOST: 172.31.243.3',
      'AEGIS_IDEA3_DISPATCH_PORT: "8004"',
      'AEGIS_IDEA3_DISPATCH_EXPECTED_SUBJECT: idea3-core',
      'SESSION_SECRET_FILE: /run/secrets/idea3_session_secret',
      'AEGIS_IDEA3_ADMIN_PASSWORD_HASH_FILE: /run/secrets/idea3_admin_password_hash',
      'user: "1000:1000"',
      'read_only: true',
      'no-new-privileges:true',
      'ipv4_address: 172.31.243.3',
      'ipv4_address: 172.31.243.2',
      'subnet: 172.31.243.0/29',
      'gateway: 172.31.243.1',
      'internal: true',
      'attachable: false',
    ]
    const source = readFileSync(OVERLAY_2B, 'utf8')
    for (const needle of pinned) expect(source).toContain(needle)

    // Still no published port, and still no secret value inline.
    expect(source).not.toMatch(/^\s*ports:/m)
    expect(source).not.toMatch(/^\s*SESSION_SECRET:/m)
    expect(source).not.toMatch(/^\s*AEGIS_IDEA3_ADMIN_PASSWORD_HASH:/m)
    expect(source).not.toMatch(/-----BEGIN/)
  })

  it('P2B-3: the Production path and the ownership split are unchanged', () => {
    const source = readFileSync(OVERLAY_2B, 'utf8')
    // Same Production file name: Phase 2B replaces the file in place, so the
    // accepted two-file HUB Compose list never changes.
    expect(source).toContain('PRODUCTION_PATH: /opt/aegis/runtime/idea3/idea3-phase2.yml')
    expect(source).toContain('PHASE: 2B')
    expect(source).toContain('IDEA3_WEB_SERVICE_OWNER: music')
    expect(source).toContain('NETWORK_AND_HUB_MEMBERSHIP_OWNER: kraveerachat')
    expect(source).toContain('PRODUCTION_MUTATION_AUTHORIZED: "NO"')
  })

  it('P2B-4: the Phase 2B environment passes the production loader with dispatch enabled', () => {
    // Extract the service environment the same way an operator would read it.
    const source = readFileSync(OVERLAY_2B, 'utf8')
    const block = source.slice(source.indexOf('environment:'), source.indexOf('secrets:'))
    const env = Object.fromEntries(
      block
        .split('\n')
        .map((line) => /^\s{6}([A-Z0-9_]+):\s*(.*)$/.exec(line))
        .filter(Boolean)
        .map(([, key, value]) => [key, value.replace(/^"(.*)"$/, '$1')]),
    )
    expect(env.AEGIS_IDEA3_DISPATCH_ENABLED).toBe('true')

    const config = loadConfig({
      ...env,
      // Local fixtures stand in for the in-container /run/secrets paths.
      SESSION_SECRET: 'S3cure!ProductionSessionSecret-2026',
      AEGIS_IDEA3_ADMIN_PASSWORD_HASH: '$2b$12$lQ3edrbcQxKq1sNMxX8bzuC/2IAHW5LExZtuJ21rUpMdjB3pN6cYy',
      SESSION_SECRET_FILE: undefined,
      AEGIS_IDEA3_ADMIN_PASSWORD_HASH_FILE: undefined,
    })
    expect(config.dispatch).toEqual({
      enabled: true,
      host: '172.31.243.3',
      port: 8004,
      trustedProxy: '172.31.243.2',
      expectedSubject: 'idea3-core',
    })
    // The browser side is untouched by Phase 2B.
    expect(config.webBasePath).toBe('/security')
    expect(config.webTrustedProxy).toBe('172.31.243.2')
    expect(config.production).toBe(true)
  })
})
