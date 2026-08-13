# AEGIS System

**Autonomous Edge-Guard Infrastructure System** — a monorepo of one entry hub and three
edge modules. Thai-first UI, Aurora Glass design language (see `DESIGN.md`, `PRODUCT.md`).

## Monorepo layout

```
AEGIS_System/
├── HUB-AEGIS_Entry/          # ✅ Routing-only entry (no auth/session/backend — by design)
│   ├── src/                  #    Welcome → app picker → hand-off to each app's own login
│   ├── nginx.conf            #    static serving + /healthz + strict security headers
│   └── public/config.json    #    runtime module targets (no IPs baked into the bundle)
│                             #    ⚠️ no server/ — HUB is static files only (see §12 of
│                             #    docs/auth-test.md for why the login form was removed)
│
├── IDEA1-AEGIS_Drive_LC/     # ✅ AEGIS Drive · Secure NAS / Edge Data Lake
│   ├── src/                  #    Frontend (Vite + React) — renders what the server decides
│   └── server/               #    OWN identity: Admin + DataLake-User · DB aegis_drive
│                             #    auth (bcrypt/lockout/CSRF), rbac, /healthz, audit (hashed)
│
├── IDEA2-AEGIS_Monitor/      # ✅ AEGIS Monitor · one app, two server-resolved views
│   ├── src/                  #    Aggregate (SOC-Responder) + Scoped (CCTV-Operator)
│   └── server/               #    OWN identity: SOC-Responder + CCTV-Operator ·
│                             #    DB aegis_monitor · owns camera_assignment · port 8002
│
├── IDEA2-AEGIS_CCTV-Operator/ # ⚠️ web-app/ DEPRECATED (merged into IDEA2-AEGIS_Monitor)
│   ├── detection-engine/     #    ✅ Laptop · face-recognition → writes DB · no UI
│   └── web-app/              #    kept as unmerged reference only — safe to delete
│
├── IDEA3-AEGIS_Lockdown/     # 🚧 Scaffold: physical lockdown
│   └── firmware/             #    ESP32 + Relay · MQTT + HMAC-SHA256 + nonce · Dead Man's Switch
│
└── shared/
    └── db-schema/            #    Central schema ownership notes (per-app identity)
```

`✅ built · 🚧 scaffold · ⚠️ deprecated`

## Security architecture (per-app identity — decision 2026-07-20)

Authentication and authorization happen **only on the server of each app**. The browser
never decides anything about identity or role, and **no app trusts another app's session**.

- **HUB is routing-only.** No user table, no session, no RBAC — a Welcome screen and a
  module index that hands off to each app's own login. (Its former auth stack was moved
  into the two apps below.)
- **IDEA1 · AEGIS Drive** owns roles `Admin` / `DataLake-User` in database `aegis_drive`
  (`IDEA1-AEGIS_Drive_LC/server/`).
- **IDEA2 · AEGIS Monitor** owns roles `SOC-Responder` / `CCTV-Operator` **and the
  `camera_assignment` table** in database `aegis_monitor` (`IDEA2-AEGIS_Monitor/server/`).
  One app, two server-resolved views: Aggregate (SOC) and Scoped (Operator).
- Both backends implement, with Thai comments for graders: role never accepted from the
  client (OWASP A01) · byte-identical `"Invalid credentials"` with timing-equalized bcrypt
  (dummy-hash compare) · per-account **and** per-IP lockout after 5 failures with
  exponential backoff · session regeneration on login (anti-fixation), HttpOnly +
  SameSite=Strict cookie, idle + absolute timeouts · CSRF synchronizer tokens ·
  strict CSP (no `unsafe-inline` / `unsafe-eval`) + full security-header set ·
  server-side menu filtering (unauthorized views are absent from the payload, therefore
  absent from the DOM) · per-endpoint `requireRole`, and for the Operator, every camera
  query JOINs `camera_assignment` server-side (crafted requests for unassigned cameras
  get 403) · generic error responses, details logged server-side only.
