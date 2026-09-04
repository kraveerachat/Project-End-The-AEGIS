# AEGIS IDEA3 Security Center — 11-Page Design Specification

**Date:** 2026-09-03
**Area:** `idea3`
**Owner:** `music`
**Branch:** `feat/idea3-security-center-11-page`
**Status:** Approved for implementation
**Source brief:** `AEGIS_IDEA3_Codex_11_Page_Real_Implementation_Prompt.md`
**Visual references:** repository `DESIGN.md`, `IDEA1-AEGIS_Drive_LC/DESIGN.md`, and the supplied IDEA1 light/dark dashboard screenshots

## 1. Objective

Build a new production-oriented AEGIS IDEA3 Security Center entirely inside
`IDEA3-AEGIS_Lockdown/`. The application gives an authenticated administrator
one truthful operational surface for IDEA1 access-security evidence, IDEA2
detection evidence, IDEA3 runtime/device evidence, alerts, correlated incidents,
audit records, and safe recovery readiness.

The product is evidence-led. A component is never presented as healthy because
the page rendered or because a command was requested. Every status must answer:

1. Where did this value come from?
2. When was its evidence generated?
3. Is that evidence fresh, stale, malformed, or absent?
4. Is the page showing Live or Demo data?
5. Does the value describe a request, an ACK, an execution, or verified physical evidence?

## 2. Scope

### In scope

- A new React/Vite application under `IDEA3-AEGIS_Lockdown/web/`.
- An IDEA3-owned Express API and server-side session/RBAC/CSRF enforcement.
- Shared status, issue, event, alert, incident, device, and audit contracts.
- Read-only server-to-server adapters for future IDEA1 and IDEA2 sanitized endpoints.
- Safe IDEA3 runtime evidence ingestion.
- Eleven authenticated pages plus a separate login gate.
- Demo fixtures that are session-scoped, visibly labelled, isolated from Live data,
  and hard-disabled in production.
- Responsive desktop/tablet/mobile behavior, light/dark parity, Thai-first copy,
  keyboard access, reduced motion, and safe empty/error/stale states.
- Unit, adapter-contract, API, component, integration, build, and browser-layout verification.

### Out of scope

- Changes to IDEA1 or IDEA2 producer source.
- Direct reads from IDEA1/IDEA2 databases or files.
- Browser access to MQTT, ESP32, GPIO, or relay interfaces.
- Live `CUT_UPLINK` or `RESTORE_UPLINK` execution.
- Firmware flashing, serial writes, GPIO toggling, relay actuation, or hardware validation.
- Production deployment, MQTT TLS rollout, systemd installation, VLAN/router/firewall changes,
  or production penetration testing.
- Claims that hardware, integration, persistence, or recovery is complete without matching evidence.

## 3. Product and visual direction

### 3.1 Physical scene

An administrator uses this interface at a desktop workstation in a bright university
network laboratory, occasionally switching to a dim room during incident response.
The default is therefore a calm light operational canvas with complete dark-theme
parity, not a permanently dark neon SOC HUD.

### 3.2 Visual lineage

IDEA3 borrows the visual grammar of IDEA1's “Precision Ledger” without copying
IDEA1 business logic, navigation, identity, or page layouts.

- Fixed left navigation on desktop; drawer on smaller screens.
- Slim top status bar with source health, clock, theme control, and server-resolved identity.
- Cool canvas, solid paper-like surfaces, thin dividers, crisp alignment, and restrained elevation.
- Instrument Blue for actions, focus, and current selection only.
- Green, amber, and red only for measured semantic state.
- JetBrains Mono for timestamps, IP addresses, hashes, counters, firmware versions, and evidence age.
- Lucide line icons with consistent optical size and stroke weight.
- Dense tables and ledgers where the task needs density; cards only when they create a real grouping.
- The AEGIS hatch means “the system cannot currently see or verify this.” It is not decoration.

### 3.3 Design tokens

