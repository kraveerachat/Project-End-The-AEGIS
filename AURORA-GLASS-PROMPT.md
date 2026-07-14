# AEGIS — "Aurora Glass" Master UI Prompt (English, detailed)

> Reusable prompt for building **any AEGIS surface** (Hub, Drive_LC, Monitor) in the style of
> the reference image (the indigo AI-assistant mobile UI with the glowing orb). Paste this whole
> document as the design brief. It is the distilled, buildable version of the Visual Language v2
> spec, anchored to what the reference image actually shows.

---

## PROMPT

Design a dark, luminous, glassmorphic security-platform interface in the **"Aurora Glass"**
style. The entire app feels like one physical object: a slab of black glass with an aurora
of indigo light breathing behind it, photographed on film (a faint animated grain sits over
everything). It must feel like a next-generation AI assistant — weightless, soft-edged,
radiant — while the code underneath demonstrates textbook least-privilege security.

### 1. The world (background)

- The background is **never flat**. Build it from 3–4 huge, soft **radial gradients** layered
  over a near-black violet base `#05060E`: a broad midfield indigo `#12134A`, an electric
  indigo `#1E2BC7` pushed to one edge, and one sparing hot bloom `#2F5BFF`. Each layer drifts
  independently on a 70–120 s transform loop, so the field is never the same twice.
- On **mobile the light blooms up from the bottom edge**; on desktop it blooms radially.
- Field brightness is a **status signal**: dim when idle or unauthenticated; it **ignites**
  (layers ease to full opacity over ~1.4 s) the moment the user authenticates; it drains to
  gray when the session locks. Red intrudes from the affected edge on alerts.
- A full-viewport procedural **film grain** canvas (`mix-blend-mode: overlay`, re-seeded
  ~10×/s) sits above everything: opacity **0.16 pre-auth** (heavy, analog, "ciphertext"),
  **0.05 once inside** (barely there). This layer is what stops the glass looking sterile.

### 2. The Orb (hero element — copy the reference image)

Center of boot / welcome / login screens; shrunk to ~36 px in the top bar afterwards
(the *same* orb — continuity matters).

- **Core:** the AEGIS mark rendered as a **dithered halftone dot field** (sample the logo's
  luminance on a 4–6 px grid; dot radius = darkness; ±0.5 px jitter; slow independent drift).
- **Ring:** a thick, soft **torus of blue-cyan energy** around the mark — build it from two
  conic-gradient annuli (radial-gradient alpha masks), heavily blurred, **counter-rotating at
  different speeds (≈40 s and ≈26 s)** so their interference reads as turbulence. Indigo
  `#1E2BC7` base, cyan `#00E5FF` hot arcs. Not a clean circle — irregular density, brighter arcs.
- **Bloom:** a wide radial light-spill behind the orb; the orb lights the room.
- **States:** boot = core resolves out of random noise, ring dark until lock-on, then ignites;
  idle = breathing scale 1↔1.015 over 6 s; verifying = ring rotation **accelerates**;
  rejected = ring **snaps to `#FF4D6D`** and destabilizes for ~400 ms; top bar = thin halo.

### 3. Material (glass)

Every card, panel, chip, modal and input is **frosted glass floating over the aurora**. All
four ingredients, always:

1. `background: rgba(255,255,255,0.05)` + `backdrop-filter: blur(20px) saturate(140%)`
2. **Rim light** — a 1 px gradient border, brighter top/left than bottom/right (masked
   gradient-border technique). Never a uniform border.
3. **Inner glow** — `inset 0 1px 0 rgba(255,255,255,0.08)` hairline along the top edge.
4. **Outer bloom** — shadows are indigo light (`0 8px 32px rgba(0,0,0,.4), 0 0 40px
   rgba(47,91,255,.12)`), never plain black.

Never nest `backdrop-filter` more than one level deep; controls sitting on a glass surface use
a translucent fill without their own blur.

### 4. Shape & type

- **Pills everywhere** (`border-radius: 999px`): buttons, chips, toggles, inputs, search
  fields, nav items — exactly like the reference image. Cards and modals: 24 px. Small tiles:
  16 px. Sharp corners are reserved solely for data tables / audit ledgers (deliberately hard,
  non-glass material).
- **Icon buttons are perfect glass circles** (40–48 px) with 1.5 px stroke line-art icons.
- Type: geometric grotesque (Space Grotesk / Inter Tight) + IBM Plex Sans Thai. Display 600–700
  weight, tracking −0.02 em. The workhorse "instrumentation voice": **11–12 px UPPERCASE,
  tracking 0.12 em** for labels, statuses, column headers. Body 14–15 px.
  `font-variant-numeric: tabular-nums` globally. Thai text: `line-height ≥ 1.7`.
