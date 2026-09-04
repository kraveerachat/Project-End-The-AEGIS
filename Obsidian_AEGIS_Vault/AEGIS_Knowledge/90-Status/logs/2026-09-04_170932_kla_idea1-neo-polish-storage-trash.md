---
title: Task Receipt — IDEA1 Neo polish, drawer overlay and capacity two-base redesign
date: 2026-09-04T17:09:32+07:00
owner: kla
area: idea1
branch: fix/idea1-neo-polish-storage-trash-followup
status: complete
integration-review: no
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 Neo polish, drawer overlay and capacity two-base redesign

Round-2 UX hardening on top of PR #70 (truthful Audit/Trash/Storage states) and
PR #71 (Classic/Neo dual interface). Base `origin/main` =
`b652e384dd66b3b1bb1d30c3f7b306d4800fad20`.

`PRODUCTION_CHANGED = NO`. `PRODUCTION_ACCEPTANCE = NOT TESTED`.
No server contract, RBAC rule, migration or security boundary was touched.

## What changed

- **The Neo drawer overlay was laying white over the page in dark mode.** On
  narrow layouts the off-canvas sidebar painted its scrim with an inline
  `color-mix(in srgb, var(--ink) 30%, transparent)`. `--ink` is near-white in
  every dark theme, so that formula produced a 30 % **white** film — the "muddy,
  smoky, washed-out" report. `index.css` already documents this exact hazard two
  lines above `--modal-scrim`, and the modal had avoided it by using a literal
  per-theme colour. The drawer now does the same: a real `--drawer-scrim` token
  defined for Classic light/dark and Neo light/dark, applied through a
  `.drawer-scrim` class with a 2px blur — deliberately lighter than the modal's,
  because a drawer is a shift of attention, not a gate. Neo's drawer panel also
  stops rounding the edge that is flush against the viewport.

- **The capacity chart now asks two questions against two declared bases.** The
  previous ring was truthful but read like a debugging chart, because everything
  AEGIS stores is ~42 MB of a 119 GB volume — about 0.03 %. No single ring can
  make Documents or Vault a "real visible part" of that volume without inflating
  its angle, which would be a lie about how full the disk is. So the card now
  shows:
  - an **outer ring based on the whole volume** — AEGIS data as one segment,
    Other on this volume (hatched), Free. Three segments, three clean callouts,
    and the answer to "how full is the disk" is immediate; and
  - an **inner ring based on AEGIS data alone**, where Media is a genuine 92 %
    arc, Documents 5.4 %, Vault 2.1 %. These are true percentages of a different,
    printed denominator — not inflated ones.

  Each ring prints its own base, the legend splits into "This volume" and
  "Inside AEGIS data" with their own share columns, and a sentence states the
  second denominator outright. The visibility floor, the `<0.1%` rule, the hatch
  convention and the 360°-equals-the-base rule are all unchanged; a category
  below the floor is still drawn at the floor and never wider.

- **The Trash locked banner no longer mounts and unmounts with the dialog.** It
  was rendered only while the dialog was closed, so pressing Escape resized the
  page, and while the dialog was open nothing said *what* was locked behind it.
  It is now always present — and `inert` + `aria-hidden` while the dialog is
  open, so no focusable control sits outside the dialog.

- **A Neo motion and edge-lighting layer.** One easing token
  (`cubic-bezier(0.22, 1, 0.36, 1)` — exponential ease-out, no bounce) and three
  durations drive hover, press, selection, modal and drawer entry. Lighting is a
  1px inset catch on raised surfaces (a cool sheen in dark, never white), plus
  the existing selection glow, which is restricted to `is-active` /
  `aria-checked="true"` — the one thing a screen has exactly one of. Only
  transform, opacity, colour and shadow are animated; nothing in the layer
  touches width, height, padding, margin or filter, so no frame does layout work.
  The whole layer collapses under `prefers-reduced-motion`.

- **Scroll reveal that cannot strand content hidden.** The from-state exists only
  under `:root[data-neo-reveal="on"]`, and `useScrollReveal` sets that attribute
  only after confirming Neo is active, reduced motion is off, and
  `IntersectionObserver` exists. Without JS — headless render, failed chunk,
  Classic — the attribute is absent and every section is simply visible. A 1.2 s
  failsafe reveals anything the observer has not reported on, the observer
  triggers slightly *before* a section scrolls into view so an operator never
  arrives at a card mid-fade, and teardown disarms the from-state.

