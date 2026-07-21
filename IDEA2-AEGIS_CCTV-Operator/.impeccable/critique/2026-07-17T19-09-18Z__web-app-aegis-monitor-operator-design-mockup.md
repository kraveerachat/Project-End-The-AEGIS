---
target: AEGIS Monitor Operator UI (design mockup)
total_score: 22
p0_count: 3
p1_count: 2
timestamp: 2026-07-17T19-09-18Z
slug: web-app-aegis-monitor-operator-design-mockup
---
⚠️ DEGRADED: single-context (harness policy — sub-agents not spawned without an explicit user request; Assessments A + B run inline)

**Target:** AEGIS Monitor — Operator UI (design mockup served at `http://127.0.0.1:5175`, rendered via Playwright/Chrome). Evidence: 9 screenshots (login, live, archival, diagnostics, settings, light theme, mobile 390px) + rendered DOM + detector scan. Measured against the AEGIS Knowledge Base (PRODUCT.md + DESIGN.md).

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Rich status *vocabulary* (heartbeat, latency spark, NAS sync, self-check log) but top-bar liveness pills are hardcoded — they read "online/running" even if the engine is down. |
| 2 | Match System / Real World | 3 | Domain language is solid; "NEXT-GEN HUD" subtitle and "Live canvas" lean marketing/artsy for a CCTV console. |
| 3 | User Control & Freedom | 3 | Read-only monitor; scope lock is intentional. Modal has Close + click-out. No alert acknowledge/snooze from live view. |
| 4 | Consistency & Standards | 1 | Internally consistent, but a **different product** from the rest of AEGIS: HUB/Drive are light "Precision Light"; this is dark neon-glass. Two "latency" numbers (4 ms / 38 ms); mixed clock formats (02:04 vs 14:21). |
| 5 | Error Prevention | 3 | Scope locking prevents wrong-camera actions. Little else to get wrong (read-only). |
| 6 | Recognition Rather Than Recall | 3 | Nav is icon **+** text; event stream and recent items visible. Good. |
| 7 | Flexibility & Efficiency | 2 | No keyboard shortcuts, no feed pop-out/fullscreen, no density toggle. One rigid path for an all-shift operator. |
| 8 | Aesthetic & Minimalist Design | 2 | Attractive, but decoration competes with data: scanline animation over the feed, glow on every number, orbs, glass. Product register wants the tool to disappear. |
| 9 | Error Recovery | 1 | No connection-lost / reconnecting / stale-data state for the app↔engine link. Camera-offline is designed; app-offline is not. |
| 10 | Help & Documentation | 2 | Helpful captions ("Scope locked…", empty-state copy). No metric tooltips (what latency is "bad"? what is −42 dBm?). |
| **Total** | | **22/40** | **Acceptable — real gaps before it's operator-ready** |

## Anti-Patterns Verdict

**LLM assessment:** In *dark* mode this does not read as generic AI slop — it's a confident, well-composed cyber-HUD with genuine craft (bracketed feed frame, coherent teal/amber semantic color, a real diagnostics view). The problem is the opposite of slop: it's **on-brand for the wrong brand.** The AEGIS platform is committed to "Precision Light / Modern Elevated UI" — light canvas, near-black ink, one blue, restraint — and DESIGN.md/PRODUCT.md **explicitly ban** glow-as-decoration, bloom, glassmorphism, backdrop-blur, dark aurora fields, and orbs. This mockup uses **every one of those** as load-bearing style (`backdrop-filter: blur(20px)` on topbar/sidebar/cards, `.orb` radial blurs, teal `box-shadow`/`text-shadow` glow, `#050B14` aurora field, a scanline keyframe). It is a near-total inversion of the platform's committed language.

It also **inverts the signature texture's meaning.** DESIGN.md Principle #1: the diagonal hatch means SOLID = "the system can see this," HATCHED = "it cannot" (denied/ciphertext/pending). Here the hatch is the *live video feed* background and the clip thumbnails — i.e. the texture that means "cannot see" is used for the camera that is actively seeing. One texture, opposite meaning.

