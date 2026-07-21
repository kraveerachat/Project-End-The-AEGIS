# Design

Visual system for the AEGIS platform. The Entry Point now runs **"Modern Elevated UI"** — the
premium-SaaS evolution of "Precision Light" (which itself replaced "Aurora Glass" v2). Still
banned: glow-as-decoration, bloom, backdrop-blur, glassmorphism, dark aurora fields, particle
canvases, orbs. Token source of truth is each app's `src/index.css`.

- `HUB-AEGIS_Entry` — the Entry Point (Welcome → Login → Hub launcher), Modern Elevated UI,
  light + dark themes. Three screens, nothing else.
- `IDEA1-AEGIS_Drive_LC` — AEGIS Drive, the NAS control panel (its own brief, Build Brief v3,
  still on the flat/bordered Precision Light tokens).
- `IDEA2-AEGIS_Monitor` — AEGIS Monitor, the SOC CCTV HUD — **the one documented dark
  exception** (see "The Monitor exception" at the end of this file).

## The Gate's Atmosphere (Welcome + Login only)

All three Entry screens are full-bleed: `BG_AEGIS01` (light) / `BG_AEGIS02` (dark), swapped via
`--gate-image`, `cover / center`. Their fibre streaks converge on an empty centre — the hero
sits in that void and the streaks point at it.

**The photograph ends where the Entry Point ends.** Door, lock and Hub share it because all
three are the same act: arriving. PRODUCT.md — *the hub is a threshold they pass through, not
a place they linger*. The work happens inside Drive / CCTV / Monitoring, and those keep their
own plain canvas. The line is not "gate vs. Hub", it is **entry vs. workspace**.

**The door is boxless.** Nothing stands between the user and the machine until they commit:
mark, wordmark, tagline and the one ENTER button sit directly on the photograph. On ENTER the
vault materializes around the lock. A surface is a housing for a mechanism — the lock needs
one, the threshold does not. A card at the threshold is the SaaS reflex, and it wastes the
photograph it is covering.

The image is atmosphere, never a surface to put UI on — with one exception, the hero, which
earns it by being nothing but type and a mark. That is also why the gate needs no glass:
`backdrop-filter` over these assets would blur a near-flat gradient (a no-op that still costs
a compositing layer every frame of the vault spring), and it would only read over the streaks,
where content isn't.

**Anything set directly on the photograph must be measured against the photograph**, not
against a token. `--ink-3` on the tagline measures **3.34:1** at desktop light — at that width
the tagline reaches the fibre streaks, and one grey streak behind it (backdrop luminance 0.598)
eats the margin the halo was carrying. The hero runs `--ink` (14–17:1) and `--ink-2` (4.7–8.7:1);
**`--ink-3` never touches the bare photograph.** Measure worst-case per pixel, both themes,
both widths — hide the element, screenshot what is behind it, take the min and max luminance.

The halo is not optional decoration, it is what makes that pass. The Hub index without
`.hub-halo` measures **3.04:1 light / 1.39:1 dark** on the row description — dark fails because
a bright violet fibre tip (L 0.286) crosses behind it, and at that point *no* text colour
works, not even pure `--ink`. With the halo: 6.3:1 / 7.1:1.

**`--gate-scrim` is a contrast fix, not decoration.** Measured, the void is `#F9F8FB` (light) /
`#141318` (dark); `--card` is `#FFFFFF` / `#181B20`. Card-on-void is **1.02:1** — the card would
read only as a shadow, and in dark that shadow is black on black. The scrim composites over the
photograph and pushes the surround away from `--card` so elevation still means something. Any
future full-bleed surface owes the same measurement before it ships.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--gate-image` | `BG_AEGIS01.webp` | `BG_AEGIS02.webp` | the gate's backdrop — Welcome + Login only |
| `--gate-scrim` | `rgba(15,23,42,0.07)` | `rgba(0,0,0,0.34)` | pushes the void away from `--card`; low enough that the streaks survive |
| `--gate-halo-1/2` | white `0.8` → `0.36` | near-black `0.88` → `0.44` | **Welcome only** — calms the streaks behind the boxless hero |
| `--hub-halo-1/2` | white `0.84` → `0.5` | near-black `0.9` → `0.64` | **Hub only** — wider, flatter, never fades; the index is 880px of small text lying across the streaks |
| `--hairline` | ink at `0.14` | white at `0.14` | rules drawn *on* the photograph; `--line` measures ~1.2:1 there and vanishes |
| `--elev-0` | transparent ×2 | transparent ×2 | the shadow `.vault-surface` animates *from*; same layer count as `--elev-2` or the transition cannot interpolate |

The halo is a radial ellipse (two stops — one stop to `transparent` bands across 700px) and
**must not be baked into `.gate-bg`**. It inverts per theme (light brightens the centre, dark
deepens it) so the ink's opposite end always wins. It fades out exactly as the card fades in:
`--gate-scrim` exists to keep `--card` off the void, and a halo that brightens the centre in
light mode would hand that 1.02:1 problem straight back the moment the vault materializes.

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
| `--accent-bloom` | `#60A5FA` | same as light | the bloom on a sparkle button — blue-400, one stop up the same ramp; a value change, not a hue shift |
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

