# IDEA2 H1 Isolated Non-Production Environment Design and Runbook

**Status:** Approved design; repository-only contract. No live environment has
been provisioned.

**Scope:** The smallest environment that can later prove Machine A H1-1 through
H1-7 and H2/H3 without touching Production. This document authorizes no live
command by itself. Each numbered phase requires separate Human Owner approval.

## Binding classifications

```text
COMPOSE_PROJECT_NAME=aegis-h1-lab
CANDIDATE_NONPROD_HOSTNAME=idea2-h1.aegis-lab.internal
CANDIDATE_STREAM_HOSTNAME=idea2-h1-stream.aegis-lab.internal
CANDIDATE_HTTPS_PORT=18443
DATABASE_ISOLATION=SEPARATE_DATABASE_VOLUME_AND_CREDENTIALS
MONITOR_ISOLATION=SEPARATE_CONTAINER_NETWORK_AND_LIFECYCLE
HOST_COLOCATION_SAFE=CONDITIONAL_ON_N0_PASS
DEDICATED_HOST_REQUIRED=ONLY_IF_N0_CANNOT_PROVE_ISOLATION
PRODUCTION_INTEGRATION=NONE
LIVE_PROVISIONING_PERFORMED=NO
PRODUCTION_MUTATION=NO
MACHINE_A_MUTATION=NO
```

Both hostnames and both ports are **CANDIDATE_ONLY**. They are not DNS,
certificate, listener, firewall, Twingate, container, database, or tunnel
evidence. Production `aegis.internal`, the `aegis-prod` Compose project, and
the Production PostgreSQL database/volume are forbidden H1 targets.

## Architecture

The preferred topology is conditionally co-located on the existing
`aegis-system` host, but it shares no mutable application state with Production:

- Compose project: `aegis-h1-lab`.
- Services: project-scoped `gateway`, `monitor`, and `postgres` services. Do not
  declare reusable `container_name` values; Compose project scoping owns the
  concrete names.
- Networks: one project-scoped ingress network for gateway-to-Monitor traffic
  and one `internal: true` project-scoped backend network for
  Monitor-to-PostgreSQL traffic. Neither joins a Production network.
- Volume: one project-scoped `postgres_data` volume used only by the H1 lab.
- PostgreSQL: no host port. Administration occurs inside the isolated Monitor
  or PostgreSQL container with the lab `DATABASE_URL` supplied out-of-band.
- Monitor: no direct host port. Only the dedicated lab gateway reaches it.
- Gateway: the only candidate host listener is an explicit server IPv4 plus
  `18443`; no wildcard bind is permitted. N0 must prove the tuple is unused.
- Images: immutable candidate image references derived from the current branch
  SHA. Never retag or replace a Production image.
- Lifecycle: every create, inspect, stop, and remove command carries
  `--project-name aegis-h1-lab` plus the exact reviewed lab Compose file.

Host co-location and Production integration are different decisions.
`HOST_COLOCATION_SAFE=CONDITIONAL_ON_N0_PASS` means only that independent
resources may coexist after collision, capacity, and routing checks.
`PRODUCTION_INTEGRATION=NONE` means no Production Compose, volume, network,
gateway, database, certificate file, registry row, or application configuration
is changed. Use a dedicated host/VM if N0 cannot prove those boundaries, if the
explicit bind cannot be isolated, or if infrastructure ownership rejects
co-location.

## HTTPS, browser, and Agent ingress

```text
BROWSER_ORIGIN=https://idea2-h1.aegis-lab.internal:18443
AGENT_BASE_URL=https://idea2-h1.aegis-lab.internal:18443/agent
AUTH_AUDIENCE=https://idea2-h1.aegis-lab.internal:18443
TLS_VERIFY=REQUIRED
```

The gateway serves the browser at `/monitor/`. The Agent uses the separate
`/agent` base so the gateway can authorize only these externally visible paths:

- `/agent/internal/agent-auth/challenge`
- `/agent/internal/agent-auth/verify`
- `/agent/internal/heartbeat`
- `/agent/internal/detections`
- `/agent/internal/alerts`
- `/agent/internal/clips`

The gateway strips only the `/agent` prefix before proxying to the isolated
Monitor. That preserves the protocol-signed `/internal/...` route seen by the
Monitor. All other `/agent/internal/*` paths **DENY**. The route must be limited
to the approved Machine A network identity/source policy decided during N2;
the browser-facing `/monitor/internal/*` surface remains denied. The Production
gateway remains unchanged.