| Role | Light | Dark | Use |
|---|---|---|---|
| Canvas | `#F8FAFC` | `#070A12` | Application background |
| Card | `#FFFFFF` | `#0D1220` | Working surface |
| Sunken | `#F1F5F9` | `#131A2B` | Inputs, inactive rows, icon housings |
| Ink | `#0F172A` | `#F8FAFC` | Headings and primary values |
| Ink secondary | `#475569` | `#CBD5E1` | Body and descriptions |
| Ink caption | `#64748B` | `#94A3B8` | Captions only |
| Line | `#E2E8F0` | `#29334A` | Dividers and control borders |
| Accent | `#2563EB` | `#3B82F6` | Primary action, focus, active navigation |
| Success | `#059669` | `#34D399` | Fresh verified healthy evidence |
| Warning | `#B45309` | `#FBBF24` | Degraded or stale attention state |
| Danger | `#DC2626` | `#F87171` | Failed or critical verified state |

Typography uses Inter Variable with IBM Plex Sans Thai fallback. Thai body copy has
line-height of at least `1.7`. Controls are at least 44 px high. Major surfaces use
12–16 px radii; data ledgers use 8–10 px; action and status controls may use pills.

### 3.4 Motion

- One easing curve: `cubic-bezier(0.32, 0.72, 0, 1)`.
- Durations: 120, 200, and 240 ms for state transitions.
- Motion communicates navigation, loading, expansion, acknowledgement, or state change.
- No orchestrated page-load sequence, ambient animation, glow, bloom, glassmorphism,
  particle field, gradient text, or decorative color wash.
- `prefers-reduced-motion` reduces transitions and animations to 1 ms while preserving
  every state through label, icon, and color.

## 4. Information architecture and application shell

The login gate is outside the eleven-page count. After authentication the server returns
the administrator identity and allowed navigation. The client renders only that menu.

Desktop shell:

```text
┌──────────────┬──────────────────────────────────────────────────────────┐
│ IDEA3        │ Source health · clock · theme · administrator           │
│ navigation   ├──────────────────────────────────────────────────────────┤
│              │ Breadcrumb · page title · contextual filters/actions    │
│ grouped by   ├──────────────────────────────────────────────────────────┤
│ task         │ Page content                                             │
│              │                                                          │
│ system state │                                                          │
└──────────────┴──────────────────────────────────────────────────────────┘
```

Navigation groups:

- Workspace: Dashboard, Overview.
- Evidence: IDEA1 Security, IDEA2 Detection, IDEA3 Lockdown.
- Response: Alerts, Incidents, Audit.
- System: Devices, Recovery, Settings.

The sidebar footer shows only a safe aggregate system state and last evidence age.
It never displays credentials, broker addresses, secret material, raw error text, or
an inferred physical state.

## 5. Shared domain contracts

### 5.1 Canonical status

All pages use exactly these values:

```text
HEALTHY
DEGRADED
FAILED
UNKNOWN
NOT_CONFIGURED
DISABLED
```

- `HEALTHY`: fresh validated evidence proves normal operation.
- `DEGRADED`: fresh validated evidence proves partial operation or a bounded problem.
- `FAILED`: fresh validated evidence proves failure.
- `UNKNOWN`: evidence is absent, stale, malformed, oversized, or future-dated.
- `NOT_CONFIGURED`: an operator has not configured the source.
- `DISABLED`: policy or configuration intentionally disables the capability.

`ONLINE`, `NORMAL`, `RUNNING`, “connected,” and similar source-specific words may be
shown only as sanitized details beneath a canonical status when fresh evidence supports them.

### 5.2 Safe runtime status

The IDEA3 runtime contract contains only:

- `schemaVersion`
- `generatedAt`
- canonical overall `status`
- canonical component states for runtime, broker, ESP32, relay, uplink, heartbeat, and ACK
- safe runtime mode flags: monitor-only, dry-run, armed, auto-contain, recovery authorization
- bounded safe issues
- safe evidence source identifier

Every issue exposes only `code`, `component`, `severity`, `firstSeen`, `lastSeen`, and
bounded integer `count`. Static remediation copy is mapped in the Web application.
Allowed issue codes are:

```text
PREFLIGHT_FAILED
BROKER_DISCONNECTED
DEVICE_OFFLINE
ACK_TIMEOUT
COMPONENT_FAILED
STATUS_STALE
SUPERVISOR_FAILED
MALFORMED_EVIDENCE
ADAPTER_UNAVAILABLE
ADAPTER_TIMEOUT
ADAPTER_RESPONSE_REJECTED
```

Unknown codes map to a generic safe issue or are dropped. Raw runtime text never becomes UI copy.

### 5.3 Evidence validation

