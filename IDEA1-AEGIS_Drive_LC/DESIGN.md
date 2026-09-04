---
name: AEGIS Drive_LC
description: A precise, Thai-first control panel for a self-hosted secure drive.
colors:
  primary: "#2563eb"
  primary-soft: "#eff6ff"
  primary-ink: "#1d4ed8"
  canvas: "#f8fafc"
  surface: "#ffffff"
  surface-sunken: "#f1f5f9"
  ink: "#0f172a"
  ink-secondary: "#475569"
  ink-caption: "#94a3b8"
  line: "#e2e8f0"
  success: "#10b981"
  warning: "#f59e0b"
  danger: "#ef4444"
  slate-dark: "#334155"
  danger-light: "#fca5a5"
  neo-light-warning: "#945600"
  neo-blue-step: "#4267e7"
  neo-violet: "#7c3aed"
  neo-violet-light: "#a78bfa"
  neo-focus-blue: "#60a5fa"
  neo-pink: "#be5a93"
  neo-pink-dark: "#b8558e"
typography:
  headline:
    fontFamily: "Inter Variable, IBM Plex Sans Thai, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Inter Variable, IBM Plex Sans Thai, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "Inter Variable, IBM Plex Sans Thai, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.04em"
rounded:
  focus: "4px"
  skeleton: "6px"
  compact: "8px"
  preview: "9px"
  ledger: "10px"
  control: "12px"
  tile: "16px"
  shell: "18px"
  card: "24px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.pill}"
    padding: "10px 16px"
    height: "40px"
  button-outline:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "10px 16px"
    height: "40px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "24px"
  input:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.ink}"
    rounded: "{rounded.ledger}"
    padding: "10px 16px"
    height: "44px"
---

# Design System: AEGIS Drive_LC

## 1. Overview

**Creative North Stars: "The Precision Ledger" (Classic) and "The Layered Instrument" (Neo)**

AEGIS Drive_LC should feel like a trustworthy instrument for files, access, and system state: crisp, calm, and exact. New and existing accounts default to Classic, Thai, Light, and Comfortable density. Interface style, theme, language, and density are independent server-owned preferences.

Classic preserves the established Precision Ledger: paper-like solid surfaces, cool gray canvas, precise borders, and restrained blue action. Neo is an authenticated-shell-only alternative: cool-white shadow-led layers in Light and stepped graphite/navy layers in Dark, with rounded capsule navigation. Static glass is permitted only on the Sidebar, Topbar, Modal, and segmented-control housing. Data and content cards remain solid.

Security is visible through behavior, not theatre. The interface reports only measured server state, never invented telemetry. Motion is brief and functional (120–400 ms), uses transform/opacity for active feedback, and collapses under reduced-motion preferences. Neon overload, animated blur, pervasive gradients, particle fields, orbs, and generic SaaS hero-metric styling remain prohibited.

The Login screen is outside the interface-style system. It never receives `data-ui-style`, is not restyled by Neo, and keeps its established theme and authentication behavior.

**Key Characteristics:**

- Thai-first information architecture with English and Chinese parity.
- Solid data surfaces, precise alignment, tabular numerals, and restrained color in both interface styles.
- Diagonal hatch has one semantic meaning: the system cannot see or verify the content.
- Server-decided identity and role are displayed; never simulated in the client.

## 2. Colors

The palette is cool, high-contrast, and mostly neutral; color always communicates state or action.

### Primary

- **Instrument Blue:** The dominant interaction accent, used for primary actions, active navigation, focus, and one key chart series.
- **Neo Violet / Muted Pink:** Subordinate selection endpoints only. They may reinforce selected, active, and focus emphasis, but never compete as brand colors or become pervasive gradients.

### Neutral

- **Cool Canvas:** The page field that separates solid working surfaces.
- **Paper Surface:** Cards, menus, and form housings.
- **Ledger Ink:** Primary text and measured values.
- **Slate Annotation:** Supporting copy and captions; caption gray never carries essential instructions.

### Named Rules

**The Dominant Blue Rule.** `#2563EB` identifies action or selection. Neo may blend briefly toward violet and muted pink inside selected-state fills; the blend must remain blue-led and may not become ambient decoration.

**The Measured State Rule.** Green, amber, and red appear only when the server provides a corresponding measured state.

## 3. Typography

**Display Font:** Inter Variable (with IBM Plex Sans Thai and system sans fallbacks)

**Body Font:** Inter Variable / IBM Plex Sans Thai

**Label/Mono Font:** JetBrains Mono

**Character:** The pairing is technical without becoming theatrical. Thai glyphs receive extra line height; operational values use monospaced tabular numerals for reliable scanning.

### Hierarchy

