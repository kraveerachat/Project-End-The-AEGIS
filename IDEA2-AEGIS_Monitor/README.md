# AEGIS Monitor — AI CCTV HUD (IDEA2)

The SOC-Responder aggregate console for the AEGIS CCTV pipeline: a dark
ops-console HUD (the platform's one documented dark exception — see
`/DESIGN.md`). Implemented from the approved Claude Design mock
**"AEGIS HUD.dc.html"**.

## Views

| # | View | What it shows |
|---|------|---------------|
| 1 | Live canvas | AI-elevated hero feed with bounding boxes, camera focus swap, fullscreen, access-control result, live event stream |
| 2 | Archival footage | ~10-min NAS clips with unknown-window segment bars, in-progress segment, camera/result filters, per-clip flag review |
| 3 | Detection stream | Per-frame recognition record; multi-subject frames flag tailgating; NAS sync state |
| 4 | Alerts | Acknowledge queue, severity, Telegram routing to the camera's assigned operator |
| 5 | Nodes & routing | Camera fleet, health, and operator assignment |
| 6 | Operators | Operator accounts, inline add + camera assignment editors |

## Run

```bash
npm install
npm run dev        # http://localhost:5175
npm run build      # production build to dist/
```

## Keyboard

- `1`–`6` — switch views
- `L` — link test: kills the simulated Edge-node heartbeat so the
  degraded → lost cascade can be reviewed (red pills, CONNECTION LOST
  overlay, stale badges, frozen stream). Auto-recovers after 60 s, or
  press `L` again.

## Data & integration notes

- All data comes from `src/data.js` + the simulated engine in
  `src/engine.js` (heartbeat link-state machine, periodic detection
  emissions). In integration both are replaced by the detection
  engine's WebSocket feed — shapes are kept identical.
- Feed surfaces (hatched panels) are stand-ins for WebRTC/RTSP streams.
- Identity (System Admin / SOC-Responder) comes from the HUB's
  server-side session when integrated; this app renders what it is
  given and contains no role selector (see Thai security comments in
  `src/App.jsx`).
- Alert routing is default-deny: unassigned cameras and suspended
  operators always fall back to SOC-Team.

## Accessibility

- Full keyboard operation; every control is a real `<button>` with
  visible teal focus rings.
- `prefers-reduced-motion`: scanline, pings, orb drift, and pulses are
  disabled; every animated state also reads statically.
- Link status changes are announced via `role="status"` on the header
  pills; the connection-lost overlay is `role="alert"`.
- 44 px touch targets on coarse pointers; responsive to 390 px with no
  horizontal overflow.
