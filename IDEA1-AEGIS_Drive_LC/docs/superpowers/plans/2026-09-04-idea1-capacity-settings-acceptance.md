# IDEA1 Capacity and Settings Acceptance Plan

**Area / owner:** `idea1` / `kla`

**Branch:** `feat/idea1-capacity-settings-acceptance`

## Confirmed shape

This is a production refinement of the accepted Classic/Neo system, not a new visual direction. It keeps the existing AEGIS palette, control geometry, and authenticated-shell scope. Login is unchanged.

The capacity card will answer two different questions in one concentric visualization:

- The outer ring uses the whole filesystem as its denominator and contains exactly AEGIS-used bytes, other used bytes on the volume, and free bytes.
- The inner ring uses AEGIS-used bytes as its denominator and contains earlier versions, other files, vault, documents, archives, and media.
- Every positive segment uses the full band width and its mathematically true angular share. There is no visibility floor, thin-tick fallback, or inflated minimum angle. Tiny values remain discoverable through the legend and are labelled `<0.1%` when appropriate.
- Both legends state their denominator and exact byte value. Zero categories stay visible as inert rows.

Security & Privacy will read as an editing surface first and a status surface second:

- One persisted protection-defaults form edits vault auto-lock and all supported share defaults, with explicit dirty, saving, saved, and failure states.
- The current session/device facts come from `/api/sessions`; current Drive reachability is measured only when the user requests it.
- Connector/remote-access state stays explicitly unmeasured because no supported connector telemetry exists.
- Architectural vault and recovery facts remain visible, but subordinate to the real controls.

Storage & Data will expose measured capacity and real backup controls without implying missing integrations:

- `/api/storage` will include the configured storage root and the upload reserve/usable-byte calculation derived from the same transfer-limit contract enforced by uploads.
- The overview shows root, total, used, free, reserved, and usable values from that response.
- Admin backup controls remain backed by the host agent allowlists and policy endpoint. Schedule and retention controls appear only when the agent is connected; unreachable, invalid, targetless, and unsupported states remain explicit.
- Non-admin users receive a truthful read-only backup summary and are not offered Admin-only controls.

## Implementation and verification

1. Replace the old capacity floor/tick tests with behavior tests for one concentric SVG, two rings, full-width positive segments, true proportions, explicit denominators, responsive legends, and accessible summaries. Run them red.
2. Implement the concentric `CapacityCard`, preserving `/api/storage` category semantics and reduced-motion behavior. Run the capacity tests green.
3. Add failing storage-report contract tests for root, reserve, and usable bytes, including unreadable-capacity behavior. Extend the report from existing server configuration only.
4. Add failing Settings UI interaction/markup tests for the consolidated persisted form, current-session facts, measured storage fields, and connected-only backup controls.
5. Refactor Security & Privacy and Storage & Data composition while preserving RBAC, the current security PATCH contract, backup-agent policy allowlists, and truthful unavailable states.
6. Keep EN/TH/ZH key parity and add only semantic UI tokens/styles where shared classes are insufficient.
7. Run focused tests, `npm test`, `npm run build`, `git diff --check`, and repository governance checks required by `AGENTS.md`.
8. Perform browser QA in Classic/Neo, light/dark, desktop/mobile, keyboard, and reduced-motion states. Run Impeccable critique, audit, polish, and animation review; resolve material findings.
9. Update the IDEA1 canonical status with the durable accepted behavior, add exactly one immutable receipt, commit, push, and open one PR.

## Explicit exclusions

- Login, authentication UX, RBAC, file/share authorization, cryptography, audit semantics, backup-agent architecture, protected trash, and unrelated capacity sources.
- Fabricated connector health, disk health, backup success, mount state, or recovery capability.
