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
N0_CAPACITY_CRITERION=NOT_DEFINED
N0_CAPACITY=NOT_PROVEN
N0_STATE=BLOCKED_CAPACITY_CHARACTERIZATION
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
CA_BUNDLE_IMPLEMENTATION=IMPLEMENTED_SOURCE_ONLY
CA_BUNDLE_MANAGED_LOCATION=%ProgramData%\AEGIS\IdentityAgentConfiguration\agent-ca-bundle.pem
AEGIS_AGENT_CA_BUNDLE=REQUIRED_BEFORE_N8
REQUESTS_CA_BUNDLE=FORBIDDEN_UNMANAGED_INPUT
verify=False=FORBIDDEN
PRIVATE_CA_KEY_ALLOWED=NO
H1_STATE=BLOCKED_PREREQUISITES
N0_STATE=BLOCKED_CAPACITY_CHARACTERIZATION
```

The browser may trust the public CA certificate through the reviewed Windows
platform trust store, but that alone does not prove Python Requests trust:
the pinned Agent runtime uses Requests with Certifi. The bounded repository
implementation now adds `AEGIS_AGENT_CA_BUNDLE` to the managed Agent
configuration and lifecycle:

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

The source implementation is verified with disposable test certificates through
the Agent's real Python Requests trust path. This is not evidence that any live
H1 CA, leaf certificate, DNS name, gateway, service, or Machine A runtime exists.
N8 remains blocked until N0-N7 pass, the reviewed public H1 CA bundle is installed
at the exact managed path, and the live non-Production TLS path is verified.

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
PRESERVE_EXISTING_FORWARD=172.18.0.1:18077
CANDIDATE_REVERSE_TUPLE=192.168.10.10:18077_AVAILABLE
CANDIDATE_HTTPS_TUPLE=192.168.10.10:18443_AVAILABLE
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
IPv4/18443 and IPv4/18077 tuples are free; the capacity rule below is fully
defined and satisfied; no lab name, network, volume, database, or path collides
with Production.

**Abort conditions:** Unknown resources; any undefined or unsatisfied capacity
term; wildcard-only binding; occupied/reserved ports; inability to enumerate
Production boundaries; or any command that would mutate Docker, firewall, DNS,
TLS, SSH, Twingate, or Production. N1 must not start while N0 capacity is
`NOT_PROVEN`.

**Rollback:** None; read-only.

**Evidence:** Redacted project/resource lists, listener owners, capacity totals,
the characterized capacity terms below, candidate bind IPv4, port
classifications, and `N0=PASS|BLOCKED`.

#### N0 capacity criterion reconciliation

The repository currently supplies no resource limits for the future H1
gateway/Monitor/PostgreSQL Compose project, no exact candidate image or writable
layer sizes, no bounded PostgreSQL retention/growth policy, and no quantified
rollback/evidence retention requirement. The root development Compose stack is
not an H1 sizing proxy: it also contains Drive and Detection Engine services and
has different exposure, storage, and lifecycle behavior. Consequently, using a
generic free-space percentage or a guessed RAM threshold would not be derived
from the approved runtime.

```text
N0_CAPACITY_CRITERION=NOT_DEFINED
N0_CAPACITY=NOT_PROVEN
N0_STATE=BLOCKED_CAPACITY_CHARACTERIZATION
DISK_HEADROOM_CRITERION=NOT_DEFINED
RAM_HEADROOM_CRITERION=NOT_DEFINED
POSTGRES_GROWTH_ALLOWANCE=NOT_DEFINED
IMAGE_CONTAINER_OVERHEAD=NOT_MEASURED
ROLLBACK_EVIDENCE_HEADROOM=NOT_DEFINED