The Monitor receives `AGENT_AUTH_AUDIENCE` equal to the exact `AUTH_AUDIENCE`.
The Agent receives that same origin as `AEGIS_AGENT_AUTH_AUDIENCE`, while
`AEGIS_AGENT_MONITOR_BASE_URL` receives the `/agent` base. A path-bearing base
URL and a path-free audience therefore cannot be confused.

## TLS certificate and managed CA-bundle prerequisite

The candidate leaf certificate is issued for
`idea2-h1.aegis-lab.internal` by an owner-reviewed non-Production/private CA.
Issuance is outside this repository-only checkpoint. The CA private key never
enters the repository, Compose project, Monitor, Machine A Agent configuration,
logs, or evidence.

```text
CA_BUNDLE_IMPLEMENTATION=NOT_IMPLEMENTED
AEGIS_AGENT_CA_BUNDLE=REQUIRED_BEFORE_N8
REQUESTS_CA_BUNDLE=FORBIDDEN_UNMANAGED_INPUT
verify=False=FORBIDDEN
PRIVATE_CA_KEY_ALLOWED=NO
```

The browser may trust the public CA certificate through the reviewed Windows
platform trust store, but that alone does not prove Python Requests trust:
the pinned Agent runtime uses Requests with Certifi. Before live N2/N8, a
separate bounded TDD change must add `AEGIS_AGENT_CA_BUNDLE` to the managed
Agent configuration and lifecycle:

1. Accept only an absolute regular-file path under the managed Agent
   configuration root; reject symlinks/reparse points and writable-by-untrusted
   ACLs.
2. Parse a public PEM CA certificate/bundle, reject private-key material,
   malformed/empty data, non-CA certificates, missing files, and out-of-scope
   paths.
3. Pass the reviewed bundle explicitly through the Agent's actual
   `requests.Session` verification path for challenge, verify, heartbeat,
   detection, alert, and clip requests.
4. Keep certificate verification mandatory. No HTTP fallback, global trust
   bypass, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, or `verify=False`.
5. Extend install, status, repair, and uninstall behavior so the public bundle
   is copied/attested/removed predictably without touching the protected
   Ed25519 key.
6. Prove valid-chain success plus missing, malformed, untrusted, wrong-host,
   expired, private-key-containing, reparse-point, and ACL-negative cases.

N8 remains blocked until the CA-bundle lifecycle is implemented and verified
against the Agent's real Python Requests trust path. This design does not claim
that capability exists today.

## Identity, account, and camera authority

```text
NODE_ID=OWNER_APPROVED_AFTER_REGISTRY_ENUMERATION
KEY_VERSION=1_ONLY_FOR_CONFIRMED_FRESH_NODE
PHYSICAL_CAMERA_ID=SERVER_GENERATED
operator -> CAM-01
operator2 -> CAM-02
```

N5 starts with a read-only `manage_nodes.py list` in the isolated registry. The
Human Owner then selects one canonical Node ID matching the existing validator;
the runbook never manufactures or hardcodes a live Machine A identity. Key
version `1` is allowed only when the exact Node is absent and registration is
confirmed fresh. Existing identities require a separately reviewed rotation or
continuation decision.

`operator` and `operator2` are created with `manage_users.py` using interactive,
out-of-band passwords and mandatory reset. `--password`, legacy/default seed
credentials, shell history, and repository credentials are forbidden. The lab
creates the logical camera catalog without importing Production rows.

`manage_nodes.py register --alias-mode account` creates the globally unique
physical-camera identity server-side. Reconciliation then maps `operator` to
CAM-01 and `operator2` to CAM-02. Both aliases use the same Machine A physical
camera. Switching accounts changes only the logical alias.

## Stream and reverse-tunnel authority

```text
AEGIS_MONITOR_STREAM_HOST=idea2-h1-stream.aegis-lab.internal
MACHINE_A_REVERSE_PORT=18077_CONDITIONAL_ON_N0
DIAGNOSTIC_PORT_18078=FORBIDDEN
```

The Monitor resolves the candidate stream hostname through a deployment-owned
container host mapping to the exact reviewed, non-loopback server IPv4. The
reverse SSH listener binds that same explicit IPv4. Wildcard, loopback, Docker
bridge-IP, browser-supplied, heartbeat-supplied, username-derived, and
hostname-derived authority is forbidden.

