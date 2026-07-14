# Design

Visual system for the AEGIS platform. The Entry Point now runs **"Modern Elevated UI"** — the
premium-SaaS evolution of "Precision Light" (which itself replaced "Aurora Glass" v2). Still
banned: glow-as-decoration, bloom, backdrop-blur, glassmorphism, dark aurora fields, particle
canvases, orbs. Token source of truth is each app's `src/index.css`.

- `HUB-AEGIS_Entry` — the Entry Point (Welcome → Login → Hub launcher), Modern Elevated UI,
  light + dark themes. Three screens, nothing else.
- `IDEA1-AEGIS_Drive_LC` — AEGIS Drive, the NAS control panel (its own brief, Build Brief v3,
  still on the flat/bordered Precision Light tokens).

## The Gate's Atmosphere (Welcome + Login only)

The pre-auth gate is full-bleed: `BG_AEGIS01` (light) / `BG_AEGIS02` (dark), swapped via
`--gate-image`, `cover / center`. Their fibre streaks converge on an empty centre — the vault
sits in that void and expands into the incoming light. **The Hub does not get the photograph**:
the door is atmospheric, the workspace is plain. That contrast is the point.

The image is atmosphere, never a surface to put UI on. Everything interactive stays on the
opaque vault card — which is precisely why the gate needs no glass: `backdrop-filter` over
these assets would blur a near-flat gradient (a no-op that still costs a compositing layer
every frame of the vault spring), and it would only read over the streaks, where content isn't.

**`--gate-scrim` is a contrast fix, not decoration.** Measured, the void is `#F9F8FB` (light) /
`#141318` (dark); `--card` is `#FFFFFF` / `#181B20`. Card-on-void is **1.02:1** — the card would
read only as a shadow, and in dark that shadow is black on black. The scrim composites over the
photograph and pushes the surround away from `--card` so elevation still means something. Any
future full-bleed surface owes the same measurement before it ships.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--gate-image` | `BG_AEGIS01.webp` | `BG_AEGIS02.webp` | the gate's backdrop — Welcome + Login only |
| `--gate-scrim` | `rgba(15,23,42,0.07)` | `rgba(0,0,0,0.34)` | pushes the void away from `--card`; low enough that the streaks survive |

Assets are WebP — **171 KB total, down from 8.4 MB of PNG**. Light is `<link rel=preload>`ed
(default theme); dark loads on toggle.

## The Canvas Model (Entry Point)

A soft, cool off-white canvas with pure white **borderless** cards floating on ultra-soft,
large, diffuse shadows. Depth comes from elevation, not from borders. Type hierarchy is a
slate ramp: maximum-contrast headings, clearly muted secondary text.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--canvas` | `#F8F9FA` | `#0F1115` | page background — never pure white |
| `--card` | `#FFFFFF` | `#181B20` | every card, panel, modal — borderless |
| `--card-sunken` | `#F1F5F9` | `#1E2228` | inset regions, icon chips |
| `--ink` | `#0F172A` | `#F2F3F5` | headings — maximum contrast |
| `--ink-2` | `#475569` | `#A8ADB7` | body, descriptions |
| `--ink-3` | `#5D6B81` | `#8A90A0` | captions, placeholders — AA (≥4.5) even on `--card-sunken` |
| `--line` | `#E2E8F0` | `#282C33` | dividers, input borders (not cards) |
| `--accent` | `#2563EB` | `#3B82F6` | THE vibrant blue (text, icons, rings) |
| `--accent-solid` / `-hover` | `#2563EB` / `#1D4ED8` | same as light | primary-button fill — white label stays AA in both themes |
| `--accent-soft` | `#DBEAFE` | `#1E3A8A` | chips, focus rings, icon-chip hover tint |
| `--elev-1` / `--elev-2` | diffuse neutral stacks | deeper black stacks | rest / hover+modal float |
| `--elev-accent` | blue at 18–35% | blue at 25–40% | **primary buttons only** — the one colored shadow |