- **Classic is untouched visually.** Every Neo rule is scoped to
  `[data-ui-style="neo"]`, and the reveal is gated on `interfaceStyle === 'neo'`.
  Classic does inherit the capacity redesign, which is a shared truthfulness and
  readability improvement rather than a Neo style.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/src/index.css` — `--drawer-scrim` for four theme roots,
  `.drawer-scrim`, Neo drawer-panel corners, the Neo motion + edge-lighting
  layer, the reveal rules, and the reduced-motion overrides for all of it.
- `IDEA1-AEGIS_Drive_LC/src/components/Sidebar.jsx` — the drawer uses the themed
  scrim class instead of an inline `--ink` mix; drawer panel is identifiable.
- `IDEA1-AEGIS_Drive_LC/src/components/CapacityRing.jsx` — two rings on two
  declared bases, per-base legend groups, callouts on the volume ring only, wider
  viewBox so the longest label cannot be clipped by the viewBox edge.
- `IDEA1-AEGIS_Drive_LC/src/screens/Storage.jsx` — `data-reveal` on the disk
  health card and the RAID/Backup row.
- `IDEA1-AEGIS_Drive_LC/src/screens/Trash.jsx` — persistent locked banner, inert
  while the dialog is open; `data-trash-shell` hook on the placeholder shell.
- `IDEA1-AEGIS_Drive_LC/src/App.jsx` — `useScrollReveal` wired in, **above every
  early return** (see limitations).
- `IDEA1-AEGIS_Drive_LC/src/lib/useScrollReveal.js` — new; the gated reveal hook.
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — EN/TH/ZH copy for the two capacity
  bases.

Tests:

- `tests/neoDrawerAndMotion.test.js` — new; the scrim regression, the per-theme
  luminance rule, the motion layer's property budget, the single easing curve,
  reduced motion, and the reveal's safety contract.
- `tests/storageCapacityCalloutUi.test.js` — rewritten for the two-base model.
- `tests/protectedTrashLockedUi.test.js` — banner behaviour added; shell selector
  made specific.

## Verification evidence

- `npm test` (IDEA1) — pass: 918 tests, 851 pass, 0 fail, 67 skipped
  (Postgres-backed suites skip without a database).
- `npm run build` — pass; `dist/` rebuilt only to verify and restored before
  staging.
- `node --test tests/neoDrawerAndMotion.test.js` — pass 10/10.
- `node --test tests/storageCapacityCalloutUi.test.js` — pass 12/12.
- `node --test tests/storageCapacityRingUi.test.js` — pass 7/7.
- `node --test tests/protectedTrashLockedUi.test.js` — pass 11/11.
- `node --test tests/themeAuthTransition.test.js tests/interfaceStyleSwitch.test.js tests/interfaceStyleAuthTransition.test.js` — pass 21/21.
- `node --test tests/modalGlobalLayer.test.js` — pass 14/14 (the blur-surface guard,
  amended to admit `.drawer-scrim` — see limitations).
- `git diff --check` — clean; no credential or secret added.
- Browser QA against a temporary local harness (deleted before commit; real
  shell and real screens over fixture responses, no backend, no production
  contact): Neo dark and Neo light narrow drawer, Neo light/dark Storage,
  Neo dark Trash locked, Neo light Audit in Thai, Classic Storage. Three defects
  were found and fixed during QA — the `useScrollReveal` hook placement below
  App's early returns, the longest capacity callout clipped by the viewBox edge,
  and a reveal trigger that fired too late on a dense status screen.

## Canonical notes updated

- `None` — receipt only; no durable implemented/tested/deployed fact changed.
  This is a presentation pass over features already recorded as accepted, and
  nothing here is production evidence.

## Shared surfaces touched

- `None` — every changed path is inside `IDEA1-AEGIS_Drive_LC/`. No server route,
  database, gateway, network or deployment file was touched, and no migration was
  added because none is required.

## Integration requests

- None — no cross-scope or shared path changed.

## Known limitations

- **A hook-order bug was introduced and caught by the suite, not by review.**
  `useScrollReveal` was first placed just above the shell's `return`, which sits
  below App's three early returns (auth check, login gate, mandatory password
  reset), so it ran on some renders and not others — React reported "Rendered
  more hooks than during the previous render" in the theme-transition suite. It
  is now hoisted above every early return. Worth noting because App.jsx has more
  early returns than is obvious from the top of the file.
- Browser QA used fixture responses through a local harness, not the production
  deployment. **Production visual acceptance has not been performed**, and the
  Neo polish has not been measured on the production host's hardware.
- Scroll reveal is applied to the Storage screen only. Extending it to the other
  screens is deliberately left out of this pass: each screen's sections should be
  chosen individually rather than by blanket-tagging every card, which is the
  reflex this design system rejects.
- The capacity card's second base is a real interpretation choice, not just a
  layout change. It is correct only while the copy naming both denominators stays
  attached to it — removing "Inside AEGIS data" or the base sentence would turn
  true percentages into misleading ones.
- **An existing architectural guard was amended, not bypassed.**
  `modalGlobalLayer.test.js` enumerates every selector that declares a non-none
  `backdrop-filter` and pins the set exactly, so no component can quietly add
  glass. The new `.drawer-scrim` is a legitimate new member — the same category
  of surface as `.modal-scrim` (a scrim, static, stylesheet-owned, never a
  content card) — so it was added to the approved list with that reasoning
  recorded in the test, and `neoDrawerAndMotion.test.js` pins its blur below the
  modal's. The guard still rejects blur on content cards and animated blur.
- Storage topology on the production host remains **NOT MEASURED** (unchanged
  from the previous receipt): the documented SSH key is still rejected by
  `192.168.10.10`, so no claim is made about physical disks, LVM, free extents or
  failure domains.
