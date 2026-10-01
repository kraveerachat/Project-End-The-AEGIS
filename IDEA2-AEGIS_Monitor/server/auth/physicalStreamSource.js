import { isIP } from 'node:net'

const DNS_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

function deploymentHostname(raw) {
  const host = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (host.endsWith('.')) return null
  if (!host || host.length > 253 || host === 'localhost' || isIP(host)) return null
  const labels = host.split('.')
  if (labels.length < 2 || labels.some((label) => !DNS_LABEL_RE.test(label))) return null
  return host
}

// Deployment-owned stream destinations. Heartbeats report availability, not
// permission for Monitor to send its Engine credential to an arbitrary URL.
export function approvedStreamUrlForPhysicalCamera(
  physicalCameraId,
  nodeId,
  raw = process.env.AEGIS_TRUSTED_PHYSICAL_STREAM_SOURCES,
  rawHost = process.env.AEGIS_MONITOR_STREAM_HOST,
) {
  const approvedHost = deploymentHostname(rawHost)
  if (!Number.isSafeInteger(physicalCameraId) || physicalCameraId < 1 || !nodeId || !raw || !approvedHost) return null
  let sources
  try { sources = JSON.parse(raw) } catch { return null }
  if (!sources || Array.isArray(sources) || typeof sources !== 'object') return null
  const key = String(physicalCameraId)
  if (!Object.hasOwn(sources, key)) return null
  const entry = sources[key]
  if (!entry || entry.nodeId !== nodeId || typeof entry.url !== 'string') return null
  let url
  try { url = new URL(entry.url) } catch { return null }
  const port = Number(url.port)
  if (
    url.protocol !== 'http:'
    || url.hostname !== approvedHost
    || !Number.isSafeInteger(port)
    || port < 1
    || port > 65535
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== '/stream.mjpg'
  ) return null
  return url.toString()
}
