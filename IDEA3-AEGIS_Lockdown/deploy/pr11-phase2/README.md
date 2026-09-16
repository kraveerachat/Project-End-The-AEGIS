# AEGIS IDEA3 PR11 Phase 2 — runtime execution package (PREPARED, NOT EXECUTED)

Prepared while `K3_EXECUTION_WINDOW=OWNER_CONFIRMATION_REQUIRED`. Nothing here
has run against Production. `PRODUCTION_MUTATION_AUTHORIZED=NO`,
`STAGE_B_ALLOWED=NO`.

Accepted decisions this package implements: **PR #139** (K1/K3/K7 package) and
**PR #140** (`K7_OWNER_DECISION=ACCEPT_CURRENT_BASE_SEMANTICS_FOR_NEXT_HUB_RECREATE`).

| File | Runs on | Mutates | Purpose |
|---|---|---|---|
| `p2-lib.sh` | — | no | shared constants, accepted hashes, helpers |
| `p2a-baseline.sh` | server | no | pre-mutation baseline and preconditions |
| `p2a-execute.sh` | server | **yes** | Phase 2A, gated on the exact authorization |
| `p2a-verify.sh` | server | no | post-change verification and preservation |
| `p2a-rollback.sh` | server | **yes** | scoped rollback, `--stage web` or `--stage full` |
| `p2-k8-core-evidence.sh` | **Core** | no | K8 wired VLAN 20 → HUB 443 evidence |
| `p2b-tests-core.sh` | **Core** | no | Phase 2B mTLS matrix |
| `p2b-tests-server.sh` | server | no | peer pinning, machine block, PKI metadata |
| `idea3-machine-client-ca.cnf.example` | Kla, offline | no | dedicated client-CA template |

## 1. Accepted Compose model

```bash
docker compose -p aegis-prod --project-directory /opt/aegis/runtime \
  --env-file /opt/aegis/Project-End-The-AEGIS/.env \
  -f /opt/aegis/runtime/docker-compose.production.yml \
  -f /opt/aegis/runtime/idea3/idea3-phase2.yml
```

Exactly these two files for the HUB. The Monitor and Public Share overlays stay
service-scoped and are never added here; every operation on those services keeps
using that service's own recorded list.

**Never**: `docker compose down`, `--remove-orphans`, an `up` without a service
name, `--build` during Phase 2, or any restart of a preserved service.

## 2. Order of execution

1. `sudo EVID_DIR=~/idea3-p2a-evidence/pre bash p2a-baseline.sh` → must end `BASELINE=PASS`.
2. `sudo AUTHORIZE_…=YES K3_EXECUTION_WINDOW=CLEAR BASELINE_DIR=… OVERLAY_SRC=… WEB_CONTEXT_TGZ=… NODE_IMAGE_DIGEST=sha256:… K1_NGINX_CANDIDATE=… K1_NGINX_CANDIDATE_SHA256=… bash p2a-execute.sh`
   (add `DRY_RUN=1` first for a rehearsal that changes nothing).
3. `sudo BASELINE_DIR=… bash p2a-verify.sh` → must end `VERIFY_PHASE2A=PASS`.
4. HTTP checks from a trusted workstation, certificate validation on (below).

Execute steps in order: S0 re-verify → S1 place overlay → S2 render → S3 build
image → S4 start IDEA3 Web (creates the network) → S5 drift checkpoint →
S6 isolated `nginx -t` → S7 snapshot and install the NGINX candidate →
S8 recreate the HUB alone.

### HTTP checks (workstation, TLS validated, never `-k`)

```bash
for p in /healthz /drive/healthz /monitor/healthz /security /security/ \
         /security/api/readiness /security/api/machine/v1/dispatch/pending /monitor/internal; do
  printf '%-45s ' "$p"; curl -sS -o /dev/null -m 8 -w '%{http_code} %{redirect_url}\n' "https://192.168.10.10$p"
done
curl -sSI https://192.168.10.10/security/ | grep -iE 'content-security-policy|x-frame-options|strict-transport'
```

Expected: `/security` → 301 to `/security/`; `/security/` → 200 and **not** the
1117-byte HUB landing page (`e1516fa9…`); `/security/api/readiness` → 200
`{"status":"READY"…}`; the machine path → 404; `/healthz`, `/drive/healthz`,
`/monitor/healthz` → 200; `/monitor/internal` → 404; `X-Frame-Options: DENY` and
the IDEA3 CSP at the edge. An owner login additionally shows the session cookie
as `Path=/security; Secure; HttpOnly; SameSite=Strict`.

## 3. Inputs the execution needs