Every adapter has a strict schema allowlist, response byte ceiling, timeout, bounded retry,
circuit-breaker state, item-count ceiling, timestamp validation, freshness threshold,
bounded pagination/time ranges, enum validation, string-length limits, and IP normalization.
Malformed, oversized, stale, or future evidence fails closed without crashing unrelated pages.

### 5.4 Demo/Live separation

Demo data is generated from a separate provider and never merges with a Live collection.
Demo state is stored in the authenticated session, resets on login, and is denied in production.
Every page displays both a persistent `DEMO` badge and a banner reading:

> ข้อมูลจำลองเพื่อสาธิต UI — ไม่ใช่สถานะระบบจริง

## 6. Eleven-page design

### Page 1 — Dashboard (`/security/dashboard`)

Purpose: answer within ten seconds whether evidence is available, what needs attention,
and whether an incident is active.

- Overall system health ledger: status, evidence timestamp/age, runtime mode, auto-contain,
  and evidence source.
- Compact KPI row: recent events, active/critical incidents, high alerts, source states,
  ESP32 state, and relay/uplink state.
- Source-health ledger for IDEA1, IDEA2, IDEA3 Runtime, Event Store, and Audit Store.
- Recent Events table with sanitized timestamp, source, type, source IP, target, severity, result.
- Active Incidents preview with correlation and response state.
- Safe Issues panel with static remediation.
- Contextual refresh that preserves successful regions during partial source failure.

The desktop composition follows the supplied IDEA1 dashboard screenshots: compact summary
surfaces above a large system-health ledger and a narrower recent-activity rail.

### Page 2 — Overview (`/security/overview`)

Purpose: explain readiness and boundaries across all three IDEA domains.

- Three-domain architecture summary.
- Integration matrix: configured, reachable, fresh, valid, overall.
- Horizontal data pipeline: upstream → adapter → normalize → store → correlate → UI.
- Live versus Demo provenance panel.
- Security-boundary explanation using concise operator language.
- Readiness checklist covering contracts, persistence, audit, device evidence, recovery gateway,
  and production hardening.
- Known limitations ledger sourced from safe static configuration and evidence state.

### Page 3 — IDEA1 Security (`/security/idea1`)

Purpose: show normalized IDEA1 `DENIED`/`BLOCKED` access-security events only.

- Adapter status and freshness summary.
- Event table: timestamp, action, result, source IP, normalized severity, dedup count.
- Summary: denied, blocked, unique source IP, repeated, escalated.
- Bounded filters for time, action, result, severity, and source IP.
- Repeated-activity analysis without attribution or blame.
- Safe adapter diagnostics without URL secrets or raw upstream output.

Allowed producer fields are only `timestamp`, `action`, `result`, and `source_ip`.

### Page 4 — IDEA2 Detection (`/security/idea2`)

Purpose: show normalized detection evidence without media, embeddings, face data, or PII.

- Detector source health and last valid detection.
- Detection table: timestamp, type, severity, source IP, target/camera, result.
- Counts by supported type and severity.
- Bounded filters for time, type, severity, source IP, and camera/target.
- Correlation-candidate markers when source IP and time window match IDEA1 evidence.
- Last-valid snapshot may remain visible with an explicit `STALE` badge if the source fails.

### Page 5 — IDEA3 Network Isolation (`/security/lockdown`)

Purpose: observe the cyber-physical response chain without enabling live hardware control.

- Runtime component grid: Supervisor, MQTT Broker, ESP32, Relay, Uplink, Heartbeat, ACK.
- Runtime mode ledger: monitor-only, dry-run, armed, auto-contain, recovery authorization.
- Safe issues with evidence age and static remediation.
- Evidence timeline for runtime start, broker transitions, heartbeat, ACK, device offline,
  and stale evidence.
- Response-readiness checklist for broker, device, ACK, HMAC policy, nonce policy,
  timestamp validation, Dead Man's Switch, and recovery authorization.
- Command area visibly disabled with the exact missing preconditions. No hidden callable
  live command endpoint exists in this milestone.

### Page 6 — Alerts (`/security/alerts`)

Purpose: triage operational alerts that need attention.

- Summary strip: total, warning, high, critical, unacknowledged, escalated.
- Table: alert ID, timestamp, source, type, severity, source IP, target, dedup count, status.
- Server-side deduplication within a configurable bounded window.
- Server-side escalation; the client never computes severity.
- Bounded filters for severity, source, type, status, and time.
- Side drawer for normalized details only.
- Acknowledge action is Admin-only, CSRF-protected, rate-bounded, and audited.

