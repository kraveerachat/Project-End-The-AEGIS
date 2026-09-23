const storeSource = `
const fixture = globalThis.__physicalLinkFixture
export async function streamSourceForPhysicalCamera(physicalCameraId) {
  fixture.physicalLookups.push(physicalCameraId)
  return fixture.source
}
export function heartbeatAvailability({ ageMs, streamUrl, cameraConnected }) {
  if (ageMs == null || streamUrl == null) {
    return { status: 'lost', cameraConnected: false, hasStream: false }
  }
  const status = ageMs <= 15000 ? 'online' : ageMs <= 45000 ? 'degraded' : 'lost'
  return { status, cameraConnected: cameraConnected === true, hasStream: status !== 'lost' }
}
export function simulatedOutageActive() { return false }
export async function linkStatus() {
  fixture.logicalLinkCalls += 1
  throw new Error('logical link status must not run for strict operators')
}
`

const accessSource = `
const fixture = globalThis.__physicalLinkFixture
export class CameraAccessError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code }
}
export function parseLocalNodeAssociationRequirement() { return true }
export async function resolveLiveCameraActor() {
  if (fixture.actorError) throw new CameraAccessError(fixture.actorError.status, fixture.actorError.code)
  return fixture.actor
}
export async function resolveOperatorCameraAccess() {
  if (fixture.accessError) throw new CameraAccessError(fixture.accessError.status, fixture.accessError.code)
  return fixture.access
}
export async function resolveOperatorAccess() { return fixture.access }
export async function resolvePhysicalStreamTarget() {
  if (fixture.accessError) throw new CameraAccessError(fixture.accessError.status, fixture.accessError.code)
  return { access: fixture.access, source: fixture.source }
}
`

const storeUrl = `data:text/javascript,${encodeURIComponent(storeSource)}`
const accessUrl = `data:text/javascript,${encodeURIComponent(accessSource)}`

export function resolve(specifier, context, nextResolve) {
  if (specifier === '../db/store.js' && context.parentURL?.endsWith('/server/routes/api.js')) {
    return { shortCircuit: true, url: storeUrl }
  }
  if (specifier === '../auth/cameraAccess.js' && context.parentURL?.endsWith('/server/routes/api.js')) {
    return { shortCircuit: true, url: accessUrl }
  }
  return nextResolve(specifier, context)
}
