---
title: Task Receipt — IDEA1 Classic Glossy Enamel dashboard
date: 2026-10-07T22:20:45+07:00
owner: kla
area: idea1
branch: feat/idea1-classic-glossy-dashboard
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 Classic Glossy Enamel dashboard

## What changed

- The authenticated **Classic** interface style (the default) now renders the "Glossy Enamel" skeuomorphic theme from the approved light/dark mockups. Cards and bars are glossy enamel, wells are recessed, badges are plates, and status dots are LEDs. Everything is token-driven in light and dark.
- The Dashboard has the full treatment: bar-style Sidebar (pressed active row with an LED strip) and TopBar (recessed status pills, a track/knob theme switch, an LCD clock and a plate avatar); the 34 px engraved title; a recessed search; enamel action buttons; KPI cards; Data Lake rack rows with glowing latency; login-history wells; SVG ring gauges for CPU/RAM/Disk; a CPU heat rail; the glass-tube storage split; cylinder activity bars; and plate file rows.
- Other Classic screens inherit only the palette, enamel cards and bar shell. Neo and Login are unchanged.
- No API, route, data, RBAC or backend change. Every Thai string is the existing `strings.js` copy. One new key, `themeSwitchAria` (TH/EN/ZH), is used only as the switch tooltip.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/src/theme-classic.css` — new: all §3 tokens for light and dark, plus the material, shell, Dashboard, narrow-screen, `prefers-contrast` and reduced-motion rules, all scoped `:root[data-ui-style="classic"]`
- `IDEA1-AEGIS_Drive_LC/src/main.jsx` — import the Classic stylesheet after `index.css`
- `IDEA1-AEGIS_Drive_LC/src/lib/interfaceStyleContext.js` — new: presentation-only context (default `null`, so Login stays outside it)
- `IDEA1-AEGIS_Drive_LC/src/App.jsx` — provide the context; add class hooks on the main column, scroller, breadcrumb and title
- `IDEA1-AEGIS_Drive_LC/src/components/ui.jsx` — Chip/Dot `data-tone` hooks (Dot paints with `backgroundColor`); CardTitle hooks; a Classic-only track/knob `ThemeToggle` that keeps the contract accessible name "Switch to … mode"
- `IDEA1-AEGIS_Drive_LC/src/components/Sidebar.jsx` — class hooks; sidebar width and meter rail read CSS variables with the old values as fallback
- `IDEA1-AEGIS_Drive_LC/src/components/TopBar.jsx` — class hooks; the resting shadow is token-driven (fallback `none`)
- `IDEA1-AEGIS_Drive_LC/src/components/AegisMark.jsx` — lockup class hooks
- `IDEA1-AEGIS_Drive_LC/src/components/ServerTelemetry.jsx` — Classic-only `RingGauge` (`role="img"` plus a value `aria-label`) and the temperature `HeatRail`; tile hooks
- `IDEA1-AEGIS_Drive_LC/src/screens/Dashboard.jsx` — class hooks; colour fallbacks via `var(--x, <old value>)`; a Classic-only `CylinderBar` shape, dashed grid and mono ticks; a link icon on the empty share state in Classic
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — `themeSwitchAria` in EN/TH/ZH
- `IDEA1-AEGIS_Drive_LC/package.json`, `IDEA1-AEGIS_Drive_LC/package-lock.json` — add `@fontsource/ibm-plex-mono` (self-hosted, no CDN)

## Verification evidence

- `npx vite build --outDir <scratch>` — pass. The only warning is the >500 kB chunk warning, which the `origin/main` build at `5d3245ea` also emits.
- `node --test --test-concurrency=1 tests/{dashboardAggregates,dashboardEmptyState,dashboardHeaderPolish,serverTelemetryUi,interfaceStyleAuthTransition,interfaceStyleSwitch,shellThemeR4,themeAuthTransition,themeContinuity,uiNegativeCases,storageCapacityRingUi,healthTelemetry,hostTemperatureTelemetry,settingsSecurityDefaultsUi,storageBackupUi}.test.js` — 126 tests, 124 pass, 1 fail. The failure (`Dashboard quick actions live in the page header…` in `dashboardHeaderPolish`) also fails on `origin/main`, so it predates this task.
- An intermediate run failed 6 `themeAuthTransition` tests: the new switch had a new accessible name. The fix restores the contract name ("Switch to dark/light mode"). After it: `themeAuthTransition` + `interfaceStyle*` + `shellThemeR4` — 26/26 pass.
- Agent-driven headless Chrome (playwright-core, system Chrome) on a local non-Production stack: own `postgres:15-alpine` container, `node server/index.js` on :8011, and `vite preview` of the production build. Results:
  - Classic at light/dark × 1440/390: screenshots captured.
  - Theme toggle: 0 px shift across 12 measured elements.
  - At 390 px, `documentElement.scrollWidth` = 390 in both modes.
  - 0 non-loopback requests.
  - Fonts resolve to IBM Plex Sans Thai and IBM Plex Mono.
  - Gauges expose `aria-label`s of "การใช้งาน 5% / 23% / 82%".
- Neo regression: the same harness against an `origin/main` build on :5182, followed by a canvas pixel diff. The differing cells are only live values: clock, latency ms, login timestamps and service uptime. The header crop is visually identical.
- Contrast (WCAG 2.x, computed from the token hex values):
  - Light: ink/face-b 10.96, ink2/face-b 6.00, ink2/well-a 5.00, ink-3/well-a 4.57, bar-ink/bar-b 5.22, bar-ink on pressed well 4.52, bar-ink on pill well 4.96, white/primary 7.05.
  - Dark: ink/face-a 9.56, ink2/face-a 4.86, bar-ink/glossed bar 4.93, accent/well 8.63, acc-ink/primary 6.05.
- `git grep` of the added JSX/JS lines for `#hex` or `rgb(` — none. Literal colours exist only in `theme-classic.css`.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md`:
  - New Current Task block IDEA1-CLASSIC-GLOSSY.
  - The previous current task is relabelled "Previous Task" with its state unchanged.
  - The stale fact "Classic preserves the existing … Precision Ledger interface" is replaced in place.

