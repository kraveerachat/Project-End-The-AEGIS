# PUBLIC-SHARE-7 S5.4 Dedicated Gateway Networks — Implementation Plan

> **Task state:** CLOSED / PASS. Owner-run Production runtime acceptance
> completed; reconciled into repository governance. S5.5 remains NOT STARTED;
> G5/G6 remain OPEN; Public Share UI remains OFF; Internet exposure remains NONE.

**Area:** `idea1`

**Owner:** `kla`

**Branch:** `feat/idea1-public-share-s5-4-gateway-networks`

**Base:** `dc673992b4c474716c4a14d2d375b3c9dd583feb`

**Integration review:** required for the `gateway/**` runtime surface

**Production access in this repository closeout:** NONE (owner-run acceptance already completed)

## 1. Outcome and stop boundary

Prepare a reviewable Compose overlay for the S5.4 Production change:

```text
reserved cloudflared 172.31.240.3 (not deployed)
  → edge 172.31.240.0/29
  → gateway 172.31.240.2 + 172.31.241.2
  → upstream 172.31.241.0/29
  → Drive 172.31.241.3
```

Both S5.4 networks are internal bridges using Docker's isolated IPv4 gateway
mode. The gateway has no host-published port and joins only edge and upstream.
Drive retains its three existing private memberships and adds upstream. Drive
trust becomes exactly HUB `172.19.255.2/32` plus gateway
`172.31.241.2/32`. The gateway's managed-edge trust pins only the reserved
connector `172.31.240.3/32`.

The future egress subnet `172.31.242.0/29` is recorded as reserved only. It is
not declared as a Compose network and no `cloudflared` service exists. The
hostname `share.aegistk-pb.com` is configuration only: no DNS, TLS, tunnel,
listener, firewall rule, or Internet route is created. The UI remains off.

This document records the original implementation sequence, the owner-run
Production execution and defects corrected, and the accepted final internal runtime state.
S5.5, G5, G6, and public Internet exposure remain strictly outside S5.4.

## 2. Files and implementation sequence

1. Add `IDEA1-AEGIS_Drive_LC/tests/publicShareS54RuntimeContract.test.js` first.
   It must fail while the S5.4 overlay is absent and then pin every security and
   rollback invariant listed in section 3.
2. Add `gateway/public-share/production/docker-compose.s5-4.yml`. It overlays
   the existing Production Compose and the S5.3 Drive image-only override. It
   reuses the existing `gateway/public-share/` image source and creates no new
   share backend.
3. Add `gateway/public-share/production/README.md`. It records the three-file
   Compose order, exact image/source contract, service-scoped future rollout,
   fail-closed checks, and the exact S5.3 rollback. It must contain no whole-stack
   build or recreate command.
4. Update
   `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` to mark S5.4
   IN PROGRESS and retain the merged S5.3 result as historical evidence.
5. Do not create an S5.4 receipt while the PR is Draft and the task is still in
   progress. Do not alter any historical receipt.

## 3. Test-first contract

The focused S5.4 suite must prove:

- overlay identity and exact Compose layering order;
- edge `172.31.240.0/29` and upstream `172.31.241.0/29`;
- gateway edge `.2`, reserved connector `.3`, gateway upstream `.2`, Drive
  upstream `.3`;
- `internal: true` plus
  `com.docker.network.bridge.gateway_mode_ipv4: "isolated"` on both networks;
- no service `ports`, no host networking, and no default network;
- gateway membership is exactly edge + upstream;
- Drive adds upstream while retaining Compose logical memberships `aegis_internal`,
  `aegis_drive_proxy`, and `aegis_vlan10` (mapped to runtime network `aegis_vlan10_macvlan`)
  at their existing addresses;
- Drive trust is exactly
  `172.19.255.2/32,172.31.241.2/32`, gateway ingress identity is exactly
  `172.31.241.2/32`, base URL is exactly
  `https://share.aegistk-pb.com`, and UI is exactly `"false"`;
- no Cloudflare/provider range, broad subnet, Docker bridge range, LAN range,
  or `0.0.0.0/0` appears in Drive trust;
- gateway managed mode is `cloudflare` and its only trusted edge peer is
  `172.31.240.3/32`;
- no `cloudflared` service or egress network is declared;
- gateway is non-root, read-only, capability-free, no-new-privileges, has only
  a bounded noexec tmpfs, and receives no database/storage secret or mount;
