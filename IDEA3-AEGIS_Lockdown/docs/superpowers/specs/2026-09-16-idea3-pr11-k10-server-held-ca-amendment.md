# IDEA3 PR11 — K10 amendment: server-held dedicated machine-client CA

- **Date:** 2026-09-16
- **Status:** PROPOSED — PENDING_KLA
- **Area / owner:** `idea3` / Music (Core key custodian); Kla (`kraveerachat`) is the proposed CA key custodian and the required reviewer
- **Branch / PR:** `feat/idea3-pr11-phase2-runtime-completion` / #146 (Draft)
- **Amends:** decision K10 as recorded in
  `IDEA3-AEGIS_Lockdown/docs/operations/PR10_DEPLOYMENT_INVENTORY.md` (K1–K12 table, K10 row) and
  `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-14-idea3-pr11-phase1-postmerge-reconciliation.md` (§ K10)
- **Production effect of this document:** none

```text
K10_AMENDMENT_STATUS          = PROPOSED
K10_AMENDMENT_REVIEW          = PENDING_KLA
K10_CA_MODEL                  = SERVER_HELD_DEDICATED_CLIENT_CA   (proposed; replaces OFFLINE_DEDICATED_CLIENT_CA for future execution only)
K10_CA_KEY_HOST               = AEGIS Production Server
K10_CA_KEY_CUSTODIAN          = kraveerachat (Kla, infrastructure owner)
K10_CORE_KEY_CUSTODIAN        = music (Core owner)
K10_CA_KEY_ENCRYPTION         = PASSPHRASE_ENCRYPTED, entered interactively by Kla (proposed)
PRODUCTION_MUTATION_AUTHORIZED = NO
PRODUCTION_MUTATION_PERFORMED  = NO
```

Architecture approved is not Production mutation authorized. Even after Kla
approves this amendment, creating the CA, signing the Core CSR, generating the
CRL, and placing files in the HUB certificate mount each remain a separate,
explicitly authorized Production action.

## 1. The old K10 architecture (historical, accurate for its time)

Kla approved K10 on 2026-09-12 (architecture/integration only), and the
2026-09-14 reconciliation restated it:

- a **dedicated** IDEA3 machine-client CA, `clientAuth` only, path length 0,
  separate from the browser/server CA and the D2 MQTT CA;
- **the CA private key held offline by Kla, not on the AEGIS Production Server**;
- the Core generates its own key and CSR, and the key never leaves the Core;
- Core certificates valid about 90 days, renewed around day 60;
- a Kla-maintained CRL loaded by the HUB (`ssl_crl`), IDEA3's expected-subject
  check, and short lifetimes for revocation;
- expiry or an invalid identity pauses dispatch only.

Those records stay unchanged. They accurately describe the decision in force
when they were written. This amendment supersedes only the **CA key
location**, and only for future execution, once Kla accepts it.

## 2. The proposed K10 architecture

The dedicated CA private key is held **on the AEGIS Production Server** under
root-only custody:

| Item | Location | Owner / mode | Reaches the HUB mount? |
|---|---|---|---|
| CA private key | `/opt/aegis/pki/private/idea3-machine-client-ca.key` | `root:root` `0600`, passphrase-encrypted; directory `0700` | **never** |
| CA certificate (canonical) | `/opt/aegis/pki/certs/idea3-machine-client-ca.crt` | `root:root` `0644` | copied |
| CRL (canonical) | `/opt/aegis/pki/crl/idea3-machine-client-ca.crl` | `root:root` `0644` | copied |
| CA database (index, serial, crlnumber, newcerts) | `/opt/aegis/pki/idea3-machine-client-ca/` | `root:root` `0700` | never |
| Issued Core certificates | `/opt/aegis/pki/issued/idea3-core-client-<UTC>.crt` | `root:root` `0644` | never (returned to the Core) |
| HUB public copies | `/opt/aegis/runtime/certs/idea3-machine-client-ca.crt`, `.crl` | `root:root` `0644` | these are the copies |

The repository documents no earlier `/opt/aegis` PKI directory convention, so
`/opt/aegis/pki/` is introduced here. It deliberately sits outside
`/opt/aegis/runtime/`, which holds the Compose runtime and the HUB certificate
mount (`/opt/aegis/runtime/certs` → `/etc/nginx/certs`).

The CA private key is:

- never mounted into the HUB or any container;
- never copied into `/opt/aegis/runtime/certs`;
- never committed, printed, or logged;
- not readable by the IDEA3 Web container, the HUB, or the Core.

