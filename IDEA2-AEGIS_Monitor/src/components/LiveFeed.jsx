// Native MJPEG, always through the authorized same-origin Monitor proxy.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { RefreshCw, WifiOff } from 'lucide-react'

const RETRY_MS = [2_000, 4_000, 8_000, 15_000, 30_000]

function StreamImage({ src, alt, onLoad, onError }) {
  const imageRef = useRef(null)
  useLayoutEffect(() => {
    const image = imageRef.current
    image.addEventListener('load', onLoad)
    image.addEventListener('error', onError)
    image.src = src
    return () => {
      // Detaching an <img> alone can leave multipart requests alive.
      // Cancel explicitly, without src="" (which requests the page).
      image.removeEventListener('load', onLoad)
      image.removeEventListener('error', onError)
      image.removeAttribute('src')
    }
  }, [src, onLoad, onError])
  return <img ref={imageRef} className="feedimg" alt={alt} draggable={false} />
}

function FeedSession({ cameraId, cameraName, lost, compact, hideStatus, onStateChange }) {
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState('connecting')
  const [justRecovered, setJustRecovered] = useState(false)
  const attempts = useRef(0)
  const timer = useRef(0)
  const recoveryTimer = useRef(0)
  const active = useRef(true)

  useLayoutEffect(() => {
    active.current = true
    return () => {
      active.current = false
      clearTimeout(timer.current)
      clearTimeout(recoveryTimer.current)
    }
  }, [])
  useEffect(() => { onStateChange?.({ cameraId, state }) }, [cameraId, state, onStateChange])

  const retryNow = useCallback(() => {
    if (!active.current) return
    clearTimeout(timer.current)
    attempts.current = 0
    setState('connecting')
    setNonce((n) => n + 1)
  }, [])

  const onError = useCallback(() => {
    if (!active.current) return
    setState('error')
    const wait = RETRY_MS[Math.min(attempts.current++, RETRY_MS.length - 1)]
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (!active.current) return
      setState('connecting')
      setNonce((n) => n + 1)
    }, wait)
  }, [])

  const onLoad = useCallback(() => {
    if (!active.current) return
    clearTimeout(timer.current)
    if (attempts.current > 0) {
      setJustRecovered(true)
      clearTimeout(recoveryTimer.current)
      recoveryTimer.current = setTimeout(() => {
        if (active.current) setJustRecovered(false)
      }, 700)
    }
    attempts.current = 0
    setState('live')
  }, [])

  const src = `${import.meta.env.BASE_URL}api/cameras/${encodeURIComponent(cameraId)}/stream?t=${nonce}`
  return (
    <>
      <div className="hatch" />
      <StreamImage key={nonce} src={src} alt={`Live feed — ${cameraId} ${cameraName ?? ''}`.trim()}
        onLoad={onLoad} onError={onError} />
      {justRecovered && <div className="feed-recovered" aria-hidden="true" />}
      {!compact && !hideStatus && state !== 'live' && (
        <div className="feedstate" role="status" aria-live="polite">
          {state === 'error' ? (
            <>
              <WifiOff aria-hidden="true" size={14} />
              <span>Stream interrupted — reconnecting…</span>
              <button type="button" className="ackbtn feedretry" onClick={retryNow}>
                <RefreshCw aria-hidden="true" size={12} /> Retry now
              </button>
            </>
          ) : (
            <><RefreshCw aria-hidden="true" size={14} className="spin" /><span>Connecting to {cameraId}…</span></>
          )}
        </div>
      )}
      {!compact && !hideStatus && lost && state === 'live' && (
        <div className="feedstate" role="status"><WifiOff aria-hidden="true" size={14} /><span>Edge link lost — displayed frames may be stale</span></div>
      )}
    </>
  )
}

export default function LiveFeed(props) {
  if (!props.hasStream) {
    return (
      <>
        <div className="hatch" />
        {!props.compact && !props.hideStatus && (
          <div className="feedstate" role="status">No stream available for {props.cameraId}</div>
        )}
      </>
    )
  }
  // Camera identity and availability both destroy the old session, including
  // its image connection, listeners, backoff timer and recovery timer.
  return <FeedSession key={props.cameraId} {...props} />
}
