# IDEA2 Browser Association CSP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the Operator browser association request to the exact local Agent origin without widening any other Production CSP surface.

**Architecture:** Both Monitor Express and the HUB currently send CSP, so both must permit the exact loopback origin while retaining their pre-existing intersection for other directives. The HUB will add a `/monitor/` policy and repeat the existing required server headers because a location-level `add_header` stops inheritance. It will not hide the upstream policy. Other HUB locations stay unchanged.

**Tech Stack:** Express middleware, nginx, Node's test runner, Obsidian governance.

**Spec:** Human-approved IDEA2 Browser Association CSP Narrow Fix in this task.

## Global Constraints

- Add only `http://127.0.0.1:8078` to `connect-src`; no wildcard, `localhost`, other port, or external origin.
- Preserve all other CSP directives and security headers.
- Override only `/monitor/`; preserve root, Drive, IDEA3, and `/monitor/internal/*`.
- No Agent, browser protocol, camera, DB, Production, or runtime mutation.
- One branch, one PR, one immutable receipt; declare HUB paths for integration review.

## Review Focus

- Two intersecting policies: test that both Monitor and HUB grant the exact origin and remain forwarded.
- nginx `add_header` inheritance: test all six browser security headers remain effective.
- Broad source grants: test `localhost`, another port, external hosts, and wildcard are absent.
- Internal machine ingress: test that `/monitor/internal/*` remains guarded and unmodified.
- Browser authority: rerun existing credentials-omitted, SOC-passive, and no-stream tests.

---

### Task 1: Exact Monitor-only CSP exception

**Files:**
- Create: `HUB-AEGIS_Entry/tests/monitorCspAssociation.test.mjs`
- Modify: `HUB-AEGIS_Entry/tests/driveCspParity.test.mjs`
- Modify: `IDEA2-AEGIS_Monitor/server/middleware/securityHeaders.js`
- Modify: `HUB-AEGIS_Entry/nginx.conf`

**Interfaces:** Browser sees the HUB `/monitor/` response headers and Monitor middleware emits matching exact `connect-src` authority.

- [x] Write focused tests that execute the Monitor middleware, parse the actual nginx config, and assert the exact allowed sources and retained headers.
- [x] Run focused tests and capture the expected RED against current source.
- [x] Add the one Monitor source expression and the `/monitor/` nginx header block only.
- [x] Rerun focused tests and existing Browser Association/HUB tests to GREEN.

### Task 2: Verification and governance

**Files:**
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md`
- Create: one `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/YYYY-MM-DD_HHMMSS_pub_browser-association-csp.md`

**Interfaces:** PR policy declares `area: idea2`, `owner: pub`, `integration-review: yes` and every cross-scope HUB path.

- [x] Run relevant full Monitor/HUB tests, build, static nginx validation, governance/Vault, diff and secret checks; record unavailable live validation honestly.
- [x] Add only the verified durable fact to IDEA2 status and one immutable receipt with exact changed paths and integration request to Kla.
- [ ] Review exact diff and test evidence, stage exact paths, commit, push normally, and create one PR without merging or deploying.