- gateway source remains the already-reviewed nginx-only implementation;
- rollback selects the exact S5.3 override, restores HUB-only trust and the
  exact three private memberships, removes only the gateway and S5.4 networks,
  and uses service-scoped `--no-deps --no-build` operations;
- no whole-stack recreate, `down`, `prune`, published port, or public activation
  command is introduced.

Run the red gate before adding the overlay:

```bash
cd IDEA1-AEGIS_Drive_LC
node --test tests/publicShareS54RuntimeContract.test.js
```

Then run the green and regression gates:

```bash
cd IDEA1-AEGIS_Drive_LC
node --test tests/publicShareS54RuntimeContract.test.js
node --test tests/publicShareGatewayStructure.test.js
node --test tests/publicShareManagedTunnelIntegration.test.js
node --test tests/publicShareInternalIntegration.test.js
node --test tests/publicShareGatewayRuntime.test.js
node --test tests/publicShareSecurityRegression.test.js
node --test tests/publicShareConfig.test.js
node --test tests/trustedProxy.test.js
node --test tests/shareScopeTruthUi.test.js
npm test
npm run build
```

The Docker runtime tests remain opt-in and must report skipped unless their
explicit runtime flags are supplied. This repository-only checkpoint does not
set those flags or touch Production. The managed-edge structural test converts
only its temporary script/output arguments to POSIX separators on Windows so
Git for Windows `sh` executes the same validator contract as Linux.

## 4. Production sequence — executed by owner in S5.4 acceptance

The overlay was executed in this exact order by the owner following authorization
and pre-mutation verification:

1. Copy the reviewed overlay to
   `/opt/aegis/runtime/public-share/drive-gateway-s5-4.yml` and verify its SHA-256
   against the merged repository blob.
2. Build only the existing gateway source at tree
   `2025eb0873a4e7f8d3d2b00b02fc3dfca02b91df` as
   `aegis-public-share-gateway:public-share-50ce6e1638`. The gateway tree is
   byte-identical at source revision
   `50ce6e1638c6bcdb2a378a3cee660050b9cb41d8` and this task's base.
3. Validate the merged Compose model using exactly:

   ```bash
   sudo docker compose \
     --env-file /opt/aegis/Project-End-The-AEGIS/.env \
     --project-name aegis-prod \
     -f /opt/aegis/runtime/docker-compose.production.yml \
     -f /opt/aegis/runtime/public-share/drive-s5-3.yml \
     -f /opt/aegis/runtime/public-share/drive-gateway-s5-4.yml \
     config --quiet
   ```

4. Create only `aegis_public_share_edge` and
   `aegis_public_share_upstream` through the reviewed Compose model.
5. Recreate only Drive first:

   ```bash
   sudo docker compose \
     --env-file /opt/aegis/Project-End-The-AEGIS/.env \
     --project-name aegis-prod \
     -f /opt/aegis/runtime/docker-compose.production.yml \
     -f /opt/aegis/runtime/public-share/drive-s5-3.yml \
     -f /opt/aegis/runtime/public-share/drive-gateway-s5-4.yml \
     up -d --no-deps --no-build drive
   ```

6. Prove Drive health, exact four-network membership, exact proxy trust, private
   HUB/login/Files/share regression, and UI-off state.
7. Start only the gateway second:

   ```bash
   sudo docker compose \
     --env-file /opt/aegis/Project-End-The-AEGIS/.env \
     --project-name aegis-prod \
     -f /opt/aegis/runtime/docker-compose.production.yml \
     -f /opt/aegis/runtime/public-share/drive-s5-3.yml \
     -f /opt/aegis/runtime/public-share/drive-gateway-s5-4.yml \
     up -d --no-deps --no-build public-share-gateway
   ```

8. Test the gateway only from a temporary, explicitly approved member of the
   internal edge network; remove that test member immediately. No host listener
   and no Internet route may exist.

These commands reflect the exact sequence executed during owner-run Production
acceptance. Production Drive State B and dedicated Gateway are active on isolated
internal networks.

## 5. Exact rollback to the S5.3 private state

Rollback is gateway first, then Drive, reversing the rollout order:

```bash
sudo docker compose \
  --env-file /opt/aegis/Project-End-The-AEGIS/.env \
  --project-name aegis-prod \
  -f /opt/aegis/runtime/docker-compose.production.yml \
  -f /opt/aegis/runtime/public-share/drive-s5-3.yml \
  -f /opt/aegis/runtime/public-share/drive-gateway-s5-4.yml \
  rm -s -f public-share-gateway

sudo docker compose \
  --env-file /opt/aegis/Project-End-The-AEGIS/.env \
  --project-name aegis-prod \
  -f /opt/aegis/runtime/docker-compose.production.yml \
  -f /opt/aegis/runtime/public-share/drive-s5-3.yml \
  up -d --no-deps --no-build drive

sudo docker network rm aegis_public_share_edge aegis_public_share_upstream
```

The rollback acceptance state is:

- Drive image
  `sha256:04d2f81478fdb0d4284433cfd2d07197c9175d61425216565405a46f914766df`;
- S5.3 override
  `/opt/aegis/runtime/public-share/drive-s5-3.yml`, SHA-256
  `324fb5126b2f13f7b1c529ef1391131ef37f81acc8c3921b9b50f649b179de62`;
- memberships exactly `aegis_drive_proxy=172.19.255.3`,
  `aegis_internal=172.18.0.3`, and
  `aegis_vlan10_macvlan=192.168.10.11`;
- HUB-only `TRUSTED_PROXY_CIDRS=172.19.255.2/32`;
- no `PUBLIC_SHARE_GATEWAY_CIDR`;
- `PUBLIC_SHARE_UI_ENABLED=false`;
- gateway and both S5.4 networks absent;
- protected volumes and all unrelated services unchanged.

Network removal is permitted only after inspection proves no remaining member.
No Compose `down`, whole-stack `up`, rebuild, restart, or prune command belongs
to this plan.

## 6. Owner-run S5.4 read-only Production preflight — do not run in Codex

The owner runs this block in the visible `admin-main@aegis-system` SSH session.
It uses root only for read-only Docker/filesystem/database inspection, never
prints `.env` or unrestricted container environment, and mutates nothing.

Owner-run attempt 1 completed every non-database gate but returned two false
negatives because `docker exec -u postgres ... psql` selected the Linux user
without selecting the configured PostgreSQL role. A separate owner-run
read-only diagnostic used the container's configured `POSTGRES_USER`, verified
database identity `aegis@aegis_drive`, migration 009, and zero public rows:

```text
S5_4_PREFLIGHT_ATTEMPT_1=FAIL_FALSE_NEGATIVE
FAILURE_SCOPE=POSTGRES_PROBE_ROLE_SELECTION
PRODUCTION_DATABASE=HEALTHY
MIGRATION_009=VERIFIED_PRESENT
PUBLIC_SHARE_ROWS=0
PRODUCTION_MUTATION=NONE
```

Attempt 1 is not a Production failure. The corrected preflight below resolves
`POSTGRES_USER` only inside the PostgreSQL container and still requires a fresh
complete PASS before any separately authorised S5.4 mutation.