Port 18077 is acceptable for Machine A only after N0 proves that the exact
address/port tuple is unoccupied and unreserved. Otherwise the Human Owner must
select a different explicit port and update every reviewed handoff value before
H1-1; reusable source receives no default.

`AEGIS_TRUSTED_PHYSICAL_STREAM_SOURCES` is generated only **after the
physical-camera registration is known**. Its single H1 entry is keyed by the
server-generated physical-camera ID and contains the approved Node ID plus
`http://idea2-h1-stream.aegis-lab.internal:<approved-port>/stream.mjpg`.
The browser and heartbeat cannot select or override the physical stream
destination.

## H1 handoff record

N7 must produce a redacted, owner-reviewed handoff containing values, origins,
and public fingerprints only—never passwords, database URLs, tokens, private
keys, cookies, certificate private keys, or environment-file contents:

| H1 value | Source of authority | Before N8 |
|---|---|---|
| `AEGIS_AGENT_MONITOR_BASE_URL` | N3 gateway | exact candidate `/agent` HTTPS URL |
| `AEGIS_AGENT_AUTH_AUDIENCE` | N3 Monitor + Agent contract | exact candidate HTTPS origin |
| `AEGIS_AGENT_NODE_ID` | N5 owner decision | approved after registry enumeration |
| `AEGIS_AGENT_KEY_VERSION` | N5 registry decision | `1` only for confirmed fresh Node |
| `AEGIS_IDENTITY_BROWSER_ALLOWED_ORIGINS` | N3 browser gateway | exact candidate HTTPS origin |
| `AEGIS_AGENT_CA_BUNDLE` | separate CA lifecycle prerequisite | managed public bundle path, verified |
| Monitor stream host | N6 deployment mapping | candidate stream hostname |
| reverse bind and port | N0/N6 owner decision | explicit IPv4 and collision-free port |
| trusted source mapping | N5/N6 server authority | generated physical ID + approved Node/URL |

The existing Machine A values `http://127.0.0.1:18002` and
`http://172.18.0.1:18077/stream.mjpg` are discovery evidence only. They must not
be copied into Agent, Engine, tunnel, or Monitor H1 configuration.

## Provisioning and acceptance gates

Every phase is fail-closed. A failed phase stops the sequence; it never triggers
automatic cleanup that could erase diagnostic evidence or touch Production.

### N0 — Read-only host and Production collision preflight

**Prerequisite:** Human approval for read-only inspection of the selected host;
current Production identity and `aegis-prod` boundaries are known.

**Mutation scope:** None. Inspect Compose projects, containers, networks,
volumes, listener tuples, disk/memory, DNS resolution, host routes, SSH bind
policy, candidate image references, and exact Production resource names.

**Expected result:** No `aegis-h1-lab` resource exists; the explicit candidate
IPv4/18443 and IPv4/18077 tuples are free; capacity is sufficient; no lab name,
network, volume, database, or path collides with Production.

**Abort conditions:** Unknown resources, insufficient capacity, wildcard-only
binding, occupied/reserved ports, inability to enumerate Production boundaries,
or any command that would mutate Docker, firewall, DNS, TLS, SSH, Twingate, or
Production.

**Rollback:** None; read-only.

**Evidence:** Redacted project/resource lists, listener owners, capacity totals,
candidate bind IPv4, port classifications, and `N0=PASS|BLOCKED`.

### N1 — Create isolated PostgreSQL and Monitor runtime

**Prerequisite:** N0 PASS; exact Compose file/image digests and lab-only secret
delivery mechanism reviewed; separate authorization granted.

**Mutation scope:** Create only the `aegis-h1-lab` project networks, lab
PostgreSQL volume/database/role, isolated Monitor, and stopped/not-yet-exposed
gateway. Apply Monitor schema and migrations only to the lab database.

**Expected result:** Lab PostgreSQL and Monitor become healthy on project
networks; neither publishes a host port; schema/migrations apply twice with
stable results; no Production resource changes.

**Abort conditions:** Any resolved Production database/volume/network, project
name drift, host port publication, migration instability, credential reuse,
health failure, or image mismatch.

**Rollback:** Stop/remove only project `aegis-h1-lab`, then remove only its
reviewed project-scoped networks and PostgreSQL volume after evidence review.

**Evidence:** Compose project/resource names, immutable image IDs, database name
without credentials, migration counts, health results, and before/after
Production resource hashes/counts.

