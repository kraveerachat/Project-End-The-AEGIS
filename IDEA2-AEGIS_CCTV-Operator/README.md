# IDEA 2 · AEGIS CCTV-Operator

> ## ⚠️ DEPRECATED — `web-app/` merged into `../IDEA2-AEGIS_Monitor`
>
> Per the architecture decision (2026-07-20), AEGIS Monitor is **one app with two
> role-based views** (Aggregate for SOC-Responder, Scoped for CCTV-Operator) behind
> **one backend on port 8002** with its own identity store and `camera_assignment`
> table. The Scoped View screens now live in `IDEA2-AEGIS_Monitor` and are resolved
> **server-side** from the user's role.
>
> The old `web-app/` here also contained an SSO shim that trusted the HUB's session
> cookie (`server/index.js` → `localhost:3001/api/me`). That pattern is **forbidden**
> (HUB must never issue a session IDEA2 trusts) and has NOT been carried over.
>
> `web-app/` is kept only as an unmerged reference and is safe to delete.
> **`detection-engine/` is NOT deprecated** — it remains the Laptop-side sensor layer.

Two-machine split (do not merge them):

| Subfolder          | Runs on  | Responsibility                                             |
| ------------------ | -------- | ---------------------------------------------------------- |
| `detection-engine/`| Laptop   | AI face-recognition. Reads cameras, **writes to DB.** No UI. |
| `web-app/`         | Beelink  | **Reads DB only.** Role-based views. No model, no capture.  |

## Boundaries
- The engine and the web app talk **only through the database** — never call each other directly.
- Role-based access is enforced server-side (same rule as HUB-AEGIS_Entry: role comes from the DB, never from the client).
- The `camera_assignment` table is **owned by IDEA2** (see `../shared/db-schema/`).

## Do NOT put here
- Data-lake / file-storage features → those belong to **IDEA 1 (AEGIS Drive)**.
- Physical lockdown / relay control → those belong to **IDEA 3 (AEGIS Lockdown)**.