```bash
sudo bash <<'S5_4_PREFLIGHT'
set -u

failures=0
pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); }
expect_eq() {
  label=$1 actual=$2 expected=$3
  if [ "$actual" = "$expected" ]; then pass "$label=$actual"; else fail "$label expected=$expected actual=$actual"; fi
}
expect_present() { if [ -e "$2" ]; then pass "$1"; else fail "$1 missing"; fi; }

unset DOCKER_HOST
DOCKER='docker'
COMPOSE=/opt/aegis/runtime/docker-compose.production.yml
S53=/opt/aegis/runtime/public-share/drive-s5-3.yml
DRIVE=aegis-prod-drive-1
POSTGRES=aegis-prod-postgres-1
EXPECTED_DRIVE_IMAGE=sha256:04d2f81478fdb0d4284433cfd2d07197c9175d61425216565405a46f914766df
EXPECTED_COMPOSE_SHA=5aae5cd7ded537f9124d2af8733d076f177871e0d3757208bf0c4a61fc635193
EXPECTED_S53_SHA=324fb5126b2f13f7b1c529ef1391131ef37f81acc8c3921b9b50f649b179de62

printf '%s\n' '=== S5.4 READ-ONLY PRE-MUTATION PREFLIGHT ==='
expect_present production_compose_present "$COMPOSE"
expect_present s5_3_override_present "$S53"
if [ -f "$COMPOSE" ]; then expect_eq production_compose_sha "$(sha256sum "$COMPOSE" | awk '{print $1}')" "$EXPECTED_COMPOSE_SHA"; fi
if [ -f "$S53" ]; then expect_eq s5_3_override_sha "$(sha256sum "$S53" | awk '{print $1}')" "$EXPECTED_S53_SHA"; fi

printf '%s\n' '--- Docker engine and Production services ---'
docker_version=$($DOCKER version --format '{{.Server.Version}}' 2>/dev/null || true)
expect_eq docker_engine_version "$docker_version" 29.7.1
prod_rows=$($DOCKER ps --filter label=com.docker.compose.project=aegis-prod --format '{{.Names}}|{{.State}}|{{.Status}}' | sort)
printf '%s\n' "$prod_rows"
if [ -n "$prod_rows" ] && ! printf '%s\n' "$prod_rows" | grep -Ev '\|running\|.*\(healthy\)' >/dev/null; then
  pass production_services_running_healthy
else
  fail production_services_running_healthy
fi
for name in "$DRIVE" "$POSTGRES" twingate-aegis-connector-02; do
  if $DOCKER inspect "$name" >/dev/null 2>&1; then pass "container_present:$name"; else fail "container_present:$name"; fi
done
connector_state=$($DOCKER inspect --format '{{.State.Status}}' twingate-aegis-connector-02 2>/dev/null || true)
connector_health=$($DOCKER inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}<none>{{end}}' twingate-aegis-connector-02 2>/dev/null || true)
expect_eq twingate_connector_state "$connector_state" running
expect_eq twingate_connector_health "$connector_health" healthy

drive_image=$($DOCKER inspect --format '{{.Image}}' "$DRIVE" 2>/dev/null || true)
expect_eq drive_image "$drive_image" "$EXPECTED_DRIVE_IMAGE"
drive_revision=$($DOCKER image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$EXPECTED_DRIVE_IMAGE" 2>/dev/null || true)
expect_eq drive_oci_revision "$drive_revision" 50ce6e1638c6bcdb2a378a3cee660050b9cb41d8

drive_networks=$($DOCKER inspect "$DRIVE" 2>/dev/null | python3 -c 'import json,sys
d=json.load(sys.stdin)[0]["NetworkSettings"]["Networks"]
print(";".join("{}={}".format(name,d[name].get("IPAddress","")) for name in sorted(d)))' 2>/dev/null || true)
expect_eq drive_private_networks "$drive_networks" 'aegis_drive_proxy=172.19.255.3;aegis_internal=172.18.0.3;aegis_vlan10_macvlan=192.168.10.11'

printf '%s\n' '--- Selected non-secret Drive configuration ---'
drive_env_field() {
  key=$1
  $DOCKER inspect "$DRIVE" 2>/dev/null | python3 -c 'import json,sys
key=sys.argv[1]
env=json.load(sys.stdin)[0]["Config"].get("Env",[])
matches=[item.split("=",1)[1] for item in env if item.split("=",1)[0] == key and "=" in item]
sys.stdout.write("<unset>" if not matches else matches[0] if len(matches) == 1 else "<duplicate>")' "$key" 2>/dev/null || printf '%s' '<parse-error>'
}
trusted_proxy_cidrs=$(drive_env_field TRUSTED_PROXY_CIDRS)
public_share_gateway_cidr=$(drive_env_field PUBLIC_SHARE_GATEWAY_CIDR)
public_share_base_url=$(drive_env_field PUBLIC_SHARE_BASE_URL)
public_share_ui_enabled=$(drive_env_field PUBLIC_SHARE_UI_ENABLED)

if [ "$trusted_proxy_cidrs" = '172.19.255.2/32' ]; then pass drive_hub_only_trust_exact; else fail drive_hub_only_trust_exact; fi
case "$public_share_gateway_cidr" in '<unset>'|'') pass gateway_cidr_unset_or_empty ;; *) fail gateway_cidr_unset_or_empty ;; esac
case "$public_share_base_url" in '<unset>'|'') pass public_share_base_url_unset_or_empty ;; *) fail public_share_base_url_unset_or_empty ;; esac
case "$public_share_ui_enabled" in '<unset>'|'') pass public_share_ui_effective_false_unset_or_empty ;; false) pass public_share_ui_effective_false_literal ;; *) fail public_share_ui_effective_false ;; esac

printf '%s\n' '--- Protected data and migration state ---'
for volume in aegis_drive_storage aegis_postgres_data; do
  if $DOCKER volume inspect "$volume" >/dev/null 2>&1; then pass "protected_volume:$volume"; else fail "protected_volume:$volume"; fi
done
postgres_query() {
  sql=$1
  $DOCKER exec -u postgres "$POSTGRES" sh -c '
test -n "${POSTGRES_USER:-}" || exit 1
exec psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -d aegis_drive -Atqc "$1"
' sh "$sql"
}
migration=$(postgres_query "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='shares_scope_check';" 2>/dev/null || true)
printf 'SHARES_SCOPE_CHECK=%s\n' "$migration"
case "$migration" in *public* ) pass migration_009_present ;; * ) fail migration_009_present ;; esac
public_rows=$(postgres_query "SELECT count(*) FROM shares WHERE scope='public';" 2>/dev/null || true)
expect_eq public_share_rows "$public_rows" 0

printf '%s\n' '--- Network inventory and collision gate ---'
$DOCKER network ls --format 'NETWORK={{.Name}} DRIVER={{.Driver}} SCOPE={{.Scope}}' | sort
$DOCKER network inspect $($DOCKER network ls -q) 2>/dev/null | python3 -c 'import ipaddress,json,sys
targets=[ipaddress.ip_network(x) for x in ("172.31.240.0/29","172.31.241.0/29","172.31.242.0/29")]
collisions=[]
for network in json.load(sys.stdin):
    name=network.get("Name","")
    for cfg in network.get("IPAM",{}).get("Config",[]) or []:
        raw=cfg.get("Subnet")
        if not raw: continue
        try: existing=ipaddress.ip_network(raw,strict=False)
        except ValueError: continue
        for target in targets:
            if existing.version==target.version and existing.overlaps(target): collisions.append("{}:{}<->{}".format(name,existing,target))
print("SUBNET_COLLISIONS="+(";".join(collisions) if collisions else "NONE"))
sys.exit(1 if collisions else 0)' && pass subnet_collision_check || fail subnet_collision_check
for network in aegis_public_share_edge aegis_public_share_upstream aegis_public_share_egress; do
  if $DOCKER network inspect "$network" >/dev/null 2>&1; then fail "public_share_network_absent:$network"; else pass "public_share_network_absent:$network"; fi
done

printf '%s\n' '--- No pre-exposure runtime ---'
if $DOCKER ps -a --format '{{.Names}}' | grep -E '(^|[-_])(public-share-gateway|cloudflared)([-_]|$)' >/dev/null; then fail public_share_containers_absent; else pass public_share_containers_absent; fi
if pgrep -a -x cloudflared >/dev/null 2>&1; then fail cloudflared_process_absent; else pass cloudflared_process_absent; fi
if systemctl list-unit-files cloudflared.service --no-legend 2>/dev/null | grep -q '^cloudflared.service'; then fail cloudflared_service_absent; else pass cloudflared_service_absent; fi
listeners=$(ss -H -lntup 2>/dev/null || true)
printf '%s\n' "$listeners"
if printf '%s\n' "$listeners" | grep -E '(:8080|share\.aegistk-pb\.com)' >/dev/null; then fail unexpected_public_share_listener; else pass unexpected_public_share_listener_absent; fi
if getent hosts share.aegistk-pb.com >/dev/null 2>&1; then fail share_hostname_route_absent; else pass share_hostname_route_absent; fi

printf '%s\n' '--- Rollback artifact ---'
rollback_id=$($DOCKER image inspect --format '{{.Id}}' aegis-prod-drive:rollback-pre-public-share-s5-3-20260910t102946z 2>/dev/null || true)
expect_eq rollback_image_id "$rollback_id" sha256:fd9d8f74f0d3df73c21cdb46256f2afb101b7b9fbf1d4e3d95142c22712e23a1

if [ "$failures" -eq 0 ]; then
  printf '%s\n' 'S5_4_PRE_MUTATION_GATE=PASS'
  exit 0
fi
printf 'S5_4_PRE_MUTATION_GATE=FAIL failures=%s\n' "$failures"
exit 1
S5_4_PREFLIGHT
```