### N2 — Establish candidate HTTPS DNS and trust

**Prerequisite:** N1 PASS; candidate DNS, explicit IPv4/18443, private CA
issuance, Machine A platform trust, and managed Agent CA-bundle lifecycle all
approved and implemented.

**Mutation scope:** Create only the candidate DNS record, candidate leaf
certificate/key on the lab gateway, browser public-CA trust, and managed public
Agent CA bundle. Never copy the CA private key.

**Expected result:** Browser and Agent Python Requests validate the candidate
hostname/chain with TLS verification enabled; wrong host, wrong CA, expired
certificate, and absent bundle fail closed.

**Abort conditions:** CA-bundle feature not implemented, certificate/SAN
mismatch, private key exposure, trust-store ambiguity, HTTP fallback,
`verify=False`, unmanaged trust variables, or any Production certificate/file
mutation.

**Rollback:** Remove only the candidate DNS record, lab leaf material, and
task-specific public trust entries/bundle after confirming no other consumer;
preserve unrelated/shared trust.

**Evidence:** Public certificate fingerprint/SAN/expiry, CA public fingerprint,
browser validation, Python Requests positive/negative results, listener tuple,
and `N2=PASS|BLOCKED` without PEM/key contents.

### N3 — Validate browser and Agent gateway routes

**Prerequisite:** N2 PASS; isolated Monitor healthy with the canonical audience;
exact route configuration reviewed.

**Mutation scope:** Start only the lab gateway on the approved IPv4/18443.

**Expected result:** `/monitor/` serves the lab browser; the six exact Agent
paths proxy to the lab Monitor; prefix rewriting preserves Monitor
`/internal/...`; every other `/agent/internal/*` and browser
`/monitor/internal/*` request is denied; Production gateway remains unchanged.

**Abort conditions:** Wildcard bind, arbitrary internal-route exposure,
Production upstream resolution, incorrect forwarded host/proto, route case
bypass, audience drift, or browser/Agent traffic reaching different Monitors.

**Rollback:** Stop/remove only the lab gateway and its candidate listener;
retain N1 data for diagnosis unless separately approved for cleanup.

**Evidence:** Exact status matrix for allowed and denied routes, upstream
container identity, forwarded origin/audience, listener owner, and Production
gateway hash/state.

### N4 — Seed logical cameras and operator fixtures

**Prerequisite:** N3 PASS; clean lab database; reviewed CLI environment with the
lab `DATABASE_URL` provided out-of-band.

**Mutation scope:** Create lab-only CAM-01/CAM-02 logical catalog rows and create
exactly `operator` and `operator2` through `manage_users.py` with interactive
out-of-band passwords and mandatory reset.

**Expected result:** Both active CCTV-Operator accounts exist only in the lab;
no plaintext password is logged/stored; CAM-01/CAM-02 exist as logical aliases,
not physical identities.

**Abort conditions:** Legacy/default/CLI-argument passwords, Production URL,
unexpected existing users, wrong role, force-reset bypass, imported Production
rows, or password/DB URL appearing in output.

**Rollback:** Disable/delete only the two lab fixture accounts and their lab
assignments/catalog rows using reviewed lab-only commands; never affect a Node
or Production account.

**Evidence:** Redacted `list-operators` and `list-cameras`, roles/active/reset
flags, row counts, and secret scan of captured output.

### N5 — Establish registry readiness

**Prerequisite:** N4 PASS; owner present to review `manage_nodes.py list`; no
private key has crossed Machine A.

**Mutation scope:** After owner selection, register one fresh lab Node using
only the Machine A public-key export, server-generate one physical camera,
reconcile `operator=CAM-01` and `operator2=CAM-02`, and set
`ed25519_required` in the lab registry.

**Expected result:** One active Node, one generated physical camera, one
account-mode policy, two logical aliases on that same physical camera, and key
version matching the protected Machine A identity.

**Abort conditions:** Unexpected Node exists, key version is guessed, public
fingerprint mismatch, private material appears, separate physical cameras per
account, inactive/wrong-role account, dry-run mismatch, or Production database.

**Rollback:** Disable the exact lab Node by default. Destructive identity or key
removal remains a separately authorized operation.

**Evidence:** Redacted before/after list, chosen Node ID, key version, public
fingerprint, generated physical-camera ID, alias dry-run/apply result, and auth
mode. No public/private key contents.