### Page 7 — Incidents (`/security/incidents`)

Purpose: show multi-source correlation rather than individual events.

- Summary: active, investigating, contained, recovered, critical.
- Incident table: ID, severity, state, first/last seen, source IP, IDEA1/IDEA2 counts,
  and IDEA3 response state.
- Timeline-focused incident detail based on visual direction B.
- Evidence rail separates requested, accepted, ACKed, executed, and physically verified states.
- State transitions are validated server-side through:
  `ACTIVE → INVESTIGATING → CONTAINMENT_PENDING → CONTAINED → RECOVERY_PENDING → RECOVERED → CLOSED`.
- Bounded sanitized analyst note with an audit trail.

Baseline correlation is same normalized source IP within ten minutes between an approved
IDEA1 denial/block and an approved IDEA2 detection. Duplicate evidence cannot create duplicate incidents.

### Page 8 — Audit (`/security/audit`)

Purpose: inspect security actions separately from operational events.

- Append-oriented audit ledger with ID, timestamp, category, action, outcome,
  internal actor reference, resource type, and resource ID.
- Bounded filters and pagination.
- Tamper-evidence verification status and last verification time.
- Retention policy, archive state, oldest record, and newest record.
- Bounded sanitized export, Admin-only, rate-limited, and itself audited.

The UI never exposes a session token, secret, credential, or raw exception. Storage design
must be reviewed for retention, indexes, privacy, cleanup, and backup/restore before a database
schema is committed.

### Page 9 — Devices (`/security/devices`)

Purpose: show only device state that has explicit evidence.

- Device inventory ledger: ID, type, canonical state, last seen, heartbeat, ACK, relay,
  safe firmware version, evidence age.
- ESP32 detail with expected heartbeat interval, stale threshold, and current issue.
- Relay evidence explicitly separates requested command from verified relay state.
- Device health timeline for heartbeat, offline, reconnect, and ACK timeout.
- Optional topology view based on visual direction C, showing relationships rather than
  pretending to provide a configurable network map.
- Demo devices remain isolated and visibly labelled.

### Page 10 — Recovery (`/security/recovery`)

Purpose: prepare a safe explicit-recovery workflow without live execution.

- Recovery readiness: gateway disabled, live hardware disabled, authorization,
  incident state, device readiness, relay evidence.
- Preconditions ledger: Admin session, CSRF, exact confirmation, eligible incident,
  reachable device, acceptable ACK, appropriate runtime mode, recovery authorization,
  fresh evidence.
- Eight-step runbook preview from incident verification through network verification and closure.
- Safe dry-run validates a request but performs no MQTT publish, GPIO write, or relay change.
- Recovery history model distinguishes request, validation, ACK, execution, physical verification,
  and outcome.

### Page 11 — Settings (`/security/settings`)

Purpose: manage only configuration that is safe for an administrator-facing Web surface.

- Demo Mode: non-production, session-scoped, off on login, production hard-deny.
- IDEA1/IDEA2 adapter summaries: configured, enabled, timeout, safe alias,
  last validation/success; never return credentials.
- IDEA3 runtime adapter: enabled, status-source configured, timeout, freshness, last success.
- Bounded event policy: dedup window, correlation window, escalation threshold.
- Retention policy: event retention, audit retention, export limit.
- Read-only security-policy summary: CSRF, Admin RBAC, secure cookie expectation,
  production Demo denial, raw payload denial.
- No Web form for relay, CUT, RESTORE, MQTT secret, or HMAC secret.

## 7. State behavior shared by every page

- Loading: hatched skeletons; previously loaded evidence is visibly marked stale while refreshing.
- Empty: distinguish “no event,” “no evidence,” and “not configured.”
- Error: safe static copy plus safe code; no raw exception or path.
- Stale: `STALE` label, evidence age, and canonical `UNKNOWN` where policy requires it.
- Partial failure: healthy regions remain usable while the failing source is isolated.
- Demo: banner and badge on every page; no Live/Demo merge.
- Pagination/filtering: bounded server-side; URLs may encode only safe filter values.
- Tables: keyboard navigable, responsive overflow, sticky headings where useful,
  and a non-table summary on narrow screens.

