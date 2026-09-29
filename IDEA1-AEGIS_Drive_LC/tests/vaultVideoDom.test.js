// Browser-facing contract for the temporary decoder element used by Vault video posters.
import test from 'node:test'
import assert from 'node:assert/strict'

import { attachPosterVideo } from '../src/lib/vaultVideoDom.js'

test('VDOM-1 poster decoding attaches a hidden video to the document and removes it during cleanup', async () => {
  const priorDocument = globalThis.document
  const video = new EventTarget()
  let attached = false
  let removed = false
  let source = ''
  Object.assign(video, {
    muted: false,
    preload: '',
    playsInline: false,
    duration: 1,
    pause() {},
    load() {},
    removeAttribute(name) { if (name === 'src') source = '' },
    remove() { removed = true; attached = false },
  })
  Object.defineProperty(video, 'src', {
    get: () => source,
    set: (value) => {
      source = value
      setTimeout(() => video.dispatchEvent(new Event('loadeddata')), 0)
    },
  })
  globalThis.document = {
    createElement: (tag) => {
      assert.equal(tag, 'video')
      return video
    },
    body: {
      append: (element) => {
        assert.equal(element, video)
        attached = true
      },
    },
  }

  try {
    const result = await attachPosterVideo({ url: 'blob:fixture' })
    assert.equal(attached, true, 'the decoder must be connected for browsers that do not load detached media')
    assert.equal(video.muted, true)
    assert.equal(video.preload, 'metadata')
    result.cleanup()
    assert.equal(removed, true, 'cleanup removes the temporary decoder from the DOM')
  } finally {
    globalThis.document = priorDocument
  }
})