Rules: color appears only where it carries meaning. Status chips are soft-background +
strong-text. The single colored shadow in the system lives on the primary action; it is a
pop, not a glow — nothing else may cast color. Dark mode is the same design with inverted
values (theme lives in React state only — never storage).

## The Hatch — the AEGIS signature texture

```css
background-image: repeating-linear-gradient(45deg,
  var(--line) 0px, var(--line) 1px, transparent 1px, transparent 5px);
```

**One meaning, everywhere: SOLID = the system can see this. HATCHED = the system cannot.**
Vault ciphertext, projected chart bars, empty slots, failed disks, denied permission cells,
skeleton loaders, pending defense layers. In the Entry app it appears in exactly one place:
the pending layers of the login's Defense-in-Depth indicator.

`.hatch-fine` (0.5px stroke / 4px gap, `--ink-3` at 42%) is the same 45° grammar tuned for
slim rows — at 34px the 1px/5px original reads as fill rather than texture. Same meaning,
same angle; only the weight changes.

### The Defense-in-Depth readout

Layers 0–3 are a **terminal readout**, not chips: a stepper spine down the left (the connector
below a passed node carries `--ok`, so the spine fills downward as the server answers), then a
hairline-ruled row of mono label + description. No pill, no fill — state is carried by ink
colour, the node glyph, and whether the hatch is still there. Rows stack flush; the rules and
the spine do the separating so it reads as one instrument. `@container`: below 260px the
description drops (it is the layer's *mechanism*, not its *state*, and truncates to noise —
"Encryptio…"); the label and node still carry full status.

## Shape & Type

- Pills (`999px`) for every button, chip, toggle, input. `20px` major cards, `12px` tiles,
  `8px` reserved for the audit ledger (deliberately harder material, Drive only).
- **Inter** (variable) with **IBM Plex Sans Thai** fallthrough; **JetBrains Mono** for
  hashes, IPs, countdowns. `tabular-nums` on every number.
- Page title 30–34/600 tracking −0.02em · card title 16–17/600 · body 14/400 `--ink-2` ·
  caption 12–13/500 `--ink-3` · table headers 12/600 uppercase tracking 0.06em.
- Thai `line-height ≥ 1.7`; tone marks must never clip.

## Motion

Fast, crisp, functional — if an animation makes the user wait, it is wrong.

- One easing: `cubic-bezier(0.32, 0.72, 0, 1)`. Durations 120 / 240 / 400 ms.
- Numbers count, never snap (~700ms). Tables populate progressively (~25ms stagger).
- Never a spinner; skeletons are hatched. Inline progress only.
- Hover: `translateY(-2px)` + elev-1→elev-2. No glow, no scale-up, no color wash. The
  **press** is the one scale in the system (`0.98`, buttons + module cards) — a control
  yielding under a finger is feedback, not decoration. Inputs never scale: it re-rasterizes
  text mid-typing, and a field that moves as you aim at it reads as a bug.
- **CSS owns shadow, framer-motion owns transform — never both.** A CSS animation's `both`
  fill silently outranks framer's inline style, so a `rise-in` entrance on a card would eat
  its own `whileTap`. Any element framer animates must have no CSS transform on it.
- Signature moments: the Entry vault expansion (Welcome→Login: ONE shared card springs
  from compact to split — brand left, lock right, stacked < md — framer-motion `layout`
  spring, bounce 0.15 / 0.6 s; the one sanctioned exception to the house easing), the
  login cascade (hatch wipes away layer by layer, gated on the server's auth response),
  the Vault unlock wipe, the RAID rebuild fill (Drive).
- `prefers-reduced-motion`: everything collapses to 1ms; every state also reads statically.

## Security grammar (both apps)

Uniform auth errors; no role selector anywhere; default-deny module/nav resolution;
unauthorized UI is never rendered into the DOM (filter before `.map()`); sessions live in
React memory only (production: HttpOnly + Secure + SameSite=Strict cookie) — each decision
carries a Thai comment for the graders.
