import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function source(relativePath) {
  const value = readFileSync(path.join(ROOT, relativePath), 'utf8')
  if (
    process.env.AEGIS_UI_FREEZE_MUTATION === 'remove-camera-selector' &&
    relativePath === 'src/views/Live.jsx'
  ) {
    return value
      .replace("import CameraSelector from '../components/CameraSelector.jsx'", '')
      .replace(/\s*<CameraSelector[\s\S]*?\/>/, '')
  }
  return value
}

test('preserves the current-main CameraSelector inside the Live canvas', () => {
  const live = source('src/views/Live.jsx')

  assert.match(live, /import CameraSelector from '\.\.\/components\/CameraSelector\.jsx'/)
  assert.match(live, /<CameraSelector cameras=\{cameras\} selectedId=\{cam\.id\}/)
  assert.match(live, /streamState=\{feedStatus\?\.cameraId === cam\.id \? feedStatus\.state : null\}/)
  assert.match(live, /onSelect=\{\(id\) => \{/)
})

test('preserves bounded previews and the accepted responsive selector contract', () => {
  const selector = source('src/components/CameraSelector.jsx')
  const css = source('src/components/CameraSelector.css')

  assert.match(selector, /cameras\.slice\(start, start \+ 3\)/)
  assert.match(selector, /selected\s*\? streamState === 'live' && <SelectedPreview/)
  assert.match(selector, /: <LiveFeed cameraId=\{camera\.id\}/)
  assert.match(selector, />Live previews · Choose a camera to view</)
  assert.match(selector, /aria-label="Assigned cameras"/)
  assert.match(selector, /aria-label="Previous cameras"/)
  assert.match(selector, /aria-label="Next cameras"/)

  assert.match(css, /\.camera-options \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/s)
  assert.match(css, /@container \(max-width: 640px\)[\s\S]*repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(css, /@container \(max-width: 380px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/)
})

test('preserves current-main MJPEG cleanup and camera-session isolation', () => {
  const liveFeed = source('src/components/LiveFeed.jsx')

  assert.match(liveFeed, /image\.removeAttribute\('src'\)/)
  assert.match(liveFeed, /return <FeedSession key=\{props\.cameraId\} \{\.\.\.props\} \/>/)
  assert.match(liveFeed, /if \(!props\.hasStream\)/)
  assert.match(liveFeed, />No stream available for \{props\.cameraId\}</)
})

test('preserves current-main camera selection wiring without freezing hidden hooks', () => {
  const app = source('src/App.jsx')
  const live = source('src/views/Live.jsx')

  assert.match(app, /import \{ selectedCamera \} from '\.\/lib\/liveCamera\.js'/)
  assert.match(app, /fetchCameras\(\)\.then\(\(cams\) => \{/)
  assert.match(app, /setHeroCam\(\(current\) => selectedCamera\(cams, current\)\?\.id \?\? null\)/)
  assert.match(app, /cameras=\{cameras\}/)
  assert.match(app, /heroCam=\{heroCam\} setHeroCam=\{setHeroCam\}/)

  assert.match(live, /<h1 className="h1">Live canvas<\/h1>/)
  assert.match(live, /Access control · result/)
  assert.match(live, /Event stream/)
  assert.match(live, /No cameras assigned/)
})