Safe output to return is the complete block output because it contains only
service health/identity, image and file hashes, network/listener inventory,
selected non-secret Public Share configuration, row count, and PASS/FAIL
markers. Stop if the final marker is not exactly
`S5_4_PRE_MUTATION_GATE=PASS`.

### 6.1 Owner-run Phase A evidence and confirmed integration defects

The S5.4 Production pre-mutation gate already **PASSED** (`S5_4_PRE_MUTATION_GATE=PASS`).
Owner authorization for S5.4 Production mutation remains valid.

During owner-run Phase A, two repository/runbook integration defects were
confirmed BEFORE any Drive recreation, S5.4 network creation, or Gateway start:

1. **CONFIRMED DEFECT 1 — missing canonical Production env file**:
   Without `--env-file`, Compose failed variable interpolation for:
   - `DRIVE_DB_PASSWORD`
   - `DRIVE_SESSION_SECRET`
   - `MONITOR_DB_PASSWORD`
   - `DETECTION_ENGINE_API_KEY`
   - `MONITOR_SESSION_SECRET`
   - `POSTGRES_PASSWORD`
   - `POSTGRES_USER`
   The canonical Production env file `/opt/aegis/Project-End-The-AEGIS/.env`
   exists (`root:root mode 0600`; contents not inspected). Because the operator
   session is `admin-main@aegis-system`, Compose cannot read this root-protected
   env file client-side without explicit privilege elevation.
   Every S5.4 Production Compose command requiring interpolation MUST use:
   `sudo docker compose --env-file /opt/aegis/Project-End-The-AEGIS/.env --project-name aegis-prod ...`
   and network rollback must use `sudo docker network rm ...`.

