# IDEA3 Purple Desktop Refinement Design

## Intent

Raise the existing eight-page Python/Tkinter Purple Desktop to a consistent, production-quality operational UI while preserving the accepted purple identity, real-data truthfulness, and every security/control boundary. The primary users are Thai-first operators working at 1440×900 and 1920×1080, with English and Chinese also supported.

## Goals

- Apply one shared 26/19/14/13/12 px hierarchy and 8/16/24 px spacing rhythm across all eight pages.
- Make real health, incident, device, lockdown, recovery, audit, diagnostics, and settings information easier to scan.
- Preserve dark/light themes, TH/EN/ZH, truthful unavailable states, and existing callbacks/persistence.
- Preserve no-flicker snapshot rendering and scroll position.
- Produce offline screenshot evidence at both required resolutions.

## Non-goals and anti-goals

- No security, detector, containment, MQTT, firmware, network, relay, auth, or authorization changes.
- No new telemetry, settings, actions, command paths, or fabricated values.
- No edit to the five pinned snapshot files or any Core file under `aegis_soc/`.
- No dark-blue SOC restyle, new palette, glow-heavy decoration, or oversized dashboard cards.

## Constraints

- Work only on `feat/idea3-ui-readability` in the existing main checkout.
- Production mutation is forbidden; fixtures are offline/fake-control only.
- Existing Purple Desktop builders inside pinned `gui.py` are adapted only through IDEA3-owned subclasses and presentation helpers.
- The current `compute() -> render(snapshot) -> skip-if-unchanged` and yview save/restore behavior stays intact.
- Changes remain uncommitted for human review.

## Approaches considered

1. **Edit the pinned GUI/theme directly.** Rejected because the accepted snapshot must remain byte-identical and Core ownership forbids it.
2. **Replace the desktop with a new shell.** Rejected because it would duplicate callbacks, authority logic, and the design system.
3. **Extend the existing IDEA3-owned subclass and shared presentation helper.** Selected. It preserves real behavior and the Purple design system while allowing page-builder overrides, localized labels, and reusable layout components.

## Selected design

Use `tools/purple_design.py` as the single refinement layer. Extend it only with palette-derived, behavior-free components for headers, section notes, fact grids, tables, empty states, and feedback. Override page builders in `tools/live_purple_observer.py` and `tools/live_purple_control_desktop.py`; use existing Core-record helpers and status semantics. Settings continues to call the original language/theme callbacks. Operational controls remain the original controls and confirmation flow. Login and pinned dialogs are retained where already aligned; IDEA3-owned integration may restyle them after construction but never replaces authentication or authority behavior.

## Verification strategy

- Add tests before each behavior-bearing helper or builder change; watch focused tests fail and then pass.
- Run focused desktop tests after each stage, then the complete relevant desktop regression set.
- Verify all five pinned SHA-256 values before and after.
- Capture and inspect offline screenshots at 1440×900 and 1920×1080 across all eight pages, both themes, and representative TH/EN/ZH states, plus login/recovery/confirmation where the environment permits.

