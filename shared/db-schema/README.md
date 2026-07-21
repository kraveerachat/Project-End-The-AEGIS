# Shared · DB Schema Notes

Central notes for the schema shared across AEGIS modules. **Notes only — the authoritative
`CREATE TABLE` statements live with whichever module owns each table.**

## Ownership (updated 2026-07-20 — per-app identity, no central users table)
| Table                     | Owner  | Notes                                                                 |
| ------------------------- | ------ | --------------------------------------------------------------------- |
| `users` (aegis_drive)     | IDEA 1 | `IDEA1-AEGIS_Drive_LC/server/db/schema.sql` — Admin / DataLake-User.  |
| `files` `shares` `audit_log` | IDEA 1 | Drive metadata; audit stores filenames as SHA-256 (`target_hash`). |
| `users` (aegis_monitor)   | IDEA 2 | `IDEA2-AEGIS_Monitor/server/db/schema.sql` — SOC-Responder / CCTV-Operator. |
| `camera_assignment`       | IDEA 2 | Owned by **AEGIS Monitor**. Every Operator query JOINs it server-side. |
| `cameras` `detections` `alerts` `clips` | IDEA 2 | Written by the Detection Engine; Monitor reads only.   |

⚠️ The two `users` tables live in **separate databases** (`aegis_drive` / `aegis_monitor`).
The HUB owns **no tables at all** (routing-only). Duplicating auth code between IDEA 1 and
IDEA 2 is **architecturally correct** — do not extract a shared identity module.

## Rules
- One table has **one owning module**. Other modules may read it, but schema changes
  (columns, constraints, migrations) go through the owner.
- `role` lives in `users` and is resolved **server-side** — no module ever trusts a role
  value sent by a client.
- Keep model binaries (`.pt`, `.h5`) and secrets **out** of the schema and out of git.