CURRENT_ROOT_TOTAL=57_GiB_REPORTED
CURRENT_ROOT_USED=47_GiB_REPORTED
CURRENT_ROOT_AVAILABLE=7.3_GiB
CURRENT_ROOT_USE_PERCENT=87_PERCENT_REPORTED
CURRENT_RAM_TOTAL=7.0_GiB_REPORTED
CURRENT_RAM_AVAILABLE_APPROX=5.4_GiB
CURRENT_SWAP_TOTAL=4.0_GiB_REPORTED
CURRENT_SWAP_FREE=2.7_GiB_REPORTED
CURRENT_DOCKER_IMAGES_TOTAL=4.846_GB_REPORTED
CURRENT_DOCKER_VOLUMES_TOTAL=31.13_GB_REPORTED
DOCKER_CLEANUP_OR_PRUNE_PERFORMED=NO
```

These measurements prove only the observed host state. They do not prove
sufficiency. Docker image, volume, build-cache, or other data must not be pruned
to manufacture a PASS. No Docker prune is authorized by this reconciliation.

##### Candidate artifact inventory

Repository inspection identifies the proposed N1 components but not a runnable,
immutable H1 candidate:

```text
CAPACITY_INPUT_FREEZE_SOURCE_SHA=9e39fe5786a5ac7428d2e5eb47cb2285a63bc606
MONITOR_BUILD_CONTEXT=IDEA2-AEGIS_Monitor
MONITOR_DOCKERFILE=IDEA2-AEGIS_Monitor/Dockerfile
MONITOR_BASE_IMAGE=node:20-alpine
MONITOR_RUNTIME_BASE=node:20-alpine_UNPINNED
MONITOR_BASE_IMAGE_DIGESTS=REQUIRES_FUTURE_READONLY_REGISTRY_RESOLUTION
MONITOR_IMMUTABLE_IMAGE_ID=NOT_SELECTED

POSTGRES_IMAGE_TAG=postgres:15-alpine
POSTGRES_REPO_DIGEST=NOT_PINNED
POSTGRES_DIGEST=REQUIRES_FUTURE_READONLY_OR_PROBE_RESOLUTION

H1_GATEWAY_REFERENCE_SOURCE=gateway/Dockerfile_AND_gateway/nginx.conf_DEV_HTTP_ONLY
H1_GATEWAY_ARTIFACT=NOT_IMPLEMENTED
GATEWAY_IMPLEMENTATION_REQUIRED=YES
H1_COMPOSE_ARTIFACT=NOT_IMPLEMENTED
ACTIVE_CAPACITY_PROBE_READY=NO
```

The existing Monitor multi-stage Dockerfile is the build source for the future
candidate. Its runtime source is frozen at the commit above, its exact
Dockerfile and context are fixed, and both build stages currently name the same
mutable `node:20-alpine` tag. The repository contains neither the OCI index
digest nor the Linux/amd64 child-manifest digest, so both must be resolved and
reviewed through a future read-only registry-metadata step before a build is
authorized. The PostgreSQL tag matches current repository definitions but is
also mutable; the repository contains neither its OCI index digest nor its
Linux/amd64 child-manifest digest. No tag is accepted as immutable authority.

The root gateway builds the general HUB and uses an HTTP development nginx
configuration. It lacks the H1 candidate TLS and exact Agent route boundary,
so it is reference source only and must not be reused or mislabeled as the H1
gateway artifact. The smallest acceptable future H1-only gateway artifact is a
dedicated, digest-pinned nginx image and configuration that:

- contains no HUB build and joins only the probe/lab ingress network;
- accepts TLS only, with the reviewed public certificate chain and private key
  supplied at runtime outside the image and repository;
- proxies `/monitor/` to the isolated Monitor while denying
  `/monitor/internal` case-insensitively;
- permits only the six approved exact `/agent/internal/...` routes, strips only
  the `/agent` prefix, and denies every other Agent route;
- publishes no host port during characterization and never joins Production;
  and
- uses bounded logs and request/proxy limits without disabling TLS validation.

That dedicated Dockerfile/configuration and its pinned nginx digest are not
implemented. The gateway must be implemented, contract-tested, and reviewed
before the capacity probe can be authorized because gateway image bytes,
writable-layer demand, and peak RSS are required formula inputs.

The approved logical N1 resource model remains:

- Compose project `aegis-h1-lab` with services `gateway`, `monitor`, and
  `postgres`;
- one project-scoped ingress network and one project-scoped internal backend
  network, with no Production network membership;
- one project-scoped `postgres_data` volume and no Production volume reuse;
- writable layers for all three containers, with PostgreSQL durable data kept
  in its named volume and no direct host port for Monitor or PostgreSQL;
- a stopped/not-yet-exposed gateway during N1; and
- redacted command output, image identity, resource inventory, migration, and
  rollback evidence retained outside secrets.

Because the H1 Compose and gateway artifacts are not implemented and immutable
image IDs are not selected, their candidate image bytes, initialized database
bytes, writable-layer peak, and lab peak RSS are
`NOT_MEASURABLE_READ_ONLY` today.

##### Owner-run read-only host measurements

These commands are inspection-only. Run them on `aegis-system` from a shell
that can read Docker state. They do not pull, build, start, stop, recreate, or
prune anything. They intentionally format only identity/resource fields and do
not print container environment variables or credentials. Every Production
measurement is `REFERENCE_ONLY`; it is not an H1 sizing result.

```sh
# Exact Production container and image identities (REFERENCE_ONLY).
docker ps --filter label=com.docker.compose.project=aegis-prod \
  --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Label "com.docker.compose.service"}}'

