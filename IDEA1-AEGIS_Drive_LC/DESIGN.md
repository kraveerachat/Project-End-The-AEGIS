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
  ledger: "10px"
  tile: "16px"
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

**Creative North Star: "The Precision Ledger"**

AEGIS Drive_LC should feel like a trustworthy instrument for files, access, and system state: crisp, calm, and exact. The default is Thai, light, and comfortable-density. White paper-like surfaces sit on a cool gray canvas; near-black ink does the work; one restrained blue identifies action and selection.

Security is visible through behavior, not theatre. The interface reports only measured server state, never invented telemetry. Motion is brief and functional (120–400 ms), and every transition collapses under reduced-motion preferences. Glow, bloom, glassmorphism, backdrop blur, dark aurora gradients, particle fields, orbs, and generic SaaS hero-metric styling are prohibited.

**Key Characteristics:**

- Thai-first information architecture with English and Chinese parity.
- Solid surfaces, precise alignment, tabular numerals, and restrained color.
- Diagonal hatch has one semantic meaning: the system cannot see or verify the content.
- Server-decided identity and role are displayed; never simulated in the client.

## 2. Colors

The palette is cool, high-contrast, and mostly neutral; color always communicates state or action.

### Primary

- **Instrument Blue:** The only interaction accent, used for primary actions, active navigation, focus, and one key chart series.

### Neutral

- **Cool Canvas:** The page field that separates solid working surfaces.
- **Paper Surface:** Cards, menus, and form housings.
- **Ledger Ink:** Primary text and measured values.
- **Slate Annotation:** Supporting copy and captions; caption gray never carries essential instructions.

### Named Rules

**The One Blue Rule.** Blue identifies action or selection. It must never become ambient decoration.

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

The system uses solid tonal layering plus two diffuse neutral shadows. Borders define structure; shadows separate temporary overlays or important surfaces without producing glow.

### Shadow Vocabulary

- **Ambient surface** (`--elev-1`): ordinary cards and the resting sign-in surface.
- **Raised overlay** (`--elev-2`): dropdowns, drawers, and modal-level surfaces.

### Named Rules

**The Neutral Shadow Rule.** Shadows are neutral and low-contrast. Colored shadows, bloom, and glass effects are forbidden.

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

Sidebar groups use compact labels, real server-filtered destinations, and a single blue active state. On mobile, the sidebar becomes a drawer; unavailable capabilities do not remain as teaser items.

### Hatch Surface

The 45-degree one-pixel hatch is the product signature. It marks ciphertext, loading skeletons, empty unavailable regions, or information the system cannot measure. It never means decoration.

## 6. Do's and Don'ts

### Do:

- **Do** default to Thai, Light, and Comfortable density for a new account.
- **Do** use solid white cards on the cool gray canvas and reserve Instrument Blue for action.
- **Do** keep focus visible, keyboard paths complete, and touch targets at least 44px where practical.
- **Do** label unimplemented or unmeasured states honestly with hatch and explanatory copy.
- **Do** use server-owned preferences, identity, RBAC, health, and telemetry.

### Don't:

- **Don't** use glow, bloom, glassmorphism, backdrop-blur, dark aurora gradients, particle fields, orbs, or colored shadows.
- **Don't** use generic SaaS dashboards: cream themes, gradient CTAs, or hero-metric templates.
- **Don't** use consumer-playful onboarding voice, emoji, or exclamation marks.
- **Don't** surface security mechanics as role pickers, “admin only” teasers, or verbose authentication errors.
- **Don't** invent success telemetry, storage health, notifications, or backup state to make a screen look complete.
