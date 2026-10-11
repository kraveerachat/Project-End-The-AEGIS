// Monitor-owned, read-only taps of already-authorized Operator MJPEG upstreams.
// A passive viewer never acquires producer authority or opens an Engine socket.
import { randomBytes } from 'node:crypto'

const MAX_SOURCES = 64
const MAX_VIEWERS = 32
const MAX_VIEWERS_PER_SOURCE = 8
const MAX_PART_BYTES = 2 * 1024 * 1024
const MAX_HEADER_BYTES = 2048
const MAX_BUFFER_BYTES = MAX_PART_BYTES + MAX_HEADER_BYTES + 256
const DRAIN_TIMEOUT_MS = 2000

function multipartBoundary(contentType) {
  if (typeof contentType !== 'string' || !/^multipart\/x-mixed-replace(?:\s*;|\s*$)/i.test(contentType)) return null
  const match = contentType.match(/(?:^|;)\s*boundary=(?:"([A-Za-z0-9'()+_,./:=?-]{1,70})"|([A-Za-z0-9'()+_,./:=?-]{1,70}))(?:\s*;|\s*$)/i)
  return match?.[1] ?? match?.[2] ?? null
}

/** Read complete Content-Length-delimited parts, never ReadableStream chunks. */
export class MjpegPartFramer {
  constructor(contentType) {
    const boundary = multipartBoundary(contentType)
    if (!boundary) throw new TypeError('invalid multipart boundary')
    this.marker = Buffer.from(`--${boundary}\r\n`, 'ascii')
    this.storage = Buffer.alloc(4096)
    this.length = 0
  }

  push(value, onPart) {
    const chunk = Buffer.from(value)
    let offset = 0
    while (offset < chunk.length) {
      if (this.length === MAX_BUFFER_BYTES) {
        this.drain(onPart)
        if (this.length === MAX_BUFFER_BYTES) throw new RangeError('multipart part exceeds bound')
      }
      const take = Math.min(chunk.length - offset, MAX_BUFFER_BYTES - this.length)
      const required = this.length + take
      if (required > this.storage.length) {
        const larger = Buffer.alloc(Math.min(MAX_BUFFER_BYTES, Math.max(required, this.storage.length * 2)))
        this.storage.copy(larger, 0, 0, this.length)
        this.storage = larger
      }
      chunk.copy(this.storage, this.length, offset, offset + take)
      this.length += take
      offset += take
      this.drain(onPart)
    }
  }

  drain(onPart) {
    for (;;) {
      const current = this.storage.subarray(0, this.length)
      const start = current.indexOf(this.marker)
      if (start < 0) {
        const keep = Math.min(this.length, this.marker.length - 1)
        this.storage.copy(this.storage, 0, this.length - keep, this.length)
        this.length = keep
        return
      }
      if (start > 0) {
        this.storage.copy(this.storage, 0, start, this.length)
        this.length -= start
      }
      const part = this.storage.subarray(0, this.length)
      const headerEnd = part.indexOf('\r\n\r\n', this.marker.length)
      if (headerEnd < 0) {
        if (this.length > MAX_HEADER_BYTES + this.marker.length) throw new RangeError('multipart header exceeds bound')
        return
      }
      if (headerEnd - this.marker.length > MAX_HEADER_BYTES) throw new RangeError('multipart header exceeds bound')
      const header = part.subarray(this.marker.length, headerEnd).toString('latin1')
      const lengthMatch = header.match(/^Content-Length:\s*([0-9]+)\s*$/im)
      if (!/^Content-Type:\s*image\/(jpeg|png)\s*$/im.test(header) || !lengthMatch) {
        throw new TypeError('invalid multipart part header')
      }
      const bodyLength = Number(lengthMatch[1])
      if (!Number.isSafeInteger(bodyLength) || bodyLength <= 0 || bodyLength > MAX_PART_BYTES) {
        throw new RangeError('multipart body exceeds bound')
      }
      const end = headerEnd + 4 + bodyLength + 2
      if (end > MAX_BUFFER_BYTES) throw new RangeError('multipart part exceeds bound')
      if (this.length < end) return
      if (part[end - 2] !== 13 || part[end - 1] !== 10) {
        throw new TypeError('invalid multipart part trailer')
      }
      // Response.write may retain the bytes asynchronously. Never reuse its buffer.
      onPart(Buffer.from(part.subarray(0, end)))
      this.storage.copy(this.storage, 0, end, this.length)
      this.length -= end
    }
  }
}

export class PassiveLiveRegistry {
  constructor({ drainTimeoutMs = DRAIN_TIMEOUT_MS } = {}) {
    if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 1 || drainTimeoutMs > DRAIN_TIMEOUT_MS) {
      throw new RangeError('invalid passive drain timeout')
    }
    this.sources = new Map()
    this.viewerCount = 0
    this.drainTimeoutMs = drainTimeoutMs
  }

  register({ logicalCameraId, nodeId, physicalCameraId, producerGeneration, contentType }) {
    if (this.sources.size >= MAX_SOURCES || !logicalCameraId || !nodeId || !physicalCameraId
      || !/^[0-9]+$/.test(String(producerGeneration))) return null
    let framer
    try { framer = new MjpegPartFramer(contentType) } catch { return null }
    const viewId = randomBytes(24).toString('base64url')
    const source = {
      viewId, logicalCameraId, nodeId, physicalCameraId,
      producerGeneration: String(producerGeneration), contentType,
      active: true, subscribers: new Set(),
      publish: (chunk) => {
        if (!source.active) return
        try {
          framer.push(chunk, part => {
            for (const viewer of source.subscribers) {
              if (viewer.response.destroyed || viewer.response.writableEnded) {
                viewer.close()
                continue
              }
              // Keep at most one part in Node's writable buffer. Missing the
              // next frame is safe; a persistent non-drain closes this viewer.
              if (viewer.blocked) continue
              if (!viewer.response.write(part)) {
                viewer.blocked = true
                viewer.timer = setTimeout(viewer.forceClose, this.drainTimeoutMs)
                viewer.response.once('drain', viewer.drain)
              }
            }
          })
        } catch {
          // A malformed upstream may not turn Operator delivery into a failure.
          source.close()
        }
      },
      subscribe: response => {
        if (!source.active || this.viewerCount >= MAX_VIEWERS
          || source.subscribers.size >= MAX_VIEWERS_PER_SOURCE) return false
        const viewer = {
          response, blocked: false, timer: null,
          drain: () => { clearTimeout(viewer.timer); viewer.timer = null; viewer.blocked = false },
          forceClose: () => {
            if (source.subscribers.has(viewer)) response.destroy()
          },
          close: () => {
            if (!source.subscribers.delete(viewer)) return
            this.viewerCount -= 1
            clearTimeout(viewer.timer)
            response.off('drain', viewer.drain)
            response.off('close', viewer.close)
            if (!response.writableEnded && !response.destroyed) {
              if (viewer.blocked) response.destroy()
              else response.end()
            }
          },
        }
        source.subscribers.add(viewer)
        this.viewerCount += 1
        response.once('close', viewer.close)
        return true
      },
      close: () => {
        if (!source.active) return
        source.active = false
        this.sources.delete(viewId)
        for (const viewer of [...source.subscribers]) viewer.close()
      },
    }
    this.sources.set(viewId, source)
    return source
  }

  get(viewId) { return this.sources.get(viewId) ?? null }

  list() {
    return [...this.sources.values()].filter(source => source.active).map(source => ({
      viewId: source.viewId, cameraId: source.logicalCameraId,
      nodeId: source.nodeId, active: true,
    }))
  }
}

export const passiveLiveRegistry = new PassiveLiveRegistry()