### N6 — Establish stream and reverse-port readiness

**Prerequisite:** N5 PASS; N0 port result still fresh; exact host IPv4, SSH host
key, tunnel identity path, and candidate stream hostname approved.

**Mutation scope:** Create only the lab container host mapping and exact
physical-ID trusted-source entry; under separate Machine A authorization,
establish the reviewed reverse listener on the exact IPv4/port. Do not start
camera demand.

**Expected result:** Monitor resolves the candidate stream hostname to the
reviewed host interface; trusted source matches generated physical ID + Node;
reverse listener is uniquely owned; idle Engine remains camera OFF.

**Abort conditions:** Port collision, wildcard/loopback/Docker-IP bind,
host-mapping drift, heartbeat/browser override, wrong Node/physical ID, strict
host-key failure, use of `:18078`, or camera demand/open.

**Rollback:** Stop only the lab reverse tunnel/listener and remove only the lab
trusted-source/host mapping. Preserve protected identities and Production.

**Evidence:** Redacted DNS/host mapping, exact bind tuple/owner, trusted-source
validator PASS, Engine idle state, viewer/demand counts zero, and camera OFF.

### N7 — Independent non-Production acceptance

**Prerequisite:** N0-N6 PASS with fresh evidence; no Production or Machine A
configuration drift outside the separately approved N2/N5/N6 actions.

**Mutation scope:** Lab sessions and disposable demand only. Exercise Agent
auth/renewal, heartbeat/ingest provenance, browser association, operator CAM-01,
release, operator2 CAM-02, final release, failure/expiry, and cleanup paths.

**Expected result:** Both accounts resolve the same Machine A physical camera;
active demand opens it; final release closes it; SOC stays passive; Agent/auth/
heartbeat create no demand; wrong Node/account/source/CA paths fail closed.

**Abort conditions:** Any Production endpoint/row, physical identity changes on
account switch, passive wake, stale demand, stream override, key exposure,
unbounded retry, camera left open, or incomplete rollback evidence.

**Rollback:** Release all lab demands, stop Agent/tunnel components involved in
the authorized trial, confirm camera OFF, then retain or remove the lab using
the reviewed N1/N2 cleanup sequence.

**Evidence:** Redacted authentication/provenance matrix, physical-ID/alias
matrix, demand/reference counts, camera OFF/ON/OFF observations, route/CA
negative tests, resource diffs, and `N7=PASS|BLOCKED`.

### N8 — Authorize Machine A H1

**Prerequisite:** N0-N7 PASS; CA-bundle implementation and real Requests-path
verification PASS; handoff values reviewed; rollback owner present.

**Mutation scope:** None in this phase. Human/ChatGPT decides whether to issue a
separate bounded authorization for H1-1 only.

**Expected result:** One redacted H1 handoff records exact approved values and
evidence SHAs. H1 remains `NOT_STARTED` until explicit authorization.

**Abort conditions:** Any stale/missing gate, unresolved CA bundle, candidate
value treated as live without evidence, Production dependency, secret exposure,
or incomplete rollback.

**Rollback:** None; decision gate. Revoke the handoff if any prerequisite
changes before H1-1.

**Evidence:** N0-N7 matrix, CA-bundle source/test checkpoint, exact redacted H1
values, current branch/source SHA, reviewer decisions, and
`H1_AUTHORIZED=YES|NO`.

N8 is blocked until the CA-bundle prerequisite and every earlier phase pass.

## Cleanup and rollback boundary

The lab cleanup command set must always name `aegis-h1-lab` and the exact lab
Compose file. Broad Docker prune, volume prune, network prune, system reset,
Production Compose commands, filesystem globs, and shared trust deletion are
forbidden. Cleanup order is: release demands and prove camera OFF; stop Agent
trial/tunnel if authorized; stop gateway/Monitor/PostgreSQL; capture evidence;
remove project containers/networks; remove the exact lab PostgreSQL volume;
remove candidate DNS/leaf/trust only when no other consumer exists; verify
Production resource identity and health unchanged.

## Design outcome

This design makes co-location technically plausible but does not prove it.
No dedicated host is required unless N0 fails isolation/capacity/routing or the
responsible infrastructure owner rejects co-location. H0 is human-proven
complete. H1 remains blocked on this unprovisioned environment, the managed
CA-bundle source prerequisite, and N0-N7 live evidence.