## 8. Security and data flow

```text
IDEA1 sanitized endpoint ─┐
IDEA2 sanitized endpoint ─┼─> IDEA3 adapters ─> validate/normalize
IDEA3 safe runtime status ┘                         │
                                                    ├─> operational store
                                                    ├─> audit store
                                                    └─> correlation engine
                                                              │
Browser <─ Admin-only session + CSRF API <─ IDEA3 Web server ──┘
```

- Authentication and Admin authorization are enforced on every API route.
- Session cookie is HttpOnly, SameSite=Strict, Secure in production, idle-bounded,
  and regenerated at login.
- Uniform login failures prevent user enumeration.
- Every state-changing request requires CSRF and validated bounded input.
- The browser never holds adapter credentials or runtime/HMAC/MQTT secrets.
- Server responses are allowlisted and use `Cache-Control: no-store`.
- Content Security Policy keeps network access same-origin.
- Safe logs contain classifications and correlation IDs, not raw upstream bodies or credentials.

## 9. Persistence boundary

Operational events and security audit records are separate models. The first implementation
may use an injected in-memory repository for TDD and Demo behavior, but no UI may imply durable
persistence until a reviewed durable store exists. A persistent schema requires a dedicated
design decision covering retention, indexing, pagination, cleanup/deletion, privacy,
backup/restore, migration, and rollback.

## 10. Implementation decomposition

The eleven pages share one data model and are not eleven unrelated mini-apps. Work proceeds as:

1. Safe IDEA3 runtime status, issues, freshness, and shared status components.
2. Application shell, login, Dashboard, Overview, and IDEA3 Lockdown.
3. IDEA1/IDEA2 consumer adapters and evidence pages using mocked contract services only.
4. Event normalization, deduplication, escalation, correlation, Alerts, and Incidents.
5. Operational/audit repository interfaces and Audit page.
6. Device evidence model and Devices page.
7. Safe Recovery dry-run and readiness page.
8. Settings, Demo/Live hard separation, production hardening, responsive/a11y polish.

Each unit follows red-green-refactor TDD. No unit changes IDEA1/IDEA2 producer code,
production infrastructure, firmware, or hardware state.

## 11. Verification design

- Unit: sanitizer, schema, enums, timestamps, freshness, issue mapping, dedup, escalation,
  correlation, state machine, evidence-stage separation.
- Adapter contracts: valid, forbidden fields, malformed, oversized, timeout, stale, future,
  unexpected enum/type, media/PII rejection.
- API: authentication, Admin RBAC, CSRF, query bounds, pagination, rate limits, error redaction.
- Web: all eleven routes, navigation, loading, empty, stale, partial failure, Demo/Live separation,
  production Demo denial, keyboard and labels.
- Integration: mocked combinations of healthy/down/stale/malformed sources and correlation match/no-match.
- Visual: 1440×900 and 1920×1080 desktop, 1024×768 tablet, 390×844 mobile,
  light/dark parity, overflow, Thai tone marks, focus visibility, and reduced motion.
- Repository: affected Node/Python suites, production build, Impeccable detector/audit,
  Vault validation, collaboration-policy tests, secret/artifact scan, and `git diff --check`.

## 12. Documentation and Git delivery

- All implementation source remains under `IDEA3-AEGIS_Lockdown/`.
- Durable state is updated in
  `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` by owner `music`.
- Each implementation task creates exactly one immutable Music-owned receipt.
- No IDEA1/IDEA2/shared source changes are permitted without an explicit owner request,
  exact path declaration in PR and receipt, `integration-review: yes`, downstream impact,
  rollback, and integration verification.
- Work starts from current `origin/main` on a correctly named feature branch and reaches
  `main` only through Pull Request review.

## 13. Design decision summary

The selected direction, pending final review of this written specification, is
“Precision Ledger for cyber-physical evidence”:

- IDEA1-like visual system, not IDEA1 code reuse.
- Light/dark parity matching the supplied screenshots.
- A common shell with page-specific information topology: ledger Dashboard,
  timeline Incidents/Audit, and topology-aware Devices/Lockdown.
- Server-owned truth and authorization.
- `UNKNOWN` is a first-class safe result.
- Demo is useful for UI review but structurally unable to impersonate Live data.
- Hardware commands remain disabled until a separate, explicit, security-reviewed milestone.
