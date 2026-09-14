# IDEA3 Python Desktop UX/UI Refresh Design

Date: 2026-09-14
Status: Approved by the owner instruction supplied for this continuation
Area: `idea3`
Owner: `music`
Branch: `feat/idea3-python-uxui-refresh`
Starting SHA: `25e8b60b12e40f086deb99c08b977e4fb36b4959`

## Goal

Complete the existing Tkinter desktop program as a polished, trilingual,
dual-theme SOC console without replacing the three already-committed UI slices
or changing the cyber-physical control contract.

## Existing foundation to preserve

- `AegisAdminGUI` owns the live desktop state, controller, MQTT callbacks,
  pending command correlation, ARM/DISARM state, incidents, and audit behavior.
- `presentation.py` maps observed evidence to honest display states.
- `i18n.py` centralizes English, Thai, and Chinese strings.
- `theme.py` contains the reusable Tkinter presentation widgets.
- The official light-ink and dark-ink AEGIS mark assets are already committed.
- CUT and RESTORE continue through the existing PIN, confirmation, controller,
  nonce, ACK, and recovery paths. Desktop login never satisfies those gates.

## Architecture

### Authentication and session

`auth.py` provides a pure credential verifier and an in-memory
`DesktopSession`. The Admin identifier comes from `AEGIS_ADMIN_ID` with a
development/lab fallback; the PIN is verified only through the existing
`config.verify_pin()` helper. The session retains only the Admin identifier and
authentication timestamp. PIN input is never logged, serialized, or stored.

`login_view.py` renders a localized Admin Login in the same root window. It
owns only form widgets and presentation callbacks. Successful authentication
calls back into `AegisAdminGUI`; it does not receive the controller and cannot
issue a command.

`AegisAdminGUI` becomes the view/session orchestrator. Its operational objects
and evidence fields are created once. Login, logout, language changes, and
theme changes rebuild presentation widgets only; they do not reconstruct MQTT,
the controller, incidents, pending commands, armed state, or ACK state.

### Theme system

`theme_state.py` stores exactly one non-secret preference, `theme`, in a JSON
file next to the existing application data. It accepts only `dark` or `light`
and fails safely to dark.

`theme.py` exposes immutable dark/light palettes and constructs every reusable
widget from the currently selected palette. Legacy exported color constants
remain available for compatibility, while refreshed desktop views resolve the
palette at construction time. A theme change updates `theme_state` and rebuilds
the visible login or authenticated shell.

Branding resolution accepts a theme and selects
`aegis-mark-light-ink.png` for dark surfaces and
`aegis-mark-dark-ink.png` for light surfaces. An explicit
`AEGIS_LOGO_PATH` remains the first override.

### Pages and evidence

The navigation contains nine working surfaces: Login, Overview, Incidents,
Devices, Lockdown, Recovery, Audit Log, Diagnostics, and Settings. Page builders
consume the already-held GUI evidence and read-only database helpers.

- Overview: health summary, incidents, activity, and operational posture.
- Incidents: actual SQLite incidents only, with a truthful empty state.
- Devices: broker, ESP32, telemetry, and uplink evidence; absent evidence is
  `UNKNOWN` or `NO EVIDENCE`.
- Lockdown: readiness plus existing ARM, CUT, and RESTORE actions. Destructive
  CUT remains visually isolated and keeps its separate PIN + literal `CONFIRM`.
- Recovery: runbook guidance and the existing recovery wizard entry point.
- Audit Log: actual hash-chained events, level filtering, raw details, export,
  and integrity verification.
- Diagnostics: safe profile/configuration readiness without secret values.
- Settings: theme, language, session, and branding information only.

No page synthesizes incidents, devices, telemetry, ACK, relay confirmation, or
physical isolation. Requested, published, ACK, executed, relay, and physical
evidence remain separate concepts.

## Visual system

The physical scene is a security operator using a dedicated console in either
a dim SOC or a bright lab. Therefore both themes use the same restrained blue
security-appliance identity with high-contrast neutral substrates. Layout uses
a compact header, a stable left rail, generous page spacing, restrained depth,
and varied information groupings rather than a repeated card grid.

The login uses a Canvas circuit/network field behind a solid readable
authentication panel. Decoration never claims system activity and uses no fake
alpha effects. The authenticated shell uses a quieter circuit motif in the
sidebar/header only. Status always includes text, never color alone.

The 1920x1080 layout is primary. At 1366x768 the sidebar and all primary
controls remain reachable, content scrolls vertically inside the workspace,
and the root never requires horizontal scrolling.

## Safety boundaries

- No changes to `controller.py`, `mqtt_client.py`, `security.py`,
  `supervisor.py`, `runtime.py`, `config.py`, `comms.py`, or `firmware/*`.
- No live MQTT, hardware, CUT, RESTORE, network, Production, or deployment use.
- No secret value is displayed by Diagnostics or persisted by UI preferences.
- No UI login state is passed into CUT/RESTORE authorization.
- No framework migration; Tkinter remains the desktop framework.

## Verification

Use RED-GREEN tests for pure auth/session, preference persistence, theme-aware
branding, database read projections, and evidence semantics. Run focused tests,
the full Python suite, Ruff on touched Python files, compileall, and
`git diff --check`. Run the GUI only with `AEGIS_PROFILE=lab`,
`AEGIS_DRY_RUN=1`, and `AEGIS_AUTO_CONTAIN=0`; record exact display limitations.