**Deterministic scan:** `detect.mjs` on the rendered DOM → 1 warning: **overused font** (`Space Grotesk`). No other automated hits (the detector doesn't carry the AEGIS-specific banned list; the glow/glass/orb violations above are knowledge-base findings, not generic ones).

**Visual overlays:** Not injected (no user-visible overlay was created). Evidence is the 9 rendered screenshots instead.

## Overall Impression

Genuinely handsome and, in dark mode, professional — but it's a **beautiful stranger** to the AEGIS platform, and three operator-critical behaviors are missing (connection-failure handling, the aggregate role view, and any working small-screen layout). The single biggest opportunity: decide, deliberately, whether Monitor keeps this dark "operations console" identity or re-skins to Precision Light — then fix the three functional gaps regardless of that answer.

## What's Working

1. **The Camera-diagnostics view is the strongest screen** — LAN-latency sparkline, a clean 6-tile vitals row (frame rate, resolution, uptime, disconnects, **Last NAS clip sync · 2m ago · OK**, signal), and a pass/fail self-check log. This answers "is the pipeline healthy?" at a glance and reads professionally.
2. **Semantic color is disciplined:** teal = authorized, amber = unknown, red = record — applied consistently across bbox tag, event stream, clip segment bars, and result chips. A viewer learns it once.
3. **Scope is communicated honestly** in the operator view: "Scope locked," locked filters, disabled camera dropdown, "this camera only" — the constraint is visible, not hidden.

## Priority Issues

- **[P0] Off-platform design language.** Glow/glass/orbs/dark-aurora are banned by DESIGN.md; this uses them as the core aesthetic, and the hatch texture's meaning is inverted. A user crossing from HUB/Drive (light, restrained) into Monitor sees a different product.
  **Fix:** Pick one path and commit. (a) Re-skin to Precision Light tokens (light canvas, white surfaces, one blue, drop backdrop-filter/orbs/scanline, reserve hatch for "cannot see"); or (b) if a dark ops-console is a deliberate, documented exception for the *workspace* apps, add that decision to DESIGN.md and still cut the decorative glow/scanline so data leads. **Suggested command:** `/impeccable quieter` (strip the glow/scanline/orbs), then `/impeccable colorize` if re-skinning to light.
- **[P0] No connection-failure or stale-data state (your Q2).** The mockup has no network layer at all; the header pills ("Edge node: online," "AI engine: running," "LAN · 4 ms") are static and would keep asserting "online" if the WebSocket to the engine dropped. For a security monitor, silently showing stale "all good" is dangerous.
  **Fix:** Design the disconnected/reconnecting/stale states: header pill flips to "Engine: unreachable" (red), live feed shows a "Connection lost — last frame HH:MM:SS" overlay, metrics grey out with a "stale" badge, an auto-reconnect toast. The vocabulary is half-there (`edgeStatus: online|degraded`, `diagHealth: operational|degraded|offline`) but the app-link failure is undesigned. **Suggested command:** `/impeccable harden`.
- **[P0] Mobile/responsive is broken.** At 390px the fixed 238px sidebar + non-collapsing `grid-template-columns:238px 1fr` cause heavy horizontal overflow: header pills clip off-screen and the "Live canvas" heading truncates to "Live canva." This trips the absolute ban on text overflowing its container.
  **Fix:** Collapse the sidebar to a drawer/bottom-nav under ~900px, make `.live-grid`/`.stats`/`.vitals` reflow to one column, let the topbar pills wrap or move to an overflow menu. **Suggested command:** `/impeccable adapt`.
- **[P1] Only one role exists — the aggregate SOC-Responder view is undesigned (your Q1).** There is nothing to *distinguish* because only the CCTV-Operator scoped view is built (role hardcoded "Operator 02 / CCTV-Operator," everything "this camera only"). The scoped view signals its own limits well, but "Aggregate vs Scoped" cannot be evaluated.
  **Fix:** Design the SOC-Responder aggregate: multi-camera wall, cross-camera event feed, per-camera health matrix, no scope-lock notice — and make the role difference legible at a glance (different density, a role banner, wall-vs-single layout). Enforce the split **server-side**, never a client toggle. **Suggested command:** `/impeccable shape` (new view), then `/impeccable craft`.
- **[P1] Light theme is a second-class citizen — and light is the platform's canonical theme.** In light mode the feed goes near-white with faint grid, the dark video-overlay chips ("REC · 1080p," camera label, timestamp) drop to low contrast, and the whole screen reads washed-out versus the confident dark theme. Precision Light should be the *strong* one here.
  **Fix:** Treat light as primary: solid card surfaces, a legible feed placeholder, overlay chips that hold ≥4.5:1, teal accents darkened for white backgrounds. **Suggested command:** `/impeccable colorize`.
- **[P2] Pipeline display polish (your Q3).** It looks clear and professional in dark mode, but on inspection: two different numbers are both called "latency" (header **4 ms** LAN vs live **38 ms** — network vs inference, unlabeled); the self-check log mixes clock formats (live `02:04:52` beside hardcoded `14:21:33`); the latency sparkline has no scale, units on the axis, or good/bad threshold band; NAS shows only *last* sync, not the pending queue or failures (the engine tracks both).
  **Fix:** Label the two latencies distinctly ("network 4 ms," "inference 38 ms"), unify timestamps, add a threshold band + y-scale to the spark, and surface NAS queue depth / last failure. **Suggested command:** `/impeccable clarify`.

## Persona Red Flags

**Alex (operator on a 12-hour shift):** No keyboard shortcuts and no feed pop-out/fullscreen — the core "watch one camera closely" action has no accelerator. The scanline sweep and pulsing glow run continuously with no way to calm them; that's eye-fatigue by hour three, not "next-gen."

**Sam (accessibility / keyboard + screen reader):** Nav items are `<div onClick>` (not `<button>`) → not focusable, no visible focus ring, unreachable by keyboard, and a screen reader won't announce them as actionable. No `@media (prefers-reduced-motion)` anywhere, so the scanline/pulse/ring animations play regardless — a direct violation of the platform's own a11y rule ("prefers-reduced-motion: all transitions collapse to 1 ms"). Light-theme muted text on pale surfaces is borderline on contrast.

**Grader (access-control reviewer, reads Thai — from PRODUCT.md):** The role chip and scope lock are pure client-state presentation here ("any credentials sign you in," `loggedIn` in local state). Fine for a mockup, but the finding they'll write is that the Operator-vs-Responder split must be a **server-decided** role with default-deny module resolution — not a client toggle — and there's no Thai copy present despite the Thai-first mandate.

## Minor Observations

- "AEGIS Monitor / AI CCTV · NEXT-GEN HUD" wordmark subtitle is marketing voice inside a tool; PRODUCT.md anti-references call out exactly this.
- Notification bell has no badge/state; unclear if it does anything.
- Match score (98%) and the event-stream confidences have no "low-confidence" visual treatment — a 51% match looks the same as 98%.
- The `~10:00` clip duration and segment bars are a nice touch, but every clip is exactly `~10:00`; a partial/in-progress current segment isn't shown.

## Questions to Consider

- Is Monitor meant to feel like a *different room* from HUB/Drive (a dark ops console), or one continuous platform? That one decision drives half of these fixes — make it explicit in DESIGN.md rather than by default.
- What does an operator need to see in the *first second* after the engine drops? Right now the answer is "nothing changes," which is the wrong answer for a security tool.
- If the SOC-Responder watches 16 cameras, is this single-feed layout even the right skeleton, or does the aggregate view need its own information architecture from scratch?