2. **CONFIRMED DEFECT 2 — incorrect Compose logical network key**:
   Owner-run read-only diagnostic produced:
   ```text
   TOP_LEVEL_NETWORKS:
   KEY=aegis_drive_proxy NAME=aegis_drive_proxy
   KEY=aegis_internal NAME=aegis_internal
   KEY=aegis_vlan10 NAME=aegis_vlan10_macvlan

   DRIVE_LOGICAL_NETWORK_KEYS=
   aegis_drive_proxy,aegis_internal,aegis_vlan10

   DRIVE_RUNTIME_NETWORKS=
   aegis_drive_proxy,aegis_internal,aegis_vlan10_macvlan
   ```
   Therefore:
   `aegis_vlan10` = Compose logical key
   `aegis_vlan10_macvlan` = Docker runtime network name
   The S5.4 overlay mistakenly referenced `aegis_vlan10_macvlan:` instead of `aegis_vlan10:`.
   Corrected to:
   ```yaml
   aegis_vlan10:
     ipv4_address: 192.168.10.11
   ```
   No second macvlan network is created, the runtime network is not renamed, and base Compose is not modified. Drive retains `aegis_internal`, `aegis_drive_proxy`, and `aegis_vlan10`, and adds `aegis_public_share_upstream`. Runtime result after future deployment remains `aegis_internal=172.18.0.3`, `aegis_drive_proxy=172.19.255.3`, `aegis_vlan10_macvlan=192.168.10.11`, and `aegis_public_share_upstream=172.31.241.3`.

Authoritative owner-run Phase A evidence:

```text
S5_4_PHASE_A_OVERLAY_STAGED=PASS
OVERLAY_SHA256=90fb5ea04f62ffcfe8cda1be80cc5a854865886226b4ab9e9a20afa5f5959c10

FROZEN_SOURCE_SHA=50ce6e1638c6bcdb2a378a3cee660050b9cb41d8
GATEWAY_SOURCE_TREE=2025eb0873a4e7f8d3d2b00b02fc3dfca02b91df
FROZEN_SOURCE_CLEAN=PASS

GATEWAY_IMAGE_BUILD=PASS
GATEWAY_IMAGE_ID=sha256:b61b0b0dcaa78fcb4739fe197544d06f8d5685e04e8596fb87563b65b8877909
GATEWAY_IMAGE_USER=101:101

S5_4_COMPOSE_VALIDATION_ATTEMPT_1=FAIL_MISSING_ENV_FILE
S5_4_COMPOSE_VALIDATION_ATTEMPT_2=FAIL_WRONG_LOGICAL_NETWORK_KEY

ROOT_CAUSE_1=MISSING_CANONICAL_PRODUCTION_ENV_FILE
ROOT_CAUSE_2=COMPOSE_LOGICAL_NETWORK_KEY_MISMATCH

DRIVE_RECREATED=NO
S5_4_NETWORKS_CREATED=NO
GATEWAY_CONTAINER_STARTED=NO
PUBLIC_EXPOSURE=NONE
```