Only the public CA certificate and the CRL are copied to the HUB certificate
mount. The NGINX machine block keeps referencing exactly
`/etc/nginx/certs/idea3-machine-client-ca.crt` and
`/etc/nginx/certs/idea3-machine-client-ca.crl`.

### 2.1 Who does what

**Kla, as root on the AEGIS Production Server** (`p2-k10-server-ca.sh`):

1. `MODE=preflight` (read-only) — custody, permissions, HUB mount, and
   container mounts.
2. `MODE=init` — create the passphrase-encrypted dedicated CA key (EC P-384),
   the self-signed CA certificate (`CA:TRUE, pathlen:0`, critical;
   `keyUsage = critical, keyCertSign, cRLSign`), the CA database, and the first
   CRL. It refuses if any CA key, certificate, or database already exists.
3. `MODE=sign` — sign the Core CSR. It refuses unless the CSR's SHA-256 matches
   the value Music recorded on the Core, its subject is exactly `CN=idea3-core`,
   its self-signature verifies, its key is EC P-256, and the file carries no
   private key. The issued certificate is `CA:FALSE`,
   `keyUsage = critical, digitalSignature`,
   `extendedKeyUsage = critical, clientAuth` only, and 90 days by default
   (never more than 100). CSR extensions are never copied.
4. `MODE=crl` — regenerate the CRL, with `nextUpdate` bounded to 7–45 days
   (30 by default).
5. `MODE=revoke` — revoke an issued certificate, then regenerate the CRL.
6. `MODE=publish` — copy **only** the public CA certificate and CRL into the
   HUB certificate mount. NGINX is not reloaded; that belongs to the authorized
   Phase 2B window.
7. `MODE=verify` (read-only) — re-prove all of the above.

Every mutating mode needs `AUTHORIZE_IDEA3_K10_SERVER_CA_MUTATION=YES`, root,
and an interactive terminal. OpenSSL itself prompts for the passphrase, so the
helper never sees, stores, or forwards it. The passphrase is never placed in
Git, the environment, a file, or a log.

**Music, on the Core** (`p2-k10-client-pki.sh`):

- `MODE=csr` — already executed: the Core key and CSR exist (see §5).
- Send only the CSR, with its SHA-256, from the Core to the Server.
- `MODE=verify` — after the signed certificate, the public CA certificate, and
  the CRL come back. It still **fails** if a CA private key appears in the Core
  PKI directory.

Only these cross hosts: the CSR (Core → Server), the signed client certificate
plus the public CA certificate and CRL (Server → Core), and the public CA
certificate and CRL (canonical → HUB mount).

## 3. Why the change was requested

The owner requested it for operational simplicity:

- an offline CA host must be kept available and secured for every issuance,
  renewal around day 60, CRL regeneration before `nextUpdate`, and revocation.
  An expired CRL makes the HUB refuse every client, so a missed offline step
  pauses dispatch;
- IDEA1 already maintains PKI signing material on the same Production Server
  (owner-stated; not re-verified by this repository task), so infrastructure
  custody of signing keys on that host is an existing operational pattern that
  Kla already administers.

## 4. Security trade-off and explicit risk acceptance

**This model is not equivalent to offline CA custody.** It weakens the
isolation that K10 originally required.

- **Accepted risk:** a root compromise of the AEGIS Production Server now also
  compromises the K10 issuing authority. Such an attacker can wait for, or
  capture, the passphrase entry and mint `clientAuth` certificates for
  `CN=idea3-core` that the HUB machine block would accept. With offline custody,
  server root alone was not enough.
- The dispatch path that a forged machine identity could reach is bounded by
  the existing server-side controls: IDEA3 accepts identity headers only from
  the HUB's pinned address with `SUCCESS`, applies its expected-subject check
  and the Protocol v1/dispatch contract, and a root attacker on that server
  already controls the HUB and IDEA3 Web. The amendment does not change those
  controls.

Mitigations required by this amendment:

1. a **dedicated** CA: never the AEGIS Internal Root CA (PEM SHA-256
   `8d03ec30…a10ca7` is pinned as a negative) and never the MQTT CA;
2. a **root-only, passphrase-encrypted** key (`root:root 0600`, directory
   `0700`), never in a container mount, the runtime tree, or Git;
3. **short-lived** Core certificates (about 90 days, maximum 100);
4. a **CRL** with bounded `nextUpdate`, loaded by the HUB (`ssl_crl`);
5. an **explicit issuance and revocation procedure** (`p2-k10-server-ca.sh`),
   CSR digest pinning, and an exact-subject check;
