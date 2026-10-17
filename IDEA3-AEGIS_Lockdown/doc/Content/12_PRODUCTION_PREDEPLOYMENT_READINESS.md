# 12 — Production pre-deployment readiness (STEP 38.5) — NOTHING DEPLOYED

Classification vocabulary: **VERIFIED** (proved by evidence gathered in this repository work or by a read-only inspection recorded in a receipt), **READY FOR REVIEW** (source + offline tests exist; a human must review), **BLOCKED** (a known gate prevents progress), **UNKNOWN** (no evidence). No item is claimed deployed.

## 1. Readiness matrix

| Item | Class | Basis |
|---|---|---|
| Core status publisher (`tools/status_projection_publisher.py`, PR #443) | READY FOR REVIEW | 46 offline tests; not installed; ships in the status sidecar package (STEP 38.6, doc 13), not the Core release |
| Purple Desktop reader (no sudo, PR #443) | READY FOR REVIEW | offline tests; no manual GUI check against the real Core file |
| Core status pusher (`tools/status_push_client.py`) | READY FOR REVIEW; **install BLOCKED** | 38 tests + offline mTLS E2E; packaged in the sidecar (source), but no owner-run sidecar installer exists |
| Web machine status route / flag | READY FOR REVIEW | route tests + E2E; default disabled; deployed Web image unknown |
| Deployed Web container (identity, digest, revision) | UNKNOWN | HUB not reachable from the Core host |
| HUB nginx machine block / Phase 2B | UNKNOWN | repository file exists; installed state unverified |
| mTLS certificates (validity, CRL, CN) | UNKNOWN | not inspected |
| Core → HUB network (route, `idea3-core.aegis.internal` DNS) | BLOCKED | STEP 38.1/38.2: no route/DNS observed from the Core host |
| AP (10.77.30.1) | BLOCKED | Core host is a Wi-Fi client; no AP (STEP 38.2) |
| Mosquitto 8883 (IDEA3 broker) | BLOCKED | restart loop because the AP address is absent (STEP 38.2) |
| dnsmasq | BLOCKED | failed, start-limit-hit (STEP 38.2) |
| Plaintext Mosquitto 1883 on all interfaces | BLOCKED (exposure, owner decision) | system mosquitto listens 0.0.0.0:1883 (STEP 38.2) |
| Clock synchronization (Core and HUB) | UNKNOWN | not re-checked in this task |
| Rollback | READY FOR REVIEW | documented in doc 11 section 5; never exercised |
| Production acceptance | NOT STARTED | doc 11 section 6, owner-run |
| Installed Core release `954ce1c1` | VERIFIED (source) | contains `RuntimeStatus` and an unchanged `safe_status_projection`; see 2 |

## 2. Core release compatibility (source inspection only; no builder was run)

Compared the installed release `954ce1c191885e9e90198a6f54a3d990bcf144fc` (an ancestor of `main`, 348 commits behind `5a673848`) with the current tree.

| Aspect | Result |
|---|---|
| `status.json` schema | Compatible: `RuntimeStatus` at the release has state, profile, dry_run, auto_contain, broker, device, uplink, armed, dispatch, time_trust, updated_at, components (plus pid/detail, which the publisher drops). |
| `safe_status_projection` | Byte-identical function body on both trees; `main` only adds `safe_evidence_projection` (not used by the pusher). |
| Timestamp semantics | `updated_at = time.time()` set at each atomic write in both; the pusher forwards it as `generatedAt` and never rewrites it. |
| `aegis_soc/observer.py` | **New since the release** (absent at `954ce1c1`); required by the publisher and pusher. |
| `tools/` package | **Not in any release**; the release builder ships only the `aegis_soc` closure of supervisor, recovery_ui, production_detector, cli (verified by computing the closure: `observer` and `status_projection*` are not in it; `dispatch_client` and `runtime` are). |
| `dispatch_client.py` | Identical to the release; the pusher reuses its `build_client_ssl_context`. |
| Python dependencies | Pusher and publisher are stdlib-only; the release's only third-party root is `paho`. |
| Core identity / filesystem | The pusher must read the 0700 `/run/aegis-idea3/status.json` as the Core user or an owner-approved group; no permission was changed. |
| mTLS client configuration | Reuses the Core's dispatch client certificate/CA files by path (`AEGIS_CORE_DISPATCH_*` paths already exist in the env example); separate `AEGIS_CORE_STATUS_PUSH_*` variables keep it independent of dispatch enablement. |
| `main` vs release | 13 `aegis_soc` files differ, including new `cut_client.py`, `local_cut.py`, `incident_view.py` and supervisor changes (local manual CUT, inert unless configured). A new Core release is therefore a larger change than the status work alone and needs the governed upgrade path. |

Conclusion: the status data contract is compatible with the installed release. STEP 38.6 resolves the **packaging** gap in source with a separate sidecar package that leaves the Core release contract untouched (doc 13); an owner-run sidecar installer is still missing. A new Core release must not be assumed safe because offline tests pass (and four pinned closure tests are already stale on `main`, doc 13 section 5).

## 3. HUB read-only command package (for an authorized HUB operator)

Rules: run as the operator's normal account; no sudo; do not paste output containing secrets; if a command is denied, record `BLOCKED` and stop — do not escalate. Nothing below changes Docker, nginx, certificates, routing, DNS, Twingate or the firewall. Environment values are filtered to an allowlist of non-secret names.

```sh
# H1 Web container identity, image digest, health, uptime (names/ids only)
docker ps --filter name=idea3 --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
docker inspect --format '{{.Name}} image={{.Image}} started={{.State.StartedAt}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' <idea3-web-container>
docker image inspect --format '{{index .RepoDigests 0}} created={{.Created}}' <idea3-web-image>
docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' <idea3-web-container>   # blank if unlabeled

# H2 Machine listener / status flag state (allowlisted names only; NEVER print the whole environment)
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' <idea3-web-container> \
  | grep -E '^(NODE_ENV|AEGIS_IDEA3_(STATUS_INGEST_ENABLED|DISPATCH_ENABLED|DISPATCH_HOST|DISPATCH_PORT|DISPATCH_EXPECTED_SUBJECT|LAB_RUNTIME_STATUS|LAB_MQTT_OBSERVER))=' 
# absent STATUS_INGEST line = flag off (default); the image must be one built from the successor source for the flag to exist

# H3 Phase 2B mTLS installed? (config shape only; key files are never read)
docker exec <nginx-container> nginx -T 2>/dev/null | grep -nE 'server_name idea3-core|ssl_verify_client|ssl_crl|location /security/api/machine/v1/|client_max_body_size|proxy_pass http://172\.31\.243\.3:8004'

# H4 Certificate validity (public certificates only)
openssl x509 -noout -subject -issuer -dates -in <idea3-core.aegis.internal.crt>
openssl x509 -noout -subject -dates -in <idea3-core-client.crt>        # CN must be idea3-core
openssl crl -noout -lastupdate -nextupdate -in <idea3-machine-client-ca.crl>

# H5 Unrelated services preserved (before/after comparison, read-only)
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | sort

# H6 Clock
timedatectl show -p NTPSynchronized -p TimeUSec
```

On the Core host (read-only, no connection to the HUB):

```sh
getent hosts idea3-core.aegis.internal || echo "NO_DNS"
ip route get 192.168.10.10 2>&1 | head -2
timedatectl show -p NTPSynchronized -p TimeUSec
```

A TLS handshake probe from the Core host to the HUB is a network action and is **not** part of this read-only package; it requires explicit owner authorization.

If the HUB is not accessible, the answer is `HUB_READINESS=BLOCKED`, owner = infrastructure (Kla). No reachability was verified or fabricated by this repository work.

## 4. What stays unchanged

The installed Core (including PID 939), the existing Web service, nginx, certificates, broker, AP, dnsmasq, firewall and routing were not touched by any step of STEP 38.3–38.5.