## The module index (Hub)

The Hub is boxless too. Three identical icon + heading + text cards were the one thing in the
app that read as generic SaaS — and glass would not have fixed that, only made the same three
boxes shiny. **Frosted glass on a cyber backdrop is the most-generated look of the last five
years**; reaching for it to escape "generic" lands you deeper in it. A card is also the thing
standing between the user and the photograph: the way to show the image is to put nothing on
top of it.

So: hairline rules, no surfaces. Icon · title (`clamp(18px, 1.9vw, 26px)`, bold, `--ink`) ·
description (`--ink-2`) · arrow. Hover wipes an 11% `--accent` wash in from the leading edge,
the rule under the row lights to 70% accent, the arrow slides. Press is `0.98`.

It degrades honestly: a `user` sees only Drive, and **one row reads as deliberate where one
card read as broken**. Left-aligned — the door is centred because you are looking at it; here
you have arrived and you are reading.

Measured, for the record: `bg-white/60` over this backdrop lands the card at **1.09:1**, and
`border-white/20` on a light backdrop of L 0.87 is a white border on near-white. Glass here
also only blurs something in *light* mode — behind the centre card in dark the backdrop varies
by **sd 0.0017**, i.e. nothing to smear.

### The luminous module card

Every module is a `.lum-card`: a machined device with a slot in its face that lights AEGIS
blue. `auto-fit` grid, `justify-center` — the column count is not fixed (`user` has ONE module,
`admin` three), so a hard `grid-cols-3` would park a lone card in the left third. auto-fit
collapses the empty tracks and centres whatever survived, 1 or 3, with no branching. The floor
of the `minmax()` must be real (280px): auto-fit derives its track count from the **minimum**,
so `minmax(0, …)` gives it nothing to divide by. Gap is `3rem`, not `2rem` — each card's
bracket frame paints 1rem *outside* its box, so a 2rem gap puts two brackets in the same pixel.
The container is 1080px (three 20rem cards + two 3rem gaps = 1056); the old 880 predates them.

**Two substrates, one mechanism.** Every colour in the card is a `--lum-*` token, declared in
both themes:

| | light | dark |
|---|---|---|
| housing | `#ffffff → #eef2f7` frosted silver | `#3a3a3a → #1a1a1a` obsidian |
| the slot, dead | `#aab4c2` — a shadowed groove | `#121212` — a hole |
| **the light** | `#2563eb` | `#3b82f6` — **blue in both; never white** |
| folds | ink `15 23 42` @ 0.3 | black @ 0.5 |
| ink | `#0a0a0b` / `#52565e` | `#ffffff` / white @ 72% |

**Light mode is a blue LED in white hardware, not light escaping darkness.** That premise needs
a dark substrate: nothing is brighter than white, so a white-hot bloom on a silver card is a
physical impossibility rather than a tuning problem. What white hardware *does* do is exactly
this — a recessed groove reads grey when dead, lights saturated blue when live, and bleeds a
halo onto the silver. Which is why `--lum-lumen-lit` is **0.2 in light and 0.5 in dark**: blue
over near-white only *subtracts* luminance, so past ~0.25 the cone stops reading as a shaft and
starts reading as blue fog sprayed on the lid. On this substrate the saturated slot IS the
light and the cone is only its bleed. Same reason `--lum-icon-live` is `saturate()` in light
and `brightness()` in dark — brightness on a light card bleaches the icon out.

**The face is the control, so the face lights.** The card is one `<button>`: one tab stop, one
accessible name, reachable in 5 tabs, opened with Enter, **zero focusable descendants**. Hover
is not a warm-up any more — it is the event. Slot to full `--lum-glow`, cone to
`--lum-lumen-lit`, folds deepened, icon backlit; `:hover`, `:focus-visible` and `.is-live` are
one selector list so keyboard and pointer render *identically*, which is the whole reason this
is a button and not a div with a handler.