- Colors for text: `#F0F2FF` primary, `#9AA3C4` secondary (the minimum tier for any functional
  text — AA-safe), `#5B6389` strictly decorative.

### 5. Components (grammar from the reference image)

- **Buttons:** glass pills. Hover = fill brightens, a 1 px cyan ring ignites
  (`rgba(0,229,255,.45)`), and a cyan-indigo bloom grows *behind* the button, as if it draws
  power from the aurora. Active = scale 0.97. **Primary CTA:** indigo gradient fill
  `#1E2BC7 → #2F5BFF` with white label (keep cyan in the glow, never under small text —
  contrast). Destructive: rim/bloom in `#FF4D6D`, always two-step.
- **Inputs:** glass pill shells, 48 px tall; on focus the rim animates to cyan and a soft glow
  blooms *beneath* the field. Labels above, in instrumentation voice.
- **Toggles:** pill switches; the checked track fills with the indigo gradient and glows.
- **Chips / status pills:** small glass pills with a leading dot that **pulses continuously**
  (`● EDGE NODE · ONLINE` in `#00E08A`, `● DEGRADED` in `#FFB74D`, `● BLOCKED` in `#FF4D6D`).
- **Cards:** hover = lift −4 px, rim ignites, aurora brightens behind, `OPEN →` arrow slides
  right. Click = card expands toward the destination (shared-element feel), everything else
  dims.
- **Tables & audit logs:** the deliberate exception — flat, more opaque, sharp 8 px corners,
  hairline dividers. DENIED/BLOCKED rows flash a red edge (~600 ms) and keep a persistent red
  left-edge marker.
- **Progress:** always inline, in place, inside the button or panel that started the action.
  No global overlays, no spinners — content-shaped glass skeletons with a shimmer sweep, lists
  populate progressively.
- **Toasts:** glass pills sliding up from the bottom with a bloom.

### 6. Signature motion — "the Wake" (~1.8 s on every successful login)

One continuous particle canvas mounted **once** at the app root, never remounted between
screens:

1. **0–0.3 s** — the login panel's glass **shatters into dots** (no slide-away).
2. **0.2–0.9 s** — the dormant gray halftone dots **wake**: they lift into z-depth and color
   ripples outward from the center — gray → indigo `#1E2BC7`/`#2F5BFF` in the depths → cyan
   `#00E5FF` on the ridges, with a few scattered jade `#00E08A` sparks.
3. **0.5–1.3 s** — the points self-organize into a **topographic mesh** of thin luminous
   filaments — it must read as sensor terrain, not ornament.
4. **0.8–1.5 s** — the **aurora field ignites** behind the mesh; the room fills with light.
5. **1.2–1.8 s** — the app chrome **precipitates**: glass surfaces condense out of the light
   (blur 14 px → 0 + fade), grain drops 0.16 → 0.05.

Logout / lock runs it **backwards** — color drains, the mesh flattens, the light goes out.
Everything else inside the app: 150–250 ms transform/opacity feedback, ease-out-quint/expo,
no bounce.

### 7. Non-negotiables

- Full `prefers-reduced-motion` support: grain freezes, all drift/rotation stops, the Wake
  collapses to a ~150 ms crossfade; every state motion communicates must also be carried by
  color/icon/label. WCAG AA contrast verified against the **brightest** possible backdrop.
  Visible 2 px cyan focus rings. Real `<label>`s; `role="alert"` on errors; full keyboard paths.
- **No `localStorage`/`sessionStorage`** — session and preferences live in React state only
  (production: HttpOnly Secure SameSite=Strict cookie; comment this at the boundary).
- **No `<form>` elements** — `onClick` handlers.
- **No role selector anywhere.** Credentials in, server-decided role out.
- **Unauthorized UI must not exist in the DOM** — filter the module array *before* `.map()`.
- Role logic = one pure **default-deny** function, marked "UX affordance only" in Thai.
- **One identical auth error message** regardless of cause (anti-enumeration), commented.
- Realistic mock data only (plausible SHA-256 hashes, private IPs, timestamps, filenames).
- **Thai comments on every security-relevant decision**; state prototype shortcuts and what
  production requires.
- Performance: particles ≤ 3–4 k desktop / ~1.2 k mobile (connection lines off on mobile);
  animate transforms/opacity only; aurora = CSS gradients, not canvas; steady 60 fps wins over
  any effect.

The bar: a user should feel like they switched on a machine that costs more than they earn in
a year — while anyone reading the source sees least privilege, default-deny, and zero
information disclosure. Own the direction completely; do not play it safe.
