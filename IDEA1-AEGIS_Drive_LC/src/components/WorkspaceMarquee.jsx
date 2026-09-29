// src/components/WorkspaceMarquee.jsx — AEGIS Drive (IDEA1) · PR220-R1 · one workspace marquee surface
//
// Files and Vault TREE share ONE desktop marquee interaction. Ownership is split:
//
//   WorkspaceMarqueeSurface  owns the pointer surface, the drag, the painted rectangle and
//                            text-selection suppression. App renders it as the full main pane,
//                            so the side gutters and bottom whitespace start a marquee.
//   WorkspaceMarqueeSource   a screen's selection state only: tile registry, selected ids,
//                            selection callback, grid-enabled flag. It renders nothing.
//   WorkspaceMarqueeScope    what a screen wraps its grid in. Inside App it is a plain,
//                            UNPOSITIONED div; mounted on its own (tests, embeds) it becomes
//                            a surface itself, so the behaviour is identical either way.
//
// ⚠️ The rectangle is a direct child of the surface, and the surface is `relative`: the
//    surface is therefore the rectangle's CSS containing block, and the box the hook
//    computes (relative to the surface) is painted exactly under the pointer. PR220's first
//    candidate painted Files' rectangle inside Files' own `relative` drop-zone wrapper, so it
//    drew one gutter + header away from the pointer — off-screen from the right gutter.
//    Nothing inside a scope may paint a second rectangle.
// ⚠️ No role input exists here by design: role is an authorization fact, not interaction.
import { createContext, useContext, useLayoutEffect, useMemo, useRef } from 'react'
import { useMarqueeSelection } from '../lib/useMarqueeSelection.js'

const WorkspaceMarqueeContext = createContext(null)

export function WorkspaceMarqueeSurface({ children, className = '', style, ...rest }) {
  const surfaceRef = useRef(null)
  const registered = useRef(null)       // the mounted screen's source ref (or null)
  const sourceRef = useMemo(() => ({ get current() { return registered.current?.current ?? null } }), [])
  const marquee = useMarqueeSelection({ canvasRef: surfaceRef, sourceRef })
  const context = useMemo(() => ({
    attach(ref) {
      registered.current = ref
      return () => { if (registered.current === ref) registered.current = null }
    },
  }), [])
  return (
    <WorkspaceMarqueeContext.Provider value={context}>
      <div
        {...rest}
        ref={surfaceRef}
        data-workspace-marquee-surface=""
        data-marquee-canvas=""
        onPointerDown={marquee.onPointerDown}
        className={`relative ${className}`.trim()}
        style={{ ...style, userSelect: marquee.tracking ? 'none' : style?.userSelect }}
      >
        {marquee.box && (
          <div
            data-marquee-rect=""
            aria-hidden="true"
            className="pointer-events-none absolute z-10 rounded-[4px] border border-accent"
            style={{
              left: `${marquee.box.left}px`, top: `${marquee.box.top}px`,
              width: `${marquee.box.width}px`, height: `${marquee.box.height}px`,
              background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
            }}
          />
        )}
        {children}
      </div>
    </WorkspaceMarqueeContext.Provider>
  )
}

/** Register a screen's selection state with the nearest surface. Latest values are read at event time. */
export function WorkspaceMarqueeSource({ enabled, tileEls, selectedIds, onSelectionChange }) {
  const context = useContext(WorkspaceMarqueeContext)
  const own = useRef(null)
  own.current = { enabled: Boolean(enabled), tileEls, selectedIds, onSelectionChange }
  useLayoutEffect(() => context?.attach(own), [context])
  return null
}

/**
 * A screen's grid container. Inside a surface it adds no positioning (so it can never become
 * the rectangle's containing block); standalone it is the surface. `standaloneClassName` is
 * added only in the standalone case.
 */
export function WorkspaceMarqueeScope({ children, className = '', standaloneClassName = '', ...rest }) {
  const context = useContext(WorkspaceMarqueeContext)
  if (context) return <div {...rest} className={className}>{children}</div>
  return (
    <WorkspaceMarqueeSurface {...rest} className={`${standaloneClassName} ${className}`.trim()}>
      {children}
    </WorkspaceMarqueeSurface>
  )
}