## Shared surfaces touched

- None — task stayed inside its selected area

## Integration requests

- None — no cross-scope or shared path changed.

## Known limitations

- Deviations from the brief and mockups:
  - Light/dark persistence reuses the existing owner-controlled `aegis_shell_theme` + account preference. There is no new storage key. That key is already shared with Neo, which satisfies "switching to Neo and back preserves the choice".
  - The switch keeps the contract accessible name "Switch to dark/light mode" with `aria-pressed`. It does not use `role="switch"` with "สลับโหมดสว่างและมืด". The Thai text is its tooltip. Protected theme tests locate the control by that name.
  - Below 1024 px the existing hamburger drawer is kept. The sidebar does not stack above the content, so navigation behaviour is unchanged.
  - The main pane stays the scroller, not the page, because Files/Vault marquee selection depends on it. The TopBar is therefore effectively fixed.
  - The sidebar subtitle is the existing string "พื้นที่จัดเก็บระดับองค์กร · ศูนย์ควบคุมความปลอดภัย", not the mockup's shorter text.
  - The brand mark is the existing `AegisMark`, set on a plate, not a generic shield-check icon.
  - The search placeholder is the existing string.
  - Contrast-driven token nudges are listed in `idea1-status.md`.
- Host telemetry (CPU/RAM/network/temperature/host uptime) used a labelled fixture in QA because Windows has no telemetry agent. Disk, service uptime and everything else were real.
- A Thai filename in the QA seed rendered garbled because of the seed script's multipart encoding. That is a test-data artifact, not a UI change.
- Files, Vault, Settings and the other Classic screens received only the palette, card and shell pass. They were not screenshot-reviewed.
- No human visual acceptance yet. Not production-deployed.