6. **audit evidence:** each issuance, revocation, and CRL run records the
   helper's SHA-256, the UTC time, the operator, the issued serial, and the PASS
   lines. It never records key material or the passphrase.

Kla's approval of this amendment is the explicit acceptance of the risk above.
Without it, the old offline model remains the approved K10 architecture.

## 5. Unchanged guarantees

- the machine-client CA stays **separate** from the AEGIS Internal Root CA and
  the MQTT CA;
- it issues **`clientAuth` certificates only**;
- it is `CA:TRUE, pathlen:0` with `keyCertSign` and `cRLSign`;
- a **CRL** is maintained and loaded by the HUB;
- the Core client certificate is `CN=idea3-core`, which equals
  `AEGIS_IDEA3_DISPATCH_EXPECTED_SUBJECT`;
- the Core certificate lifetime stays about **90 days**;
- expiry or an identity failure **pauses dispatch only**;
- it **never** triggers CUT or RESTORE;
- it **never** allows a browser-authentication fallback;
- the **Core private key stays on the Core**;
- the HUB machine block trusts only this CA, with `ssl_verify_client on` and
  `ssl_verify_depth 1`.

## 6. Current K10 state — unchanged by this amendment

Observed live state, as reported by the owner outside this repository task:

```text
K10_CORE_SERVICE_ACCOUNT = aegis-idea3 (exists)
K10_CORE_KEY             = /etc/aegis-idea3/pki/idea3-core-client.key  aegis-idea3:aegis-idea3 0400 (Core only)
K10_CORE_CSR             = CN=idea3-core  SHA-256 5d9125747371d522d65545c4cde0087897bdd1c483be82061fc5105d6b5610fe
K10_HUB_SERVER_CA_ON_CORE = /etc/aegis-idea3/pki/hub-server-ca.crt (installed)

CORE_KEY_CSR = PASS
CA_ISSUANCE  = NOT_DONE
CLIENT_CERT  = NOT_DONE
CRL          = NOT_DONE
LIVE_MTLS    = NOT_PROVEN
K10          = NOT PASS
```

## 7. What this amendment does not do

- It performs no Production mutation. Nothing ran against the AEGIS Production
  Server, and no CA, key, certificate, CSR, or CRL was created outside
  TEST-ONLY pytest temporary directories.
- It is not effective for live K10 issuance until Kla accepts it through normal
  GitHub review of this PR.
- It does not authorize Phase 2A, Phase 2B, or any `MODE=init/sign/crl/revoke/publish` run.
- It does not activate K9 machine SNI or change NGINX behavior. Only a stale
  comment in `HUB-AEGIS_Entry/nginx.idea3-machine-phase2b.conf` changed.
- It does not rewrite the historical K10 records or any receipt.

## 8. Superseded wording (forward reference only)

These records describe offline custody. They remain true historical records,
and for **future execution** they are superseded by this amendment, subject to
Kla review:

- `IDEA3-AEGIS_Lockdown/docs/operations/PR10_DEPLOYMENT_INVENTORY.md` (K10 row)
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-14-idea3-pr11-phase1-postmerge-reconciliation.md` (§ K10)
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-15-idea3-pr11-phase2-server-integration-design.md` (IR-6)
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-15-idea3-pr11-phase2-live-evidence-reconciliation.md` (§ 5.4)
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-15-idea3-pr11-phase3-core-live-design.md` (§ 11)
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-16-idea3-pr11-phase2-kla-owner-decisions.md` (§ 6)
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-14-idea3-pr11-phase1-owner-decision-package.md` (K10 paragraph)
- receipts under `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/` that
  mention offline custody — immutable, never edited.

The current operational tooling on this branch (`p2-k10-client-pki.sh`
`MODE=contract`, `README.md` §8, `idea3-machine-client-ca.cnf`) now describes
the proposed model and states that it is pending Kla review.

## 9. Review request (approve-only)

Kla (`kraveerachat`): **Approve** accepts the server-held custody model and the
§4 risk, and makes this the K10 architecture for future execution. **Request
Changes** keeps offline custody in force. An approval authorizes no Production
action.

## 10. Verification

- `IDEA3-AEGIS_Lockdown/tests/test_pr11_k10_server_ca.py` exercises the helper
  and the Core-side contract with TEST-ONLY fixtures in pytest temporary
  directories. Fixtures are not K10 evidence.
- `HUB-AEGIS_Entry/tests/idea3RoutingContract.test.mjs` still pins
  `ssl_client_certificate` and `ssl_crl` to the public paths.