- **Headline** (700, 30px, 1.2): page titles only.
- **Title** (600, 16px, 1.4): card and section headings.
- **Body** (400, 14px, 1.5): instructions and normal content; keep explanatory paragraphs under 65ch.
- **Label** (500, 12px, 0.04em tracking): timestamps, breadcrumbs, technical metadata, and compact status labels.

### Named Rules

**The Thai Clearance Rule.** Thai text uses 1.7 line height so tone marks and upper vowels are never clipped.

## 4. Elevation

Classic uses solid tonal layering plus two diffuse neutral shadows. Neo Light uses shadow-led cool-white layers; Neo Dark uses stepped graphite/navy layers. Borders define structure and selected-state shadows stay small and blue-led.

### Shadow Vocabulary

- **Ambient surface** (`--elev-1`): ordinary cards and the resting sign-in surface.
- **Raised overlay** (`--elev-2`): dropdowns, drawers, and modal-level surfaces.

### Named Rules

**The Bounded Material Rule.** Content-card shadows are neutral and low-contrast. Neo selection may use a restrained blue active shadow. Static backdrop glass is bounded to Sidebar, Topbar, Modal, and segmented housing; it is never animated and never applied to data cards.

## 5. Components

### Buttons

- **Shape:** Fully rounded controls (999px) with a 40–48px height.
- **Primary:** Instrument Blue with white text; only the strongest action in a local region.
- **Hover / Focus:** One-step blue shift, 2px focus outline with 2px offset, and 0.98 press scale.
- **Secondary / Ghost:** Solid paper or transparent neutral surface with a one-pixel line.

### Chips

- **Style:** Soft semantic background plus strong text; never saturated fill for passive status.
- **State:** A chip reports state. It is not a button unless it has button semantics and focus behavior.

### Cards / Containers

- **Corner Style:** Gently rounded cards (24px) and internal tiles (16px).
- **Background:** Solid Paper Surface over Cool Canvas.
- **Shadow Strategy:** Ambient surface at rest; raised overlay only when layering requires it.
- **Border:** One-pixel Ledger Line; never a decorative side stripe.
- **Internal Padding:** 20–24px on working surfaces.

### Inputs / Fields

- **Style:** 44px high, sunken solid background, one-pixel border, 10–12px radius.
- **Focus:** Crisp blue outline and border change; no glow.
- **Error / Disabled:** Text plus semantic color; disabled state stays legible and never pretends to work.

### Navigation

Sidebar groups use compact labels and real server-filtered destinations. Classic uses its existing active state. Neo uses rounded capsule rows and a blue-led selected fill with subordinate violet/pink endpoints. On mobile, the sidebar becomes a drawer; unavailable capabilities do not remain as teaser items.

### Interface Style Selection

- Settings → Appearance presents labelled Classic and Neo preview radios.
- Changing style requires an accessible confirmation dialog with focus management and Escape handling.
- The server preference is saved first. Only a successful save ends the UI session and returns to the unchanged Login screen.
- A failed save leaves the current session and style intact and reports the failure truthfully.
- After authentication, the saved style is resolved before the authenticated shell mounts so no half-Classic/half-Neo frame is shown.

### Hatch Surface

The 45-degree one-pixel hatch is the product signature. It marks ciphertext, loading skeletons, empty unavailable regions, or information the system cannot measure. It never means decoration.

## 6. Do's and Don'ts

### Do:

- **Do** default new and existing accounts to Classic, Thai, Light, and Comfortable density.
- **Do** keep interface style independent from theme, language, and density.
- **Do** keep Login visually and behaviorally outside the Classic/Neo system.
- **Do** use solid data cards and reserve Instrument Blue as the dominant action/selection color.
- **Do** keep focus visible, keyboard paths complete, and touch targets at least 44px where practical.
- **Do** label unimplemented or unmeasured states honestly with hatch and explanatory copy.
- **Do** use server-owned preferences, identity, RBAC, health, and telemetry.

### Don't:

- **Don't** apply Neo styling, shell attributes, preview hints, or ambient effects to Login.
- **Don't** apply glass or backdrop blur outside Neo Sidebar, Topbar, Modal, and segmented-control housing.
- **Don't** use neon glow, bloom, animated blur, dark aurora gradients, particle fields, orbs, or pervasive violet/pink gradients.
- **Don't** use generic SaaS dashboards: cream themes, gradient CTAs, or hero-metric templates.
- **Don't** use consumer-playful onboarding voice, emoji, or exclamation marks.
- **Don't** surface security mechanics as role pickers, “admin only” teasers, or verbose authentication errors.
- **Don't** invent success telemetry, storage health, notifications, or backup state to make a screen look complete.