These are repository/runtime-contract defects, not Production service failures.

### 6.2 Owner-run Production execution and final runtime acceptance

Following repository/runbook corrections, the owner executed Phase A correction,
Phase B Drive State B, Phase C Gateway runtime, Phase D-A internal security acceptance,
and Phase D-B actual public stream acceptance.

#### 1. Phase A correction gate
- Corrected overlay installed to `/opt/aegis/runtime/public-share/drive-gateway-s5-4.yml`
  (repository blob `2987e195358f638d376ff32f163de42349ef2c64`, SHA-256 `cc36d08c16731f888f64cb2dcd84f1c9a41b11e9b447aa16ad67405bcdc12819`).
- Canonical `--env-file /opt/aegis/Project-End-The-AEGIS/.env`, logical key `aegis_vlan10`,
  and explicit `sudo` privilege boundary supplied.
- Gateway image `aegis-public-share-gateway:public-share-50ce6e1638` (ID `sha256:b61b0b0dcaa78fcb4739fe197544d06f8d5685e04e8596fb87563b65b8877909`).
- Result: `S5_4_PHASE_A_CORRECTION_GATE=PASS`.

#### 2. Phase B attempt 1 — failed assertion and clean rollback
- Drive State B was recreated, but acceptance script failed on a stale hard-coded
  total share row assertion (expected 25, actual 27).
- Automatic rollback executed cleanly to S5.3; rollback verification passed.
- Investigation confirmed extra rows were legitimate previously-created/revoked private
  acceptance shares. Revoked rows are intentionally persisted; total share count must
  never be hard-coded as an acceptance invariant.

#### 3. Phase B v2 — Drive State B accepted
- Acceptance used snapshot/invariant comparison instead of hard-coded total.
- Result: `S5_4_DRIVE_STATE_B_V2=PASS`, `AUTO_ROLLBACK=NOT_NEEDED`.
- Pre-acceptance baseline: shares=27, public=0, digest=`5b902108c177ec00f09cc2b47f265317`.
- Drive container: `7ca5cae9e8563a9d8940322f24b1de6e91960e59caed4cdfba715debb05582a4`.
- Networks: `aegis_drive_proxy=172.19.255.3`, `aegis_internal=172.18.0.3`,
  `aegis_public_share_upstream=172.31.241.3`, `aegis_vlan10_macvlan=192.168.10.11`.
- Upstream: `172.31.241.0/29`, gateway `172.31.241.1`, isolated bridge.
- Drive proxy trust: `172.19.255.2/32,172.31.241.2/32`; gateway CIDR: `172.31.241.2/32`.
- Drive environment: `PUBLIC_SHARE_BASE_URL=https://share.aegistk-pb.com`, `PUBLIC_SHARE_GATEWAY_CIDR=172.31.241.2/32`, `PUBLIC_SHARE_UI_ENABLED=false`.
- Gateway not running yet; no cloudflared; no host listener.

#### 4. Private regression after Drive State B
- Fresh private tests: `LOGIN=PASS`, `FILES=PASS`, `PUBLIC_UI_HIDDEN=PASS`.
- Public Share card visible as not ready / unavailable; NOT selectable.
- Fresh `any` scope: `ANY_CREATE=PASS`, `ANY_REDEEM=PASS`, `ANY_REVOKE=PASS`, `ANY_REDEEM_AFTER_REVOKE=BLOCKED`.
- `zones` scope was deliberately not rerun in S5.4: `ZONES=HISTORICAL_PASS`, `ZONES_S5_4_RERUN=NOT_RUN`
  (historical evidence at `90-Status/logs/2026-08-24_170607_kla_idea1-b4-network-scope-acceptance.md`).

#### 5. Phase C — Production Gateway runtime
- Result: `S5_4_GATEWAY_RUNTIME=PASS`.
- Gateway container: `00f2cd8af06636f1e06ddf92519e5ed21dc05eaed48594fbc60bf90701300bcb`.
- Hardening: user `101:101`, `read_only=true`, `cap_drop=ALL`, `no-new-privileges=true`, host ports = 0.
- Networks: edge `172.31.240.0/29` (Gateway `.2`, connector `.3` reserved);
  upstream `172.31.241.0/29` (Gateway `.2`, Drive `.3`).
