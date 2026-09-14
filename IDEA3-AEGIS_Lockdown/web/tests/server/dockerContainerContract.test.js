import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../server/config.js'

// PR11 Phase 2 container contract (design §4.7, §4.8). Static checks only: no
// image is built and no Compose model is rendered here. Vitest runs from
// IDEA3-AEGIS_Lockdown/web, as dispatchContract.test.js already relies on.
const WEB_ROOT = process.cwd()
const DOCKERFILE = path.join(WEB_ROOT, 'Dockerfile')
const DOCKERIGNORE = path.join(WEB_ROOT, '.dockerignore')
const OVERLAY = path.join(WEB_ROOT, '..', 'deploy', 'docker-compose.pr11-phase2.yml')

const IDEA3_SUBNET = ['172.31.243.0', 29]
const HUB_ADDRESS = '172.31.243.2'
const IDEA3_WEB_ADDRESS = '172.31.243.3'

/**
 * Read the small YAML subset the overlay uses: block mappings, block
 * sequences of scalars or of mappings, plain and quoted scalars, full-line
 * comments. Anything else (tabs, inline comments, flow collections, anchors,
 * aliases, tags, block scalars, escapes, duplicate keys, stray indentation)
 * fails closed instead of being guessed.
 */
function parseStrictYaml(source) {
  const lines = []
  source.split('\n').forEach((raw, index) => {
    const number = index + 1
    if (raw.includes('\t')) throw new Error(`tab at line ${number}`)
    const text = raw.trim()
    if (text === '' || text.startsWith('#')) return
    if (/\s#/.test(text)) throw new Error(`inline comment at line ${number}`)
    lines.push({ indent: raw.length - raw.trimStart().length, text, number })
  })

  let position = 0
  const MAPPING_ENTRY = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/
  const MAPPING_ITEM = /^[A-Za-z0-9_.-]+:(\s|$)/

  function scalar(text, number) {
    if (/^["']/.test(text)) {
      const quote = text[0]
      const body = text.slice(1, -1)
      if (text.length < 2 || !text.endsWith(quote) || body.includes(quote) || body.includes('\\')) {
        throw new Error(`unsupported quoted scalar at line ${number}`)
      }
      return body
    }
    if (/^[[{&*!|>%@`]/.test(text) || text === '---') throw new Error(`unsupported syntax at line ${number}`)
    if (text === 'true') return true
    if (text === 'false') return false
    return text
  }

  function block(indent) {
    if (lines[position].text.startsWith('- ')) {
      const items = []
      while (position < lines.length && lines[position].indent === indent && lines[position].text.startsWith('- ')) {
        const item = lines[position].text.slice(2).trim()
        if (MAPPING_ITEM.test(item)) {
          lines[position] = { ...lines[position], indent: indent + 2, text: item }
          items.push(block(indent + 2))
        } else {
          items.push(scalar(item, lines[position].number))
          position += 1
        }
      }
      return items
    }

    const mapping = {}
    while (position < lines.length && lines[position].indent === indent) {
      const { text, number } = lines[position]
      const match = MAPPING_ENTRY.exec(text)
      if (!match) throw new Error(`unsupported line ${number}: ${text}`)
      const [, key, rest] = match
      if (Object.hasOwn(mapping, key)) throw new Error(`duplicate key ${key} at line ${number}`)
      position += 1
      if (rest === undefined || rest === '') {
        if (position >= lines.length || lines[position].indent <= indent) throw new Error(`empty value at line ${number}`)
        mapping[key] = block(lines[position].indent)
      } else {
        mapping[key] = scalar(rest, number)
      }
    }
    return mapping
  }

  const document = block(0)
  if (position !== lines.length) throw new Error(`unexpected indentation at line ${lines[position].number}`)
  return document
}

function dockerInstructions(source) {
  return source
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const [op, ...rest] = line.split(/\s+/)
      return { op: op.toUpperCase(), args: rest.join(' ') }
    })
}

function inIdea3Subnet(address) {
  const subnet = new net.BlockList()
  subnet.addSubnet(IDEA3_SUBNET[0], IDEA3_SUBNET[1], 'ipv4')
  return net.isIPv4(address) && subnet.check(address, 'ipv4')
}

describe('PR11 Phase 2 IDEA3 Web image', () => {
  const instructions = () => dockerInstructions(readFileSync(DOCKERFILE, 'utf8'))

  it('P2-D1: builds in one stage and runs production dependencies only, as the non-root node user', () => {
    const all = instructions()
    const froms = all.filter((instruction) => instruction.op === 'FROM').map((instruction) => instruction.args)
    expect(froms).toEqual(['${NODE_IMAGE} AS build', '${NODE_IMAGE} AS runtime'])

    const runtimeStart = all.findIndex((instruction) => instruction.op === 'FROM' && instruction.args.endsWith('AS runtime'))
    const build = all.slice(0, runtimeStart)
    const runtime = all.slice(runtimeStart)
    const runs = (stage) => stage.filter((instruction) => instruction.op === 'RUN').map((instruction) => instruction.args)

    expect(runs(build).some((command) => /\bnpm ci\b/.test(command) && !command.includes('--omit=dev'))).toBe(true)
    expect(runs(build).some((command) => /\bnpm run build\b/.test(command))).toBe(true)
    expect(runs(runtime).some((command) => /\bnpm ci --omit=dev\b/.test(command))).toBe(true)
    expect(runtime.filter((instruction) => instruction.op === 'COPY').map((instruction) => instruction.args)).toEqual([
      'package.json package-lock.json ./',
      'server ./server',
      '--from=build /app/dist ./dist',
    ])
    expect(runs(runtime).filter((command) => command.includes('chown'))).toEqual([
      'mkdir -p /var/lib/aegis-idea3/data && chown node:node /var/lib/aegis-idea3/data && chmod 0700 /var/lib/aegis-idea3/data',
    ])
    expect(all.filter((instruction) => instruction.op === 'ENV').map((instruction) => instruction.args)).toEqual(['NODE_ENV=production'])
    expect(all.some((instruction) => ['ADD', 'EXPOSE', 'VOLUME'].includes(instruction.op))).toBe(false)
    expect(runtime.slice(-2)).toEqual([
      { op: 'USER', args: 'node' },
      { op: 'CMD', args: '["node", "server/index.js"]' },
    ])
  })

  it('P2-D1: defaults to a Node base image that satisfies engines.node', () => {
    const args = instructions().filter((instruction) => instruction.op === 'ARG').map((instruction) => instruction.args)
    expect(args).toEqual(['NODE_IMAGE=node:22-alpine'])

    const engines = JSON.parse(readFileSync(path.join(WEB_ROOT, 'package.json'), 'utf8')).engines.node
    const minimumMajor = Number(/^>=(\d+)\./.exec(engines)[1])
    expect(Number(/node:(\d+)-/.exec(args[0])[1])).toBeGreaterThanOrEqual(minimumMajor)
  })

  it('P2-D2: keeps secrets, local state, tests, and dependencies out of the build context', () => {
    const entries = readFileSync(DOCKERIGNORE, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))

    for (const required of [
      'node_modules', 'dist', 'coverage', 'tests', '.env', '.env.*', '.aegis-runtime',
      '**/*.sqlite', '**/*.sqlite3', '**/*.sqlite-*', '**/*.sqlite3-*', '**/*.db', '*.log',
    ]) {
      expect(entries).toContain(required)
    }
    for (const needed of ['server', 'src', 'index.html', 'vite.config.js', 'package.json', 'package-lock.json']) {
      expect(entries).not.toContain(needed)
    }
    expect(entries.some((entry) => entry.startsWith('!'))).toBe(false)
  })
})

describe('PR11 Phase 2 IDEA3 Compose overlay', () => {
  const overlay = () => parseStrictYaml(readFileSync(OVERLAY, 'utf8'))
  const directories = []

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  it('P2-D3: declares exactly the accepted K4/K5 network model (Kla-owned stanza)', () => {
    expect(overlay().networks).toEqual({
      aegis_idea3_internal: {
        name: 'aegis_idea3_internal',
        driver: 'bridge',
        internal: true,
        attachable: false,
        ipam: { config: [{ subnet: '172.31.243.0/29', gateway: '172.31.243.1' }] },
      },
    })
  })

  it('P2-D4: adds only the HUB membership and one hardened, unpublished IDEA3 Web service', () => {
    const document = overlay()
    const web = document.services['idea3-web']

    expect(Object.keys(document).sort()).toEqual(['networks', 'secrets', 'services', 'volumes', 'x-idea3-phase2-contract'])
    expect(Object.keys(document.services).sort()).toEqual(['hub', 'idea3-web'])
    expect(document.services.hub).toEqual({ networks: { aegis_idea3_internal: { ipv4_address: HUB_ADDRESS } } })
    expect(web.networks).toEqual({ aegis_idea3_internal: { ipv4_address: IDEA3_WEB_ADDRESS } })
    expect(inIdea3Subnet(HUB_ADDRESS) && inIdea3Subnet(IDEA3_WEB_ADDRESS)).toBe(true)

    for (const forbidden of [
      'ports', 'network_mode', 'privileged', 'cap_add', 'devices', 'depends_on', 'env_file',
      'build', 'extra_hosts', 'pid', 'ipc', 'links', 'external_links',
    ]) {
      expect(web).not.toHaveProperty(forbidden)
    }
    expect(web.image).toMatch(/^aegis-idea3-web:pr11-phase2-[0-9a-f]{12}$/)
    expect(web.pull_policy).toBe('never')
    expect(web.user).toBe('1000:1000')
    expect(web.read_only).toBe(true)
    expect(web.cap_drop).toEqual(['ALL'])
    expect(web.security_opt).toEqual(['no-new-privileges:true'])
    expect(web.tmpfs).toEqual(['/tmp:rw,noexec,nosuid,nodev,size=16m'])
    expect(web.restart).toBe('unless-stopped')
    expect(web.volumes).toEqual(['aegis_idea3_web_data:/var/lib/aegis-idea3/data'])
    expect(document.volumes).toEqual({ aegis_idea3_web_data: { name: 'aegis_idea3_web_data' } })

    const env = web.environment
    expect(web.healthcheck.test).toEqual([
      'CMD', 'wget', '-q', '-O', '/dev/null',
      `http://${env.AEGIS_BIND_HOST}:${env.PORT}${env.AEGIS_WEB_BASE_PATH}/api/readiness`,
    ])
    expect(env.AEGIS_BIND_HOST).toBe(IDEA3_WEB_ADDRESS)
    expect(env.AEGIS_WEB_TRUSTED_PROXY).toBe(HUB_ADDRESS)
    expect(env.AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY).toBe(HUB_ADDRESS)
    expect(env.AEGIS_IDEA3_DISPATCH_ENABLED).toBe('false')
  })

  it('P2-D4: supplies secrets only as read-only files, never as values', () => {
    const document = overlay()
    const web = document.services['idea3-web']

    expect(web.secrets).toEqual(['idea3_session_secret', 'idea3_admin_password_hash'])
    expect(document.secrets).toEqual({
      idea3_session_secret: { file: '/opt/aegis/runtime/idea3/secrets/session-secret' },
      idea3_admin_password_hash: { file: '/opt/aegis/runtime/idea3/secrets/admin-password-hash' },
    })
    expect(web.environment.SESSION_SECRET_FILE).toBe('/run/secrets/idea3_session_secret')
    expect(web.environment.AEGIS_IDEA3_ADMIN_PASSWORD_HASH_FILE).toBe('/run/secrets/idea3_admin_password_hash')
    for (const value of ['SESSION_SECRET', 'AEGIS_IDEA3_ADMIN_PASSWORD_HASH', 'AEGIS_IDEA1_INTEGRATION_TOKEN', 'AEGIS_IDEA2_INTEGRATION_TOKEN']) {
      expect(web.environment).not.toHaveProperty(value)
    }
  })

  it('P2-D4: records the ownership split and the future Production path', () => {
    expect(overlay()['x-idea3-phase2-contract']).toEqual({
      IDEA3_WEB_SERVICE_OWNER: 'music',
      NETWORK_AND_HUB_MEMBERSHIP_OWNER: 'kraveerachat',
      INTEGRATION_REVIEW_REQUIRED: 'networks.aegis_idea3_internal, services.hub.networks',
      PRODUCTION_PATH: '/opt/aegis/runtime/idea3/idea3-phase2.yml',
      PHASE: '2A',
      PRODUCTION_MUTATION_AUTHORIZED: 'NO',
    })
  })

  it('P2-D5: the overlay environment passes the production loader in Phase 2A and Phase 2B form', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'aegis-overlay-'))
    directories.push(directory)
    const secretFile = (name, content) => {
      const file = path.join(directory, name)
      writeFileSync(file, `${content}\n`)
      return file
    }
    // Local fixture files stand in for the in-container /run/secrets paths.
    const env = {
      ...overlay().services['idea3-web'].environment,
      SESSION_SECRET_FILE: secretFile('session-secret', 'S3cure!ProductionSessionSecret-2026'),
      AEGIS_IDEA3_ADMIN_PASSWORD_HASH_FILE: secretFile('admin-password-hash', '$2b$12$lQ3edrbcQxKq1sNMxX8bzuC/2IAHW5LExZtuJ21rUpMdjB3pN6cYy'),
    }

    const phase2a = loadConfig(env)
    expect(phase2a).toEqual(expect.objectContaining({
      production: true,
      port: 8003,
      bindHost: IDEA3_WEB_ADDRESS,
      webTrustedProxy: HUB_ADDRESS,
      webBasePath: '/security',
      staticDir: path.resolve('/app/dist'),
      auditDbPath: path.resolve('/var/lib/aegis-idea3/data/security-center-audit.sqlite3'),
      demoAllowed: false,
      dispatch: { enabled: false },
    }))
    expect(phase2a.auth.allowDevelopmentLogin).toBe(false)

    const phase2b = loadConfig({ ...env, AEGIS_IDEA3_DISPATCH_ENABLED: 'true' })
    expect(phase2b.dispatch).toEqual({
      enabled: true,
      host: IDEA3_WEB_ADDRESS,
      port: 8004,
      trustedProxy: HUB_ADDRESS,
      expectedSubject: 'idea3-core',
    })
  })

  it('P2-D5: the strict reader fails closed on syntax it does not model', () => {
    for (const source of [
      'a:\n\tb: c\n',
      'a: b # note\n',
      'a: [b, c]\n',
      'a: &anchor b\n',
      'a: |\n  b\n',
      'a: b\na: c\n',
      'a:\n  b: c\n c: d\n',
    ]) {
      expect(() => parseStrictYaml(source)).toThrow()
    }
  })
})