- **No `localStorage` / `sessionStorage` / `document.cookie`** anywhere in any app.

## Run the apps

```bash
# HUB (routing-only entry — static, no server, no login of its own)
cd HUB-AEGIS_Entry        && npm install && npm run dev                     # UI  :5173

# AEGIS Drive (IDEA1) — its own login: admin/aegis-drive-admin · user/aegis-drive-user
cd IDEA1-AEGIS_Drive_LC   && npm install && npm run dev:server              # API :8001
                             npm run dev                                    # UI  :5174

# AEGIS Monitor (IDEA2) — its own login: soc/aegis-soc · operator/aegis-operator
cd IDEA2-AEGIS_Monitor    && npm install && npm run dev:server              # API :8002
                             npm run dev                                    # UI  :5176
```

> Each backend runs an in-memory fallback when `DATABASE_URL` is unset, enforcing the same
> server-side security model; production uses PostgreSQL (`server/db/schema.sql` +
> `seed.sql` per app — two separate databases, never shared).

## AI agent and UI design workflow

This repository is designed to be worked on by multiple coding agents. Before changing
UI, read [`AGENTS.md`](AGENTS.md), the relevant `PRODUCT.md`/`DESIGN.md`, and the shared
knowledge index at [`Obsidian_AEGIS_Vault/AEGIS_Knowledge/index.md`](Obsidian_AEGIS_Vault/AEGIS_Knowledge/index.md).

For frontend design prompts, use the project-local Impeccable skill at
`.agents/skills/impeccable/SKILL.md` (reference: [impeccable.style/docs](https://impeccable.style/docs/))
and choose the command that matches the request
(`layout`, `craft`, `polish`, `audit`, `delight`, etc.). Do not apply commands mechanically:
preserve real API data, RBAC, routes, state machines, accessibility, reduced motion, and
the AEGIS product register.

After implementation:

1. Run the affected tests and production build. For Monitor UI/deployment work, verify
   `docker compose up -d --build` and `http://localhost/monitor/` when requested.
2. Update the selected area's canonical Obsidian note only when durable implementation,
   security, deployment, or maturity facts changed; avoid duplicate notes.
3. Create exactly one new task receipt from
   `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/_template.md`. Never edit another
   task's receipt or append a new task entry to the frozen legacy `log.md`.
4. Keep local agent settings and secrets out of commits. Use `AGENTS.md` as the
   authoritative repository policy when this README and an agent's defaults differ.

### Automatic Impeccable command selection

You do not need to type an Impeccable command for every design request. Agents must infer
the best command from the prompt, inspect the target surface, and use the project-local
skill before editing. The official command reference is
[impeccable.style/docs](https://impeccable.style/docs/).

| Request intent | Select automatically |
| --- | --- |
| New screen or major UI feature | `shape` → `craft` |
| Spacing, alignment, hierarchy, or responsive composition | `layout` / `adapt` |
| Typography, wrapping, or unreadable labels | `typeset` / `clarify` |
| Palette, contrast, or semantic states | `colorize` / `audit` |
| Accessibility, edge cases, empty/error states, or production readiness | `audit` → `harden` |
| Visual review or anti-pattern check | `critique` |
| Final refinement before handoff | `polish` |
| Browser-based visual iteration | `live` |
| Motion requested explicitly | `animate`, only when it communicates state and respects reduced motion |

For larger changes, use the sequence `shape → craft → critique/audit → polish`. Do not
apply commands mechanically: preserve real API data, routes, RBAC, state machines, Thai-first
copy, WCAG AA contrast, reduced motion, and the existing AEGIS product/design register.

Every agent must read the relevant existing Obsidian note before changing code and update
durable facts in that note when needed. Every completed task adds one immutable receipt
under `90-Status/logs/`; Core/shared notes are reconciled by the integration owner through
Pull Request review.
