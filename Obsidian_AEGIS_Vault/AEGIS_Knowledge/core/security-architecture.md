---
title: Security Architecture
tags: [aegis, security, owasp, rbac, authentication, trust-boundary]
type: architecture-doc
created: 2026-07-20
updated: 2026-08-11
owner: kla
edit_policy: owner-only
---

# 🛡️ AEGIS Security & Identity Architecture

> **Core Concept**: **Server-Side Enforcement & Per-App Identity** — The browser has no authority over Identity or Roles, and applications do not trust each other's sessions (Zero Trust Policy).

---

## 🛡️ OWASP Security Defense Summary

```mermaid
graph TD
    subgraph SecurityShield [AEGIS Defense Mechanisms]
        A[OWASP A01: Broken Access Control] -->|Fix| A_Fix["Server-side requireRole Check<br/>No Role accepted from client"]
        B[OWASP A07: Auth Failures] -->|Fix| B_Fix["Bcrypt Timing Neutralization<br/>Account & IP Exponential Lockout"]
        C[Session Fixation & Hijacking] -->|Fix| C_Fix["HttpOnly + SameSite=Strict Cookies<br/>Regenerate Session ID on Login"]
        D[Cross-Site Request Forgery] -->|Fix| D_Fix["CSRF Synchronizer Tokens<br/>No localStorage / document.cookie"]
        E[Information Disclosure] -->|Fix| E_Fix["Server-side Menu Filtering<br/>Unauthorized DOM elements never generated"]
        F[Closed Registration Provisioning] -->|Fix| F_Fix["Server-generated temp passwords only<br/>Force Password Reset gate on every endpoint"]
        G[Bootstrap Credential Leakage] -->|Fix| G_Fix["Day-0 admin seeded from a bcrypt HASH env var<br/>never a raw password (IDEA1 bootstrapAdmin.js)"]
        H[Long-lived authorised connections] -->|Fix| H_Fix["Live streams re-check session + assignment<br/>every 10s, not only at open (IDEA2)"]
        I[Edge service exposed to browsers] -->|Fix| I_Fix["Detection Engine reached only via Monitor's<br/>proxy — service key never leaves the backend"]
    end
```

---

## 📋 Identity Partitioning Across Applications

```mermaid
erDiagram
    AEGIS_DRIVE_DB {
        string role_admin "Admin"
        string role_user "DataLake-User"
    }

    AEGIS_MONITOR_DB {
        string role_soc "SOC-Responder"
        string role_operator "CCTV-Operator"
    }

    CAMERA_ASSIGNMENT {
        int user_id FK
        int camera_id FK
    }

    AEGIS_MONITOR_DB ||--o{ CAMERA_ASSIGNMENT : "manages access for CCTV-Operator"
```

1. **No `localStorage` / `sessionStorage`**: Store cookies exclusively as `HttpOnly`, `SameSite=Strict`, and `Secure` to prevent XSS script token theft.
2. **Timing Attack Protection**: Use uniform bcrypt hash timing comparisons even when a username is not found.
3. **Menu Filtering**: UI elements corresponding to unauthorized roles are filtered out at the server level, leaving no traces in the HTML DOM.
4. **Closed Registration Provisioning (2026-07-21, IDEA1 + IDEA2)**: System-wide self-registration is disabled. New accounts are created solely via Admin (`POST /api/users`, IDEA1) or SSH CLI (`server/cli/manage_users.py`, IDEA2). Initial temporary passwords are server/CLI generated, and all new accounts carry `must_reset_password = TRUE` — `requireRole.js` blocks all endpoints except `/me`, `/logout`, and `/password/reset` until password reset succeeds.
5. **Bootstrap Credential Hygiene (IDEA1)**: `ADMIN_BOOTSTRAP_PASSWORD_HASH` provided to the container must be a pre-calculated bcrypt hash (`scripts/hash_password.py`, using `getpass` without echoing or logging), never a raw password. `bootstrapAdmin.js` validates bcrypt formatting prior to boot, failing loudly if invalid.
6. **Authorisation is re-checked for the life of a connection (2026-07-27, IDEA2)**: a request/response check is insufficient for anything long-lived. A live MJPEG stream is authorised at open **and re-validated every 10s** — the session is re-read from the store and `camera_assignment` re-checked. Measured: logout cuts the stream at **t=10.06s**; a SOC revoking the camera cuts it at **t=10.03s**. Without this, a logged-out operator would keep receiving live video until they closed the tab.
7. **The edge service is never exposed to browsers (2026-07-27, IDEA2)**: the Detection Engine's MJPEG endpoint is gated by the shared service key and reached **only** by Monitor's backend. The browser talks to Monitor's own origin; the engine's address (`camera_heartbeat.stream_url`) and its key never appear in any client payload — the client receives only a `hasStream` boolean. Scoping (`canSeeCamera`) completes **before** any socket to the engine is opened.
8. **Values that reach the backend become attack surface**: `stream_url` arrives from the engine but becomes a destination Monitor itself dials, so it is validated to `http`/`https` on ingest (SSRF containment) — being authenticated is not the same as being trusted.
9. **Seeded credentials are single-use in both apps (2026-07-27)**: bcrypt hashes committed to a public repository are public knowledge forever. Both `seed.sql` files now set `must_reset_password = TRUE` with an idempotent follow-up `UPDATE` (matched on the git-known hashes) so databases created before the change are closed too. Plaintext passwords were also removed from IDEA2's seed header — a comment recording real credentials is itself the leak.

---

## 🔐 Host Security Layer 0 — SSH Administration

The Beelink host has a separate least-privilege boundary beneath application RBAC:

```mermaid
flowchart LR
    TG["Twingate Resource<br/>192.168.10.10:22/TCP"] --> SSH["OpenSSH daemon"]
    SSH --> KEY["Individual ed25519 key"]
    KEY --> ADMIN["admin-main<br/>system administration + sudo"]
    KEY --> MEMBER["member account<br/>no implicit sudo"]
    ADMIN --> CFG["sshd effective-config checks"]
```

The 2026-08-08 baseline through `admin-main` was `PubkeyAuthentication yes`, `PasswordAuthentication yes`, and `PermitRootLogin prohibit-password`, with the explicit password setting coming from `/etc/ssh/sshd_config.d/50-cloud-init.conf`. On 2026-08-11 the operator confirmed `PermitRootLogin no` is now applied and the Twingate UFW path works. `krayukantk` remains a non-sudo member with a working individual key; `pubpup2006p` still needs owner-generated key onboarding, so Password Auth intentionally remains enabled. The remaining target is `PasswordAuthentication no` after onboarding/cleanup, plus a direct VLAN 30 UFW test. Full operational status: [[infrastructure/server/SSH-Hardening-Status]] and [[infrastructure/server/Linux-User-Accounts]].

---

## 🔗 Related Notes
* [[core/system-overview]]
* [[core/hub-aegis-entry]]
* [[idea1/idea1-status]]
* [[idea2/idea2-status]]
* [[idea3/idea3-status]]
* [[concepts/Honest_Telemetry_and_Unavailable_States]]
