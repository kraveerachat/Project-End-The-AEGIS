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
import { CameraAccessError } from ${JSON.stringify(new URL('../../server/auth/cameraAccess.js', import.meta.url).href)};
export { CameraAccessError };
const fixture = globalThis.__physicalLinkFixture
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
const connectionSource = `
export * from ${JSON.stringify(new URL('../../server/db/connection.js', import.meta.url).href)};
export async function canSeeCamera(user, cameraId) {
  const fixture = globalThis.__physicalLinkFixture;
  fixture.assignmentChecks.push([user.id, cameraId]);
  return user.id === 2 && cameraId === 'CAM-01' && fixture.assignmentActive === true;
}
`
const producerSource = `
export const STREAM_REVALIDATE_MS = 10000;
export const RENEW_BEFORE_MS = 20000;
export function createProducerLifecycle() {
  return {
    async acquire({ access, sessionBinding }) {
      const fixture = globalThis.__physicalLinkFixture;
      if (sessionBinding !== fixture.sessionBinding || access.keyVersion !== 1)
        throw new Error('fixture requires authenticated binding and key version');
      const handle = { ...access, producerGeneration: '9007199254740993', demandOwnerId: Buffer.alloc(32, 5).toString('base64url'),
        sessionBindingHash: 'v1:' + 'a'.repeat(64), leaseExpiresAtMs: Date.now() + 30000,
        dbNowMs: Date.now(), dbObservationStartMs: Date.now(), dbObservationEndMs: Date.now() };
      fixture.acquireCalls.push(handle);
      return handle;
    },
    async renew() { throw new Error('short redirect test must not renew'); },
    async release(handle) { globalThis.__physicalLinkFixture.releaseCalls.push(handle); return { released: true, epochRetired: true }; },
  };
}
`

export function resolve(specifier, context, nextResolve) {
  if (specifier === '../db/store.js' && context.parentURL?.endsWith('/server/routes/api.js')) {
    return { shortCircuit: true, url: storeUrl }
  }
  if (specifier === '../auth/cameraAccess.js' && context.parentURL?.endsWith('/server/routes/api.js')) {
    return { shortCircuit: true, url: accessUrl }
  }
  if (context.parentURL?.endsWith('/server/routes/api.js')) {
    if (specifier === '../db/connection.js') return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(connectionSource)}` }
    if (specifier === '../db/producerLifecycle.js') return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(producerSource)}` }
  }
  return nextResolve(specifier, context)
}
