---
title: Schema Ownership Map
tags: [aegis, concept, database, schema, ownership, postgres]
type: concept
created: 2026-08-06
updated: 2026-08-06
sources: ["shared/db-schema/README.md"]
---

# 🗄️ Schema Ownership Map

> **Why this note exists**: `shared/db-schema/README.md` carries the table-ownership contract for the whole system, but lived outside the vault and was linked from nothing. It is the missing bridge between [[concepts/Identity_Decoupling]] (*why* there is no central users table) and [[concepts/Three_Layer_Data_Lake]] (*where* the data physically sits).

---

## The rule

**Notes only — the authoritative `CREATE TABLE` statements live with whichever module owns each table.** There is no central schema file, and deliberately **no central `users` table**. Each app owns its own identity domain; see [[concepts/Identity_Decoupling]].

## Ownership table

| Table | Owner | Database | Authoritative DDL |
|---|---|---|---|
| `users` | IDEA 1 | `aegis_drive` | `IDEA1-AEGIS_Drive_LC/server/db/schema.sql` — roles: Admin / DataLake-User |
| `files`, `file_versions`, `shares`, `network_zones`, `audit_log` | IDEA 1 | `aegis_drive` | Drive metadata; audit stores filenames as SHA-256 (`target_hash`) |
| `vault_meta`, `vault_blobs` | IDEA 1 | `aegis_drive` | Zero-knowledge envelope store — see [[concepts/Mnemonic_Recovery_and_Zero_Knowledge]] |
| `users` | IDEA 2 | `aegis_monitor` | `IDEA2-AEGIS_Monitor/server/db/schema.sql` — roles: SOC-Responder / CCTV-Operator |
| `cameras`, `camera_assignment` | IDEA 2 | `aegis_monitor` | Owned by AEGIS Monitor. **Every Operator query JOINs `camera_assignment` server-side** |
| `detections`, `alerts`, `clips`, `camera_heartbeat` | IDEA 2 | `aegis_monitor` | Written only via `/internal/*` by the engine — see [[entities/Detection_Engine_Service]] |

## Two enforcement facts that make this real

1. **Connection-level isolation, not convention.** Runtime roles `drive_app` and `monitor_app` each hold `CONNECT` on their own database only, with `REVOKE CONNECT … FROM PUBLIC` applied. A cross-database read fails at *connection* time, before any query is parsed. Full detail in [[concepts/Identity_Decoupling]] and [[summaries/02_Security_Auth_and_Identity]].
2. **`camera_assignment` is the scoping primitive.** It is the single table that decides which cameras a CCTV-Operator may see, stream, or receive alerts for — enforced server-side in `canSeeCamera()`, never in the UI. It is also what routes Telegram alerts to the right operator (see [[03 - 📹 IDEA2 AEGIS Monitor]]).

## Known gap

`aegis_monitor` has **no `audit_log` table** — IDEA1 has full audit logging, IDEA2 does not. Tracked in [[summaries/08_Outstanding_Items_Consolidated]].

---

## Related
[[concepts/Identity_Decoupling]] · [[concepts/Three_Layer_Data_Lake]] · [[concepts/Mnemonic_Recovery_and_Zero_Knowledge]] · [[05 - 🛡️ Security Architecture]] · [[02 - 💾 IDEA1 AEGIS Drive LC]] · [[03 - 📹 IDEA2 AEGIS Monitor]] · [[concepts/Terminal_Verification_Protocol]] · [[START_HERE]]