- Gateway environment: `PUBLIC_SHARE_HOST=share.aegistk-pb.com`.
- Drive container preserved, DB digest preserved, host 8080 absent, cloudflared absent, egress absent.

#### 6. Phase D-A — internal managed-edge security acceptance
- Result: `S5_4_GATEWAY_SECURITY_DA=PASS`.
- Gateway edge trust: connector `172.31.240.3/32` only. Canonical header: `CF-Connecting-IP`.
- Provider/forwarding headers stripped before Drive: `CF-Connecting-IP`, `CF-Connecting-IPv6`,
  `CF-Pseudo-IPv4`, `True-Client-IP`, `CF-Visitor`, `CF-IPCountry`, `CF-Ray`, `CF-Worker`, `CDN-Loop`.
- Negative security: missing CF header -> 403; duplicate CF header -> 403; untrusted peer -> 403;
  PUT -> 405; wrong Host -> 404; `/api/me` -> local 404; path traversal -> 404.
- Positive attribution: synthetic GET -> canonical source `198.51.100.10`;
  synthetic POST -> canonical recipient `198.51.100.21`. Forged forwarding headers rejected.
- Rate limiting: burst produced 404=11, 429=29, other=0; separate recipient remained independent.
- Gateway logs safe, no token leakage. Temporary edge member removed. Containers preserved.

#### 7. Phase D-B — actual public share streaming through Production Gateway
- Result: `S5_4_ACTUAL_PUBLIC_STREAM=PASS`, `S5_4_GATEWAY_STREAMING_DB=PASS`, `S5_4_TEMP_PUBLIC_SHARE_CLEANUP=PASS`.
- Streamed object: 1048576 bytes; SHA-256 matched stored file; Content-Type: `application/octet-stream`.
- Hit count incremented by exactly 1.
- Canonical recipient attribution: `198.51.100.30`. Forged source `203.0.113.77` rejected.
- Browser revoke completed: `S5_4_TEMP_PUBLIC_SHARE_REVOKE=PASS`.
- Post-revoke verification: `post_revoke_gateway_http=404`, hits unchanged at 1,
  `active_public_shares_after_cleanup=0`, edge client removed, gateway logs token-safe,
  containers preserved, host 8080 absent, cloudflared absent, egress absent.
- Workflow false starts truthfully recorded: initial browser session expired (HTTP 401 on `/drive/api/me`);
  clipboard workflow copied Console text; temporary public share id 32 remained active after raw bearer token was lost from browser memory
  (system persisted only token hash, raw token not recoverable); authenticated browser session called Drive API (`GET /drive/api/shares`
  identified active share as id 32, and `DELETE /drive/api/shares/32` with session/CSRF token revoked it; no raw token recovered from PostgreSQL,
  no row deleted from PostgreSQL); fresh temporary public share created, streamed through Gateway (HTTP 200), and revoked via browser UI;
  final active public share count was zero. Zero token leakage throughout.

#### 8. Final accepted runtime state
```text
S5_4_RUNTIME_ACCEPTANCE=PASS
S5_4_DRIVE_STATE_B_V2=PASS
S5_4_GATEWAY_RUNTIME=PASS
S5_4_GATEWAY_SECURITY_DA=PASS
S5_4_ACTUAL_PUBLIC_STREAM=PASS
S5_4_GATEWAY_STREAMING_DB=PASS
S5_4_TEMP_PUBLIC_SHARE_CLEANUP=PASS
S5_5=NOT_STARTED
G5=OPEN
G6=OPEN
PUBLIC_SHARE_UI=OFF
ACTIVE_PUBLIC_SHARES=0
CLOUDFLARED=ABSENT
EGRESS_NETWORK=ABSENT
INTERNET_EXPOSURE=NONE
PUBLIC_INTERNET_SHARE=NOT_IMPLEMENTED
```

## 7. Repository closeout and Ready for Review gate

From repository root:

```bash
node --test tests/*.test.mjs
node --test tests/collaborationPolicy.test.mjs
node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge
git diff --check
git diff --name-status origin/main...HEAD
```

Verify that exactly ONE immutable final task receipt exists under
`Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/`, all required tests and
validations pass, and PR #116 is updated and transitioned from Draft to Ready for Review.
Human merge only. S5.5 remains NOT STARTED until explicitly authorized.