| Input | Owner | Note |
|---|---|---|
| `AUTHORIZE_IDEA3_PR11_PHASE2_RUNTIME_PRODUCTION_MUTATION=YES` | Music | exact phrase, in the executing session |
| `K3_EXECUTION_WINDOW=CLEAR` | Kla | currently `OWNER_CONFIRMATION_REQUIRED` |
| `K1_NGINX_CANDIDATE` + its SHA-256 | **Kla** | live `16cee162…` reconciled into Git, plus IR-1; IDEA3 never edits `HUB-AEGIS_Entry/nginx.conf` |
| `OVERLAY_SRC` | Music | repo `deploy/docker-compose.pr11-phase2.yml`, SHA-256 `2feaad01…` |
| `WEB_CONTEXT_TGZ` | Music | `git archive --format=tar 505dcdfb IDEA3-AEGIS_Lockdown/web \| gzip -n` → SHA-256 `1710d0ee…` |
| `NODE_IMAGE_DIGEST` | Music | `node:22-alpine` index digest, re-verified at build time (was `sha256:c610fcdf…` on 2026-09-15) |
| `/opt/aegis/runtime/idea3/secrets/{session-secret,admin-password-hash}` | Music | `1000:1000`, mode `0400`; contents never read by any script |

Secret provisioning, on the server, with `umask 077` (the value is never echoed):

```bash
sudo install -d -m 0750 -o root -g root /opt/aegis/runtime/idea3/secrets
openssl rand -base64 48 | sudo tee /opt/aegis/runtime/idea3/secrets/session-secret >/dev/null   # ≥32 chars
# Admin password hash: bcrypt, read from stdin, never echoed or stored in history
npm --prefix IDEA3-AEGIS_Lockdown/web run hash-password   # type the password, copy the $2b$12$… line
sudo tee /opt/aegis/runtime/idea3/secrets/admin-password-hash >/dev/null
sudo chown 1000:1000 /opt/aegis/runtime/idea3/secrets/*; sudo chmod 0400 /opt/aegis/runtime/idea3/secrets/*
```

## 4. Rollback

Triggers, any one of them:

- IDEA3 Web not `healthy` within 120 s, wrong networks, a published port, or
  readiness not `READY`;
- the Public Share connector changes state, the drift run stops reporting
  `success`, or `s5-5-firewall.sh validate` stops reporting VALID;
- `nginx -t` fails on the candidate (abort before installing; no rollback needed);
- the HUB is not healthy within 120 s, its image changed, or its networks are
  not exactly drive-proxy `.2` + IDEA3 `.2` + internal `.4`;
- any preserved container's id, image, created, started, or restart count moved;
- `/healthz`, `/drive/healthz`, or `/monitor/healthz` stops returning 200.

```bash
sudo CONFIRM_ROLLBACK=YES BASELINE_DIR=… bash p2a-rollback.sh --stage web    # before the NGINX install
sudo CONFIRM_ROLLBACK=YES BASELINE_DIR=… RUN_DIR=… bash p2a-rollback.sh --stage full
sudo MODE=rollback BASELINE_DIR=… bash p2a-verify.sh
```

Rollback restores the snapshot artifact (`16cee162…`), recreates the HUB alone
from the base file, removes IDEA3 Web and then the network only when empty, and
moves the overlay aside. It **preserves `aegis_idea3_web_data`** and never sends
CUT or RESTORE, actuates GPIO, or reboots anything.

## 5. Preservation set

`aegis-prod-drive-1`, `aegis-prod-monitor-1`, `aegis-prod-postgres-1`,
`aegis-prod-public-share-gateway-1`, `aegis-prod-public-share-connector-1`,
`twingate-aegis-connector-02`. `p2a-verify.sh` compares each one's id, image,
created, started, status, restart count, config-hash and networks with the
baseline, plus the Public Share file hashes, units, drift result and firewall
validation.

## 6. K8 — Core → HUB 443

Run `p2-k8-core-evidence.sh` **on the host the owner declares as the Core**, with
its wired link on VLAN 20 (`192.168.20.0/24`). PASS requires: the declared
hostname matches, the wired link has carrier and a VLAN 20 address, the default
route to `192.168.10.10` leaves through that wired interface (not a tunnel), and
HTTPS returns 200 with certificate validation on. A workstation reaching the HUB
over Twingate is not Core evidence. If a Twingate route on the Core wins over the
wired path, K8 stays BLOCKED and the Core's routing is a D6 item.

## 7. K9 — exact owner actions (not IDEA3-owned)

1. **Name resolution** — either Kla adds `idea3-core.aegis.internal → 192.168.10.10`
   to router DNS, or Music adds one Core `/etc/hosts` entry. Verify with
   `getent ahosts idea3-core.aegis.internal` on the Core.
2. **Server certificate (Kla, AEGIS Internal Root CA).** On the server, key
   generated in place and never copied:

```bash
sudo install -d -m 0755 /opt/aegis/runtime/certs
umask 077
sudo openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout /opt/aegis/runtime/certs/idea3-core.aegis.internal.key \
  -out /tmp/idea3-core.csr -subj "/C=TH/O=AEGIS/CN=idea3-core.aegis.internal" \
  -addext "subjectAltName=DNS:idea3-core.aegis.internal"
# Kla signs on the CA host (serverAuth only, SAN carries the machine name):
openssl x509 -req -in idea3-core.csr -CA aegis-root-ca.crt -CAkey aegis-root-ca.key \
  -CAcreateserial -days 365 -sha256 -out idea3-core.aegis.internal.crt \
  -extfile <(printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=critical,serverAuth\nsubjectAltName=DNS:idea3-core.aegis.internal\n')
```

   Return only the certificate; place it at
   `/opt/aegis/runtime/certs/idea3-core.aegis.internal.crt` (`root:root`, `0644`;
   the key stays `0600`). **Use a separate certificate**: never add the machine
   name to the browser certificate, or a browser can coalesce HTTP/2 connections
   across the two server blocks.
3. **IR-2 machine block** — Kla installs it in the HUB artifact. In Phase 2B write
   it in place so the inode is kept, then `docker exec aegis-prod-hub-1 nginx -t`
   and `nginx -s reload`. No HUB recreate is needed for 2B.

## 8. K10 — exact owner actions (dedicated client CA)

Never create a substitute CA to move faster.

1. **Kla, offline host, once:** create the dedicated CA with
   `idea3-machine-client-ca.cnf.example`; the encrypted CA private key stays with
   Kla and never reaches the server, this repository, or IDEA3.
2. **Music, on the Core** (`umask 077`, service-account owned, key never leaves):

```bash
sudo -u aegis-idea3 openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout /etc/aegis-idea3/pki/idea3-core-client.key \
  -out /tmp/idea3-core-client.csr -subj "/CN=idea3-core"
sudo chmod 0400 /etc/aegis-idea3/pki/idea3-core-client.key
```

   Send only the CSR to Kla. `CN=idea3-core` must equal
   `AEGIS_IDEA3_DISPATCH_EXPECTED_SUBJECT`.
3. **Kla signs (clientAuth only, ~90 days) and generates the CRL:**

```bash
openssl ca -config idea3-machine-client-ca.cnf -extensions idea3_client -days 90 \
  -in idea3-core-client.csr -out idea3-core-client.crt
openssl ca -config idea3-machine-client-ca.cnf -gencrl -out idea3-machine-client-ca.crl
```

4. **Artifacts Kla returns:** `idea3-core-client.crt` → the Core;
   `idea3-machine-client-ca.crt` and `idea3-machine-client-ca.crl` → the HUB
   certificate mount; the AEGIS Internal Root CA certificate → the Core as
   `hub-server-ca.crt`. Renew around day 60 with a new key and CSR. Revocation:
   `openssl ca -revoke`, regenerate the CRL, replace it, reload the HUB.
   Watch `nextUpdate`: an expired CRL makes NGINX refuse every client, which
   fails closed and pauses dispatch.

## 9. Phase 2B

Prerequisites: Phase 2A PASS, K8 PASS, K9 material in place, K10 artifacts
returned, plus a reviewed **repository** Phase 2B overlay form
(`AEGIS_IDEA3_DISPATCH_ENABLED: "true"`), because the contract test pins the
committed 2A file to `false`. Then: place the 2B overlay at the same Production
path, `up -d --no-deps --no-build --force-recreate idea3-web` (the HUB is not
recreated), install IR-2, `nginx -t`, `nginx -s reload`, then run
`p2b-tests-core.sh` and `p2b-tests-server.sh`.

Expected: valid certificate 200; no certificate, wrong CA, revoked, and expired
all 400 at the edge; forged identity headers overwritten; Cookie and Origin
stripped; the machine path 404 on the browser name; a non-HUB peer 403 at the
IDEA3 listener. No CUT, RESTORE, GPIO, firmware, MQTT, AP, NTP, or reboot work
belongs to Phase 2.

## 10. Closeout checklist and evidence fields

Record, per run: script name and SHA-256, host, UTC start and end, `DRY_RUN`,
every PASS/FAIL line, the evidence directory, image id and base digest, the HUB
config-hash before and after, the NGINX snapshot path and hashes, and the
preserved-container comparison. Then update `idea3-status.md`, add exactly one
Music receipt, run the vault, policy, secret, binary and diff checks, open a
Draft PR, self-audit, mark Ready only when truthful, get a fresh guardrail PASS,
request `kraveerachat`, and never merge.

```text
K1= K3= K4= K7= K8= K9= K10= K12=NOT_PROVEN
PHASE2A= PHASE2B= PHASE2_RUNTIME_COMPLETE=
PRODUCTION_MUTATION_SUMMARY= ROLLBACK_USED= UNRELATED_SERVICE_PRESERVATION=
RECEIPT= RECEIPT_COUNT= PR_NUMBER= PR_STATE= GUARDRAIL= HUMAN_REVIEW_REQUESTED=
PHASE3_RUNTIME_COMPLETE=NO PHASE4_RUNTIME_COMPLETE=NO D4_LIVE_VERIFIED=NO PR11_COMPLETE=NO
```