There used to be a switch bottom-right — `aria-hidden` hardware that reported state without
being a control. It went when hover took over the light. It was reporting, in a 4.8rem widget
with five inset shadows, the one thing the whole housing now says by lighting up; and it cost
the description a `padding-right: 5.6rem` gutter and a `border-bottom` to sit on. **A state
indicator next to something that already indicates that state is clutter, not redundancy.**
What survives is the escalation: hover lights the SLOT, committing lights the DEVICE
(`.is-live` adds the glow ring). `live` is React state, not `:active`, so it holds through the
"Entering…" beat instead of dying with the pointer — by then the pointer has usually left.

Measured (worst pixel behind each glyph, method: hide the text, screenshot the housing, take
the worst pixel in the glyph's box):

| | light | dark |
|---|---|---|
| rest | 15.5 / 6.2 | 17.4 / 9.5 |
| hover · focus | 11.2 / 5.2 | 17.4 / 9.5 |
| live | 11.2 / **4.9** | 17.4 / 9.5 |

The light-mode live description is the tightest number in the card, and **the hover rewire is
what made it load-bearing**: at 0.2 the cone darkens what is behind it, and `lit` is now the
state the card sits in whenever a pointer is on it rather than a beat you pass through. Raising
`--lum-lumen-lit` past 0.2 fails AA there. So does `.is-live`'s bottom inset above **0.36** —
that shadow was `0.5` and measured **4.34:1**, a real AA failure, because the description's
`padding-bottom` left with the switch and dropped the text into the shadow's densest band.
Capped at 0.36 it measures 4.89. Below ~0.26 the number plateaus at hover's 5.15, i.e. the
shadow has stopped touching the text and there is no layer left to have. Same rule as the
sparkle button: **every layer is capped by its label, not by its own good looks.**

Type: title `1.375rem/700` (it is the only heading on a 20rem face — 1.2rem/600 was a label);
description `0.875rem` at **line-height 1.7**, not `1.625` — `:lang(th)` sets a 1.7 tone-mark
floor and this copy is Thai by default, and `.lum-desc` wins on source order, so it has to
carry the floor itself. The icon is `56px` with `strokeWidth` held at `1.5`: the box nearly
doubled while the line did not, so it thins optically into an engraving instead of a scaled-up
glyph. It sits at `top: 4.25rem` — centred in the upper half, 4.25rem of face above it and
4.25rem between its foot and the slit's centreline at 12rem.

Two source values could not come across: `font-weight: 100` (IBM Plex Sans Thai only ships
400/500/600/700 here, so it would synthesise a fake light on Thai) and `max-width: 64%` on the
description (it was `padding-right` to dodge the switch; with the switch gone the text simply
spans the face). The source's two fold shadows were `11.5rem` = 64% of its 18rem card, i.e. the
same 64% the slit is wide; as `rem` they landed *inside* the slot the moment the card changed
width, so **every horizontal landmark in this card is a percentage**. The height stays fixed at
24rem: the light's geometry is tuned to it.

## Shape & Type

- Pills (`999px`) for every button, chip, toggle, input. `20px` major cards, `12px` tiles,
  `8px` reserved for the audit ledger (deliberately harder material, Drive only). **The pill
  is not negotiable per-component.** The sparkle button arrived as a 0.75rem control with a
  folded corner; the fold was dropped and the pill kept. On the login form that button sits
  directly under two `h-12` pill inputs — a 12px CTA there reads as imported, not designed,
  and "the save button looks different in two places" is the one thing product UI cannot
  afford. A borrowed effect adapts to the system or loses the part that will not fit.
- **Inter** (variable) with **IBM Plex Sans Thai** fallthrough; **JetBrains Mono** for
  hashes, IPs, countdowns. `tabular-nums` on every number.
- Page title 30–34/600 tracking −0.02em · card title 16–17/600 · body 14/400 `--ink-2` ·
  caption 12–13/500 `--ink-3` · table headers 12/600 uppercase tracking 0.06em.
- **The door's lockup: both gaps on the wordmark, both in `em` (`0.38em`).** Three rules, each
  learned by getting it wrong:
  - **A fixed px gap under fluid type is an arbitrary gap.** em resolves against the element's
    own font-size, so one value rides `clamp(52px, 13vw, 124px)` and then down to the lock's
    46px. Px measured 0.065em of the wordmark at 1440 and 0.15em at 320 — tightest exactly
    where the wordmark was largest.
  - **What reads is the RATIO of the gap above the wordmark to the gap below it**, not either
    one alone. The eye compares them. Scaling only the bottom gap is what a "cramped subtitle"
    complaint tempts you into, and it made the phone *worse*: a fixed 40px top gap does not
    shrink with the wordmark, so the ratio ran **2.1 at desktop and 3.85 at 390px** — tagline
    welded on, mark floating free. Equal em on both holds it at **1.26–1.59** everywhere.
  - **Set it generous, not merely correct.** `productTag` renders **~1.9× wider than "AEGIS"**.
    A long thin tracked-caps line close under a short fat word stops reading as a subtitle and
    starts reading as a rule underlining the wordmark. Width is why it needs air.
  - Measure **baseline → tagline cap-top**, never the box gap: `leading-[0.82]` puts the
    baseline ~0.05em off the box bottom, so box numbers lie. Now **0.48–0.53em** of the
    wordmark in every state. Equal em is not equal optically — the mark PNG's ~6% transparent
    footer (40 of 642 rows) lands the top gap ~1.3× the bottom, which is the grouping we want
    (mark apart, wordmark+tagline paired). **Reskinning the mark changes that; re-measure.**
  - One owner per gap, so the morph has nothing to keep in sync: sampled every frame through
    the spring it interpolates with zero collision frames.
- **`pt-24` on the gate was 96px of nothing.** The header chrome is `absolute` (y 20–56) so the
  padding never cleared it, and `my-auto` — not the padding — centres the hero. It only biased
  the hero 28px below centre while eating the height budget the lockup needed. `pt-16`.
- Thai `line-height ≥ 1.7`; tone marks must never clip. The rule is enforced by an
  **unlayered** `:lang(th)` in `index.css` — keep it unlayered (see Cascade traps), and note
  it matches the *document's* language, not the *element's* glyphs. Latin-only elements
  inside a Thai page (the `AEGIS` wordmark, `productTag`) carry `lang="en"` so it correctly
  does not apply to them.

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
- **The door's idle** (Welcome only): the hero mark levitates `y: [0,-15,0]`, 4.6s,
  easeInOut, infinite. The one sanctioned decorative loop in either app, and it is only
  sanctioned here — the Welcome state has no task, and the user's entire job is to look at
  the machine and press one button. It stops the instant the lock appears. Off completely
  under `prefers-reduced-motion` (not merely suppressed — an infinite compositor loop is a
  battery cost, so it must never start).
- **The sparkle button** (`.sparkle-btn`): the primary action given a face — a
  `--accent-bloom` glow off the bottom edge and ten points drifting up through it. It is the
  door's ENTER and the lock's submit; a second one on the same surface would make neither of
  them the point. Its `sparkles` prop is this carve-out expressed in code, not a style knob:
  - `idle` — points loop forever. **Welcome only**, on exactly the licence the mark's
    levitation holds: no task on screen, and the user's whole job is to look at the machine.
  - `hover` — points only while pointed at or focused. **Everywhere there is a task.** On the
    login form the button is `disabled` while `busy`, and `:disabled` kills the points even
    under the cursor — the Defense-in-Depth cascade is the loading state and must be the only
    thing claiming to be one. A button sparkling through the cascade is a second, fake
    progress signal competing with the real one.
  - Under `prefers-reduced-motion` the points never start (same reasoning as the levitation).
    The button still reads completely: fill, bloom, sheen and label are all static.
- **Every layer on a colored button is capped by its label, not by its own good looks.** White
  on `--accent-solid` is 5.17:1 — AA with 0.67 to spend, total. The source this effect came
  from ran a 0.8-alpha bloom at a 65.28% radius and a 0.19 sheen; measured behind the label
  those land at **3.76:1** and **4.17:1** — it fails AA on its own text. Ours: bloom 0.7 at a
  34% radius (spent *below* the label), sheen 0.10 gone by 62%, hover darkens the base to
  `--accent-solid-hover` before it grows the bloom. Measured worst pixel behind the label:
  **4.58–5.09:1** across rest/hover × Welcome/Login × both themes. Both themes come free —
  `--accent-solid` and `--accent-bloom` are theme-invariant, so the button's interior is one
  fixed material. Re-measure if any of those three numbers move.
- Signature moments: the Entry vault materialization (Welcome→Login: the boxless hero
  shrinks and glides into the left brand panel while the card fades up around the lock —
  brand left, lock right, stacked < md — framer-motion `layout` spring, bounce 0.15 / 0.6 s;
  the one sanctioned exception to the house easing), the login cascade (hatch wipes away
  layer by layer, gated on the server's auth response), the Vault unlock wipe, the RAID
  rebuild fill (Drive).
- **`layout` and a looping transform cannot share an element.** The mark's levitation lives
  on a child of the `layout` node: one element writing `transform` twice means the loop
  fights its own landing. Nest, don't merge.

## Full-bleed traps

Two bugs the photograph exposed that a flat canvas had been hiding. Both cost real time; both
are structural, not visual.

- **`min-height: 100%` against an auto-height parent resolves to nothing.** The Hub sat inside
  an App wrapper with `height: auto`, so its `min-h-full` collapsed and it rendered **774px
  tall in a 900px viewport**. Invisible for months because it painted `bg-canvas` — the same
  colour as the body. The moment it took the photograph, the body showed through as a seam
  across the page. Fix: the wrapper is the flex column that owns the viewport height, the
  screen is `flex-1`. **If a screen paints anything other than the body colour, prove it
  reaches the bottom of the viewport.**
- **Scrims tuned for a flat canvas are transparent over an image.** The "Entering module…"
  overlay was `--canvas` at 55%; on the photograph the streaks read straight through the
  modal. It is 82% now. Any scrim's alpha is a function of what is *behind* it.
- `prefers-reduced-motion`: everything collapses to 1ms; every state also reads statically.

## Cascade traps

- **An unlayered rule beats every Tailwind utility, silently.** `:lang(th) { line-height: 1.7 }`
  sits at the top level of `index.css`; `@import "tailwindcss"` puts utilities in
  `@layer utilities`. Unlayered declarations outrank *all* layered ones — so **every
  `leading-*` class in this app was dead for as long as the page was Thai**, with no warning
  and no devtools strikethrough on the class you'd think to inspect. The door's wordmark asked
  for `leading-[0.9]` and rendered at `1.7`: **211px against the 102px it authored**, ~54px of
  phantom half-leading under the baseline. That gap *was* the "too much space under AEGIS",
  and it pushed the door to **981px of content in a 900px viewport** — the one button the
  screen exists for, under the fold, for months.
- **Do not fix it by layering the Thai rule.** Unlayered is *why* the tone-mark floor cannot be
  overridden by an accidental utility, which is exactly what the Thai rule is for. Fix it where
  it is actually wrong: the rule matches the **document's** language, and the wordmark is five
  Latin caps in every language. `lang="en"` on the element, and it correctly stops matching.
- **The door has a height budget, not just a width one.** It is a fixed stack — mark, wordmark,
  tagline, one button — and the mark is by far the largest term. Sized on width alone it gave a
  1366×768 laptop the full 360px mark and pushed ENTER off-screen. The mark now steps to 288 below
  `min-height: 860px`. **If a screen's whole job is one button, prove the button is above the
  fold at 1280×720, not just at 1440×900.**

## Security grammar (both apps)

Uniform auth errors; no role selector anywhere; default-deny module/nav resolution;
unauthorized UI is never rendered into the DOM (filter before `.map()`); sessions live in
React memory only (production: HttpOnly + Secure + SameSite=Strict cookie) — each decision
carries a Thai comment for the graders.

## The Monitor exception (IDEA2-AEGIS_Monitor)

AEGIS Monitor is deliberately a **dark ops console** — the one place the platform's
glass/glow ban does not apply. This is a decision, not a leak of the old Aurora direction:

- **The scene forces the theme.** A SOC operator watches video walls in a dim room on a
  12-hour shift. Video is the content, video is dark, and a light chrome around live
  footage blooms over the thing being watched. Entry and Drive are documents-and-controls
  surfaces; Monitor is a viewport.
- **The line is entry vs. workspace vs. observation.** The gate keeps its photograph, the
  work apps keep Precision Light / Modern Elevated, and the observation room keeps the
  dark. A user crossing from the Hub into Monitor is walking into a different physical
  room, and the UI says so.
- **What the exception licenses** (source of truth: `IDEA2-AEGIS_Monitor/src/index.css`,
  contract: the "AEGIS HUD" Claude Design mock): the `#050B14` canvas, glass panels with
  backdrop-blur, ambient orbs, the teal/amber/red semantic triad (teal = authorized,
  amber = unknown, red = record/critical), corner-bracket feed chrome, and the scanline.
- **What still binds it:** motion conveys state and every loop dies under
  `prefers-reduced-motion`; WCAG AA contrast (filled badges use `--red-solid #E4123F`, not
  raw `--red`, for exactly this reason); real buttons, focus rings, keyboard paths; the
  severity rail is carried by border + type color, never a side-stripe; and glow is
  semantic (status, focus, alerts) — never decoration on numbers or body text.
- **The hatch stays honest at the system level:** inside Monitor the hatched surface is
  the stand-in for a video stream the *demo* cannot show (the system genuinely is not
  seeing pixels there); empty states reuse it in its canonical "cannot see" meaning.
  When real WebRTC frames land, the hatch disappears with the limitation.
