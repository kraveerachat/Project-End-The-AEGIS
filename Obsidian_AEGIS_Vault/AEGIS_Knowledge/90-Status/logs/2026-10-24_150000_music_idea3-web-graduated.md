---
title: Task Receipt — IDEA3 web display of the graduated response
date: 2026-10-24T15:00:00+07:00
owner: music
area: idea3
branch: feat/idea3-web-graduated
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 web display of the graduated response

## What changed

- The Core status projection gains an optional, allowlisted, bounded `graduated` section built from `graduated-status.json` through a fail-closed gate
  (regular file, no symlink, size bound, schema v1); a missing or invalid file means no section.
- The web validates it strictly on ingest (closed enums, IPv4 only, bounded arrays, unknown fields dropped, invalid section refuses the push) and shows it on Lockdown,
  Dashboard (KPI tile), Alerts and Incidents, with a colour and text per level, th/en/zh strings, and codes and MITRE ids untranslated. Demo data is labelled.
- No new route, command path or RESTORE value was added; the panels contain no control.

## Source files changed

- `IDEA3-AEGIS_Lockdown/tools/status_projection_publisher.py`, `tools/status_push_client.py` — the gate, the projection and the optional source
- `IDEA3-AEGIS_Lockdown/web/server/domain/graduated.js` (new), `statusIngest.js`, `normalize.js`, `providers/demoProvider.js` — contract, ingest, view, demo data
- `IDEA3-AEGIS_Lockdown/web/src/components/GraduatedPanel.jsx` (new), `src/lib/graduated.js` (new), `src/lib/i18n.js`, `src/pages/{Dashboard,Lockdown,Alerts,Incidents}Page.jsx`, `src/styles/app.css` — UI
- `IDEA3-AEGIS_Lockdown/tests/test_status_projection_graduated.py`, `web/tests/server/graduated.test.js`, `web/tests/client/graduatedPanel.test.jsx`,
  `web/tests/client/dashboardPage.test.jsx` (the KPI row now has three cards), `web/tests/fixtures/core-status-push-graduated.json` (built by the Python publisher)
- `IDEA3-AEGIS_Lockdown/doc/Content/16_GRADUATED_RESPONSE.md` — web display section

## Verification evidence

- Python: 61 new tests pass; the sidecar, publisher, push-client, mirror and runtime suites pass except 3 tests that already fail on clean `main` (the `/opt/aegis-idea3-status` checks).
- Web: `npm test` 50 files / 987 tests pass (base 48 / 911); `npm run build` succeeds.
- `npm audit --omit=dev` reports 2 high advisories (`body-parser` transitive, `zod` direct) — identical on the unmodified base lockfile; no dependency was changed.
- Offline only: no network access to any host, nothing sent to a Core, broker or device.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added the web display state

## Shared surfaces touched

- None — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Not run against a live Core and Web together; the Thai, English and Chinese wording is the author's and needs a native read.
- The sidecar release package must be rebuilt from this source before any deployment (the publisher and push client changed).
- The pull-based `local_status_bridge` does not carry the section.