for service in monitor postgres; do
  ids="$(docker ps -q \
    --filter label=com.docker.compose.project=aegis-prod \
    --filter label=com.docker.compose.service="$service")"
  test "$(printf '%s\n' "$ids" | sed '/^$/d' | wc -l)" -eq 1 || {
    echo "ABORT_${service}_CONTAINER_CARDINALITY" >&2
    exit 1
  }
  image_id="$(docker inspect --format '{{.Image}}' "$ids")"
  docker image inspect --format \
    '{{.Id}}\t{{json .RepoTags}}\t{{json .RepoDigests}}\t{{.Size}}' "$image_id"
done

# Registry-compressed manifest/layer sizes. Use only an exact RepoDigest copied
# from the preceding output; if no RepoDigest exists or registry metadata access
# is not approved, record COMPRESSED_BYTES=NOT_MEASURABLE_READ_ONLY.
DIGEST_REF='<exact-repository@sha256:digest-from-image-inspect>'
case "$DIGEST_REF" in
  *@sha256:*) docker manifest inspect --verbose "$DIGEST_REF" ;;
  *) echo 'ABORT_EXACT_REPODIGEST_REQUIRED' >&2; exit 1 ;;
esac

# Current comparable workload memory and configured limits (REFERENCE_ONLY).
MONITOR_ID="$(docker ps -q \
  --filter label=com.docker.compose.project=aegis-prod \
  --filter label=com.docker.compose.service=monitor)"
POSTGRES_ID="$(docker ps -q \
  --filter label=com.docker.compose.project=aegis-prod \
  --filter label=com.docker.compose.service=postgres)"
test "$(printf '%s\n' "$MONITOR_ID" | sed '/^$/d' | wc -l)" -eq 1 || exit 1
test "$(printf '%s\n' "$POSTGRES_ID" | sed '/^$/d' | wc -l)" -eq 1 || exit 1
docker stats --no-stream \
  --format '{{.ID}}\t{{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.PIDs}}' \
  "$MONITOR_ID" "$POSTGRES_ID"
docker inspect --format \
  '{{.Name}}\tmemory={{.HostConfig.Memory}}\tmemory_reservation={{.HostConfig.MemoryReservation}}\tmemory_swap={{.HostConfig.MemorySwap}}\tpids_limit={{.HostConfig.PidsLimit}}' \
  "$MONITOR_ID" "$POSTGRES_ID"

# Production PostgreSQL volume bytes (REFERENCE_ONLY; read-only filesystem walk).
PG_VOLUME="$(docker volume ls -q \
  --filter label=com.docker.compose.project=aegis-prod \
  --filter label=com.docker.compose.volume=postgres_data)"
test "$(printf '%s\n' "$PG_VOLUME" | sed '/^$/d' | wc -l)" -eq 1 || {
  echo 'ABORT_POSTGRES_VOLUME_CARDINALITY' >&2
  exit 1
}
docker volume inspect --format '{{.Name}}\t{{.Driver}}\t{{.Mountpoint}}' "$PG_VOLUME"
PG_MOUNT="$(docker volume inspect --format '{{.Mountpoint}}' "$PG_VOLUME")"
sudo du -sb --one-file-system "$PG_MOUNT"

# Current Monitor writable layer and root filesystem bytes (REFERENCE_ONLY).
docker inspect --size --format \
  '{{.Name}}\twritable={{.SizeRw}}\trootfs={{.SizeRootFs}}' "$MONITOR_ID"

# Host byte and inode headroom.
df -B1 --output=source,size,used,avail,pcent,target /
df -i --output=source,itotal,iused,iavail,ipcent,target /

# Docker totals and builder-cache inventory; no prune.
docker system df -v
docker builder du

# Host memory/swap pressure. Swap is observed but never counted as required RAM.
free -b
vmstat 1 5
cat /proc/pressure/memory
swapon --show --bytes
```

Read-only measurable values are therefore: host filesystem bytes/inodes;
current Docker image IDs, local unpacked sizes, RepoDigests where present,
shared/unique image and volume totals, and builder cache; current Production
Monitor/PostgreSQL RSS and configured limits; current Production PostgreSQL
volume bytes; current Production Monitor writable-layer bytes; and current host
memory/swap pressure. Local compressed layer bytes require an exact RepoDigest
and read-only registry manifest access; they are not inferable from
`docker image inspect .Size`.

Production measurements are useful only to expose order of magnitude and
missing limits. They remain `REFERENCE_ONLY` because Production workload,
dataset age, configuration, image build, and concurrency are not the H1 lab.

##### Owner decision options for the bounded probe

The repository does not contain a retention policy, normal-load variation
sample, or evidence manifest from which fixed GiB/MiB values could be derived.
Therefore the options below are measurement-derived formulas, not guessed
thresholds. The owner selects one option in each row only after its named input
is measured. `MINIMUM` means one bounded acceptance cycle; `CONSERVATIVE`
retains room for one failed cycle followed by one clean rerun.

| Decision | Minimum defensible option | Conservative option | Effect on current host evidence |
|---|---|---|---|
| PostgreSQL growth | `POSTGRES_GROWTH_MINIMUM_OPTION = max(POSTGRES_INITIAL_VOLUME_BYTES, CHARACTERIZED_ACCEPTANCE_DB_DELTA_BYTES)` | `POSTGRES_GROWTH_CONSERVATIVE_OPTION = max(2 * POSTGRES_INITIAL_VOLUME_BYTES, 2 * CHARACTERIZED_ACCEPTANCE_DB_DELTA_BYTES)` | The current `7.3 GiB` disk headroom becomes `7.3 GiB - POSTGRES_GROWTH_* - every other DISK_REQUIRED_BYTES term`; numeric fit is not proven. |
| Host RAM reserve | `HOST_RAM_RESERVE_MINIMUM_OPTION = MEASURED_NONLAB_PEAK_RSS_DELTA_BYTES` | `HOST_RAM_RESERVE_CONSERVATIVE_OPTION = 2 * MEASURED_NONLAB_PEAK_RSS_DELTA_BYTES` | The current approximately `5.4 GiB` available RAM leaves `5.4 GiB - HOST_RAM_RESERVE_*` for characterized lab ceilings; zero/unmeasured delta is invalid. |
| Disk safety reserve | `DISK_SAFETY_RESERVE_MINIMUM_OPTION = max(CANDIDATE_BUILD_TRANSIENT_BYTES, ROLLBACK_ARTIFACT_BYTES)` | `DISK_SAFETY_RESERVE_CONSERVATIVE_OPTION = CANDIDATE_BUILD_TRANSIENT_BYTES + ROLLBACK_ARTIFACT_BYTES` | Subtracted from the same `7.3 GiB` together with images, PostgreSQL, writable layers, and evidence. If the remainder is not positive, the probe stays blocked. |
| Evidence/log cap | `EVIDENCE_LOG_CAP_MINIMUM_OPTION = ONE_COMPLETE_REDACTED_PROBE_EVIDENCE_SET_BYTES` | `EVIDENCE_LOG_CAP_CONSERVATIVE_OPTION = 2 * ONE_COMPLETE_REDACTED_PROBE_EVIDENCE_SET_BYTES` | Subtracted from `7.3 GiB`; the conservative option retains one failed and one successful redacted evidence set. |

`CHARACTERIZED_ACCEPTANCE_DB_DELTA_BYTES` includes PostgreSQL data, indexes,
and WAL peak observed for the bounded synthetic N1-N7-equivalent database
workload. `MEASURED_NONLAB_PEAK_RSS_DELTA_BYTES` is the largest normal-load
increase in non-lab resident memory during an owner-approved read-only
observation window. `ONE_COMPLETE_REDACTED_PROBE_EVIDENCE_SET_BYTES` is the sum
of explicit per-file byte caps for preflight, workload, cleanup, and final
verification outputs; raw environment, credentials, keys, tokens, and database
URLs remain forbidden.

No option is selected by this checkpoint. The current `7.3 GiB` disk and
approximately `5.4 GiB` available RAM therefore remain observations, not proof
that either minimum or conservative policy fits.

##### Required capacity terms and owner decisions

Before N0 can be re-evaluated, a separately approved, non-Production capacity
characterization must record all of these byte-valued measurements for the
exact reviewed H1 candidate and workload:

- `CANDIDATE_IMAGE_UNIQUE_BYTES`: additional on-host image bytes needed after
  accounting for layers already present, using the immutable candidate image
  IDs selected for N1.
- `CANDIDATE_WRITABLE_LAYER_PEAK_BYTES`: peak combined writable-layer and
  bounded container-log bytes for gateway, Monitor, and PostgreSQL during the
  N1-N7 acceptance workload.
- `POSTGRES_INITIAL_VOLUME_BYTES`: initialized lab database bytes after schema,
  migrations, logical-camera fixtures, users, and one registered Node.
- `POSTGRES_APPROVED_GROWTH_BYTES`: Human Owner-approved maximum additional lab
  database growth for the bounded N1-N7 retention/workload. Schema shape alone
  cannot supply this policy value.
- `ROLLBACK_ARTIFACT_BYTES`: bytes that must coexist for the prior/candidate
  image set and exact rollback artifacts; reclaimable Docker cache is not
  counted as available capacity.
- `EVIDENCE_LOG_ALLOWANCE_BYTES`: approved bound for redacted logs, exported
  evidence, and temporary verification artifacts retained through rollback.
- `LAB_PEAK_RSS_BYTES`: measured peak resident memory of the exact concurrent
  gateway, Monitor, and PostgreSQL candidate under the N1-N7 acceptance load,
  together with host available-memory and swap-pressure observations over the
  same interval.

- `CANDIDATE_BUILD_TRANSIENT_BYTES`: maximum additional build/pull/cache bytes
  that coexist while producing the exact candidate on this host, or zero when
  immutable candidate images are prepared elsewhere and only their measured
  unique local bytes are required.

The following values are policy decisions, not values the agent may select:

```text
POSTGRES_APPROVED_GROWTH_BYTES=OWNER_DECISION_REQUIRED
HOST_RAM_RESERVE_BYTES=OWNER_DECISION_REQUIRED
DISK_SAFETY_RESERVE_BYTES=OWNER_DECISION_REQUIRED
INODE_SAFETY_RESERVE_COUNT=OWNER_DECISION_REQUIRED
EVIDENCE_LOG_ALLOWANCE_BYTES=OWNER_DECISION_REQUIRED
```

The capacity formula is additive and avoids counting reclaimable cache or
shared image layers twice:

```text
DISK_REQUIRED_BYTES =
  CANDIDATE_IMAGE_UNIQUE_BYTES
  + CANDIDATE_BUILD_TRANSIENT_BYTES
  + POSTGRES_INITIAL_VOLUME_BYTES
  + POSTGRES_APPROVED_GROWTH_BYTES
  + CANDIDATE_WRITABLE_LAYER_PEAK_BYTES
  + ROLLBACK_ARTIFACT_BYTES
  + EVIDENCE_LOG_ALLOWANCE_BYTES
  + DISK_SAFETY_RESERVE_BYTES

RAM_REQUIRED_BYTES = LAB_PEAK_RSS_BYTES + HOST_RAM_RESERVE_BYTES

INODE_REQUIRED_COUNT = CHARACTERIZED_PEAK_NEW_INODES + INODE_SAFETY_RESERVE_COUNT

DISK_PASS = HOST_AVAILABLE_BYTES_AT_START >= DISK_REQUIRED_BYTES
RAM_PASS = HOST_MEM_AVAILABLE_BYTES_AT_START >= RAM_REQUIRED_BYTES
INODE_PASS = HOST_INODES_AVAILABLE_AT_START >= INODE_REQUIRED_COUNT
N0_CAPACITY_PASS = DISK_PASS AND RAM_PASS AND INODE_PASS
```

`ROLLBACK_ARTIFACT_BYTES` is the measured unique size of exact candidate/prior
images and configuration snapshots that must coexist until acceptance or
rollback. `EVIDENCE_LOG_ALLOWANCE_BYTES` is the owner-approved hard cap for
redacted logs and exported evidence. Neither includes Production images already
present or any private key, credential, database URL, token, cookie, or raw
environment dump. Swap is not added to `RAM_REQUIRED_BYTES`.

##### Separately authorized active characterization

The missing candidate values require an active probe, but that probe is not N1
and is not authorized by this document:

```text
BOUNDED_ACTIVE_CHARACTERIZATION_REQUIRED=YES
CAPACITY_PROBE_PROJECT=aegis-h1-capacity-probe
CAPACITY_PROBE_HOST_PORTS=NONE
CAPACITY_PROBE_PRODUCTION_NETWORKS=NONE
CAPACITY_PROBE_PRODUCTION_VOLUMES=NONE
CAPACITY_PROBE_MACHINE_A_TRAFFIC=NONE
CAPACITY_PROBE_COMPOSE_FILE=NOT_IMPLEMENTED
CAPACITY_PROBE_STORAGE_WATCHDOG=REQUIRED_NOT_IMPLEMENTED
N1_STARTED=NO
```

The smallest future probe first creates and reviews a dedicated
`deploy/idea2/h1-capacity-probe.compose.yml` plus immutable Monitor, PostgreSQL,
and H1 gateway references. It may then, under separate owner authorization:

1. inventory Docker/image/volume/cache and host byte/inode/RAM state;
2. require all owner-decision fields above plus an approved
   `CHARACTERIZATION_MAX_NEW_BYTES` and per-service memory ceilings;
3. refuse to pull/build/start unless available bytes exceed
   `CHARACTERIZATION_MAX_NEW_BYTES + DISK_SAFETY_RESERVE_BYTES`, available
   inodes exceed the approved inode reserve, and available RAM exceeds all
   service ceilings plus `HOST_RAM_RESERVE_BYTES`;
4. use only project `aegis-h1-capacity-probe`, a dedicated Buildx builder named
   `aegis-h1-capacity-builder`, internal probe networks, a disposable
   project-scoped PostgreSQL volume, synthetic bounded fixtures, and no host
   ports, Production credentials, Production networks/volumes, registry rows,
   DNS/TLS exposure, or Machine A traffic;
5. include a reviewed watchdog that polls filesystem bytes/inodes and host
   memory while building and exercising the bounded server-side workload. The
   watchdog must stop only the exact probe project and fail closed if it cannot
   collect a current measurement. If
   `HOST_AVAILABLE_BYTES <= DISK_SAFETY_RESERVE_BYTES`, abort and stop the exact
   probe. If `HOST_MEM_AVAILABLE_BYTES <= HOST_RAM_RESERVE_BYTES`, abort and
   stop the exact probe. Any OOM, swap-thrashing, storage-budget breach, log cap,
   or service memory-ceiling event is a blocked result, never a PASS; and
6. retain redacted measurements, then remove only the exact probe containers
   and networks, exact `aegis-h1-capacity-probe_postgres_data` volume, exact
   newly introduced candidate image IDs, and dedicated
   `aegis-h1-capacity-builder`. Shared/pre-existing images remain. Broad
   `system`, image, volume, network, builder, or BuildKit prune remains forbidden.

The probe is characterized, cleaned, and reviewed before the H1 Compose project
can exist. It cannot create `aegis-h1-lab`, publish `18443`/`18077`, initialize
the H1 registry, or satisfy N1. The probe remains blocked until its Compose
artifact and storage/RAM watchdog have focused tests and owner review; a manual
observer is not accepted as the required stop control.

Only after every term is quantified and all three formula checks pass may the
owner set `N0_CAPACITY=PASS`. The resulting measurements and owner decisions
must be added to this runbook and its contract test before `N0_STATE=PASS` is
permitted.

The other supplied N0 observations remain authoritative and do not relax this
capacity blocker:

```text
PRESERVE_EXISTING_FORWARD=172.18.0.1:18077
CANDIDATE_REVERSE_TUPLE=192.168.10.10:18077_AVAILABLE
CANDIDATE_HTTPS_TUPLE=192.168.10.10:18443_AVAILABLE
DIAGNOSTIC_PORT_18078=FORBIDDEN
LAB_SUBNET=172.31.244.0/29_NO_ROUTE_OR_DOCKER_COLLISION_REPORTED
LAB_RESOURCE_COLLISION=NONE_REPORTED
```

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
complete. H1 remains blocked on this unprovisioned environment, the undefined
N0 capacity criterion, and N0-N7 live evidence. The managed CA-bundle source
prerequisite is implemented and locally verified but still requires the live
reviewed non-Production trust path before N8.
