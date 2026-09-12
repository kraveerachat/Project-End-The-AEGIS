# PUBLIC-SHARE-7 S5.4 / S5.5 Production Overlay

> ## DO NOT EXECUTE WITHOUT SEPARATE S5.5-F OWNER AUTHORIZATION
>
> Every S5.5 command in this file is **documentation of a future procedure**,
> not an instruction to run now. Repository documentation is NOT approval and
> NOT authorization. At the time of writing nothing in the S5.5 section has been
> applied to Production: the firewall is unchanged, the connector is absent, the
> egress network is absent, no systemd unit is installed, and no credential file
> exists.


This directory contains the repository-side S5.4 Drive State B and dedicated
gateway network contract, reconciled with completed owner-run Production runtime
acceptance. S5.4 is strictly pre-Internet:
`cloudflared`: absent; DNS: absent; TLS route: absent; host-published listener:
absent; Public Share UI: off; egress network: absent.

The existing nginx-only gateway under `gateway/public-share/` is reused. Its
source tree is `2025eb0873a4e7f8d3d2b00b02fc3dfca02b91df` at both revision
`50ce6e1638c6bcdb2a378a3cee660050b9cb41d8` and S5.4 base
`dc673992b4c474716c4a14d2d375b3c9dd583feb`. No second share backend exists.

## Compose order

The reviewed future model uses exactly these files, in order:

1. `/opt/aegis/runtime/docker-compose.production.yml`
2. `/opt/aegis/runtime/public-share/drive-s5-3.yml`
3. `/opt/aegis/runtime/public-share/drive-gateway-s5-4.yml`, copied byte-for-byte
   from `docker-compose.s5-4.yml` after merge

Validate the merged model before any service operation:

```bash
sudo docker compose \
  --env-file /opt/aegis/Project-End-The-AEGIS/.env \
  --project-name aegis-prod \
  -f /opt/aegis/runtime/docker-compose.production.yml \
  -f /opt/aegis/runtime/public-share/drive-s5-3.yml \
  -f /opt/aegis/runtime/public-share/drive-gateway-s5-4.yml \
  config --quiet
```

The future service-scoped order is Drive first and gateway second:

```bash
sudo docker compose \
  --env-file /opt/aegis/Project-End-The-AEGIS/.env \
  --project-name aegis-prod \
  -f /opt/aegis/runtime/docker-compose.production.yml \
  -f /opt/aegis/runtime/public-share/drive-s5-3.yml \
  -f /opt/aegis/runtime/public-share/drive-gateway-s5-4.yml \
  up -d --no-deps --no-build drive

sudo docker compose \
  --env-file /opt/aegis/Project-End-The-AEGIS/.env \
  --project-name aegis-prod \
  -f /opt/aegis/runtime/docker-compose.production.yml \
  -f /opt/aegis/runtime/public-share/drive-s5-3.yml \
  -f /opt/aegis/runtime/public-share/drive-gateway-s5-4.yml \
  up -d --no-deps --no-build public-share-gateway
```

These commands reflect the exact sequence executed during owner-run Production
acceptance. Production Drive State B and dedicated Gateway are active on isolated
internal networks.

## Exact S5.3 rollback

Rollback removes the gateway first, then restores Drive by omitting the S5.4
overlay:

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

The two networks may be removed only after inspection proves they have no
members. The accepted S5.3 state is:

- Drive image
  `sha256:04d2f81478fdb0d4284433cfd2d07197c9175d61425216565405a46f914766df`;
- S5.3 override SHA-256
  `324fb5126b2f13f7b1c529ef1391131ef37f81acc8c3921b9b50f649b179de62`;
- `aegis_drive_proxy=172.19.255.3`;
- `aegis_internal=172.18.0.3`;
- `aegis_vlan10_macvlan=192.168.10.11`;
- `TRUSTED_PROXY_CIDRS=172.19.255.2/32`;
- `PUBLIC_SHARE_GATEWAY_CIDR=unset`;
- `PUBLIC_SHARE_UI_ENABLED=false`;
- protected volumes and unrelated services unchanged.

No Compose-wide stop, recreate, rebuild, or prune operation is permitted.

---

# S5.5 connector, egress isolation and lifecycle

> **DO NOT EXECUTE WITHOUT SEPARATE S5.5-F OWNER AUTHORIZATION.** Documentation
> is not approval. This section describes the reviewed future procedure only.

## Remaining acceptance gates (all still OPEN)

| Gate | State |
| :--- | :--- |
| `PRODUCTION_DNS_PATH_MEASURED` | **NO** — host resolver config is measured (systemd-resolved stubs `127.0.0.53` / `127.0.0.54`, uplinks `8.8.8.8` / `1.1.1.1`), but the **connector/container** DNS path is not. No DNS allow rule exists and none may be added until it is measured and reconciled. |
| Firewall atomicity on real `iptables-nft` | **NOT ACCEPTED YET** |
| Docker / UFW / systemd restart persistence | **NOT ACCEPTED YET** |
| Public DNS / TLS route | **NOT CONFIGURED** |
| Internet exposure | **NONE** |
| G5 | **OPEN** |
| Public Share UI | **OFF** (`PUBLIC_SHARE_UI_ENABLED=false`) |
| `PRODUCTION_COMPOSE_CREATE_CAPABILITY_RECHECK` | **PASS** — owner-run read-only F0B on Production (Compose v5.4.0) confirms `create` supports `--no-build`, `--no-recreate` and `--pull missing`, and that `start` and `stop` are service-scoped. This is CLI capability evidence only, not permission to execute. |

Recorded verbatim for downstream gates:

```text
PRODUCTION_DNS_PATH_MEASURED=NO
PRODUCTION_FIREWALL_ATOMICITY_ACCEPTED=NO
PRODUCTION_RESTART_PERSISTENCE_ACCEPTED=NO
PUBLIC_DNS_TLS=NOT CONFIGURED
INTERNET_EXPOSURE=NONE
G5=OPEN
PUBLIC_SHARE_UI=OFF
```

Activation stays blocked until the real connector DNS path is measured and
reconciled during separately authorised Production work.

## Compose order — exactly four layers

S5.5 adds one file to the accepted S5.4 stack. The order is:

1. `/opt/aegis/runtime/docker-compose.production.yml`
2. `/opt/aegis/runtime/public-share/drive-s5-3.yml`
3. `/opt/aegis/runtime/public-share/drive-gateway-s5-4.yml`
4. `/opt/aegis/runtime/public-share/connector-s5-5.yml`

`connector-s5-5.yml` must be copied **byte-for-byte** from
`gateway/public-share/production/docker-compose.s5-5.yml` after merge. It is
never hand-edited on the host; the pinned image digest must arrive exactly as
reviewed.

```bash
sudo docker compose \
  --env-file /opt/aegis/Project-End-The-AEGIS/.env \
  --project-name aegis-prod \
  -f /opt/aegis/runtime/docker-compose.production.yml \
  -f /opt/aegis/runtime/public-share/drive-s5-3.yml \
  -f /opt/aegis/runtime/public-share/drive-gateway-s5-4.yml \
  -f /opt/aegis/runtime/public-share/connector-s5-5.yml \
  config --quiet
```

## Credential preparation — do this BEFORE any Compose invocation

Canonical host path:

```text
/opt/aegis/runtime/public-share/secrets/cloudflared-token
```

Required metadata, enforced by the pre-start validator:

| Property | Required value |
| :--- | :--- |
| Type | **regular file** (never a directory, never a symlink) |
| Owner | `root` (UID `0`) |
| GID | `65532` (group) |
| Mode | exactly `0440` |

**Why the file must exist first.** Compose applies `create_host_path` to a bind
mount, so if the source path is missing at `up` time Docker silently creates a
**directory** there. The connector would then mount an empty directory instead
of a credential, and the failure would look like an application error. Create
the regular file *before* Compose runs; the pre-start validator refuses a
directory, a symlink, wrong ownership or wrong mode.

```bash
sudo mkdir -p /opt/aegis/runtime/public-share/secrets
sudo chmod 0750 /opt/aegis/runtime/public-share/secrets

# Prompt for the token without echoing it and without shell history.
sudo install -o root -g 65532 -m 0440 /dev/null /run/cloudflared-token.tmp
sudo systemd-ask-password --echo=no "cloudflared tunnel token:" \
  | sudo tee /run/cloudflared-token.tmp >/dev/null
sudo install -o root -g 65532 -m 0440 /run/cloudflared-token.tmp \
  /opt/aegis/runtime/public-share/secrets/cloudflared-token
sudo shred -u /run/cloudflared-token.tmp

# Verify metadata only. This prints type, owner, GID and mode - never content.
sudo stat -c '%F %u %g %a' /opt/aegis/runtime/public-share/secrets/cloudflared-token
# expected: regular file 0 65532 440
```

**Credential handling rules — all mandatory:**

- Never `cat`, `echo`, `printf` or otherwise print the token.
- Never let the token enter shell history.
- Never place the token in an environment variable, including `TUNNEL_TOKEN`.
  The connector reads it only via `--token-file`.
- Never place the token in logs, journal output or a bug report.
- Never place the token in Obsidian, a task receipt, a commit message or a PR.
- Never pass the token as a command argument; arguments are readable in `/proc`.
- Rotate the token in Cloudflare if it is ever printed or copied anywhere.

## First activation — bootstrap the connector STOPPED, before the firewall

> **DO NOT EXECUTE WITHOUT SEPARATE S5.5-F OWNER AUTHORIZATION.**

On first activation the egress network, the `aegis-ps-eg` bridge and the
connector container all do **not** exist. The firewall deliberately fails closed
when `aegis-ps-eg` is missing, so the connector object must be created *before*
the firewall is applied. Creating it is what materialises the network and the
bridge.

The connector is created **stopped**, validated, and only then started. The
object that is validated is exactly the object that starts — nothing may create
or recreate a container after validation.

**Never** use the bring-up form `up -d public-share-connector`: that form belongs only to the S5.4 `drive` and `public-share-gateway` steps above.
It creates and starts in one step, so the container would begin running before
the firewall exists and before any validation has happened. That form stays
forbidden for the connector at every stage, and the systemd unit uses `start`
for the same reason.

### 1. Prepare the credential

Complete the credential preparation section above first. The regular file must
exist, owned `root`, GID `65532`, mode `0440`, before anything is created.

### 2. Verify the four-layer model

```bash
sudo docker compose \
  --env-file /opt/aegis/Project-End-The-AEGIS/.env \
  --project-name aegis-prod \
  -f /opt/aegis/runtime/docker-compose.production.yml \
  -f /opt/aegis/runtime/public-share/drive-s5-3.yml \
  -f /opt/aegis/runtime/public-share/drive-gateway-s5-4.yml \
  -f /opt/aegis/runtime/public-share/connector-s5-5.yml \
  config --quiet
```

### 3. Create the connector ONLY, without starting it

```bash
sudo docker compose \
  --env-file /opt/aegis/Project-End-The-AEGIS/.env \
  --project-name aegis-prod \
  -f /opt/aegis/runtime/docker-compose.production.yml \
  -f /opt/aegis/runtime/public-share/drive-s5-3.yml \
  -f /opt/aegis/runtime/public-share/drive-gateway-s5-4.yml \
  -f /opt/aegis/runtime/public-share/connector-s5-5.yml \
  create --no-build --no-recreate --pull missing public-share-connector
```

Why exactly these flags, on Docker Compose v2:

- `create` creates containers without starting them. The bring-up forms and `run` would start the connector at once, as they correctly do for `drive` and `public-share-gateway` in S5.4.
  `start` is also wrong at this point, because nothing has been created yet for
  it to start.
- naming `public-share-connector` scopes the operation to that one service.
  `create` has no `--no-deps` flag, and none is needed: the connector declares no
  `depends_on`, so no other service is implied. Verify this stays true if the
  overlay ever changes.
- `--no-recreate` protects any existing container from being recreated, so
  `drive`, `public-share-gateway` and the database cannot be disturbed.
- `--no-build` guarantees no image is built.
- `--pull missing` pulls only when the image is absent. The image is pinned by
  digest, so a pull can only ever fetch that exact image.
- `--remove-orphans` is deliberately **not** used; it would delete containers not
  present in these four files.
- `--force-recreate` is deliberately **not** used.

### 4. Prove the connector exists and is NOT running

```bash
sudo docker inspect aegis-prod-public-share-connector-1 \
  --format 'Status={{.State.Status}} Running={{.State.Running}} Restarting={{.State.Restarting}}'
# expected: Status=created Running=false Restarting=false
```

Do not continue if `Running` is anything but `false`.

### 5. Prove the egress network now exists

```bash
sudo docker network inspect aegis_public_share_egress \
  --format '{{.Name}} {{(index .IPAM.Config 0).Subnet}} {{(index .IPAM.Config 0).Gateway}} {{index .Options "com.docker.network.bridge.name"}}'
# expected: aegis_public_share_egress 172.31.242.0/29 172.31.242.1 aegis-ps-eg
ip -brief link show aegis-ps-eg
```

### 6. Prove the exact attachment and fixed addresses

```bash
sudo docker inspect aegis-prod-public-share-connector-1 \
  --format '{{range $net, $cfg := .NetworkSettings.Networks}}{{$net}}={{$cfg.IPAddress}} {{end}}'
# expected exactly:
#   aegis_public_share_edge=172.31.240.3 aegis_public_share_egress=172.31.242.2
sudo docker inspect aegis-prod-public-share-connector-1 \
  --format '{{index .Config.Labels "com.docker.compose.project"}}/{{index .Config.Labels "com.docker.compose.service"}}'
# expected: aegis-prod/public-share-connector
```

A third network, a wrong address, or a wrong project/service label means stop and
roll back — do not start the connector.

### 7-8. Apply and validate the firewall

```bash
sudo /opt/aegis/runtime/public-share/s5-5-firewall.sh apply
sudo /opt/aegis/runtime/public-share/s5-5-firewall.sh validate
```

`aegis-ps-eg` now exists, so the fail-closed interface requirement is satisfied
for the first time.

### 9. Pre-start validation

```bash
sudo /opt/aegis/runtime/public-share/s5-5-runtime-check.sh --pre-start
```

This re-verifies the **same stopped container**: it must exist, carry the
accepted Compose project and service labels, still be stopped, hold exactly the
edge and egress attachments on their exact fixed addresses, and the credential
and firewall must pass.

### 10. Start the validated connector through systemd

```bash
sudo systemctl start aegis-public-share-connector.service
```

The unit runs the pre-start validator again and then `start public-share-connector`
— starting the already-validated object rather than creating a new one.

## Firewall install and validation

```bash
sudo install -o root -g root -m 0750 \
  gateway/public-share/production/s5-5-firewall.sh \
  gateway/public-share/production/s5-5-runtime-check.sh \
  gateway/public-share/production/rollback-s5-5.sh \
  /opt/aegis/runtime/public-share/
sudo install -o root -g root -m 0640 \
  gateway/public-share/production/cloudflare-endpoints.json \
  /opt/aegis/runtime/public-share/

sudo /opt/aegis/runtime/public-share/s5-5-firewall.sh apply
sudo /opt/aegis/runtime/public-share/s5-5-firewall.sh validate
```

`apply` is idempotent and consumes the reviewed endpoint allowlist; it refuses a
broad or unverified allowlist before touching a rule. `validate` exits non-zero
on any drift — missing chain, missing/duplicate/misordered anchor, wrong or
unauthorized endpoint, missing terminal deny, TCP/443, UDP/7844, an overly broad
destination, a wrong interface binding, or an unresolved edge bridge.

The edge Linux bridge is resolved dynamically from `docker network inspect`;
never hard-code `br-<id>` and never use the Docker network name as an interface.

Before any mutation, `apply` runs a fail-closed preflight: the iptables backend
must report `nf_tables` (Production F0 measures iptables v1.8.11 nf_tables), and
the `INPUT` and `DOCKER-USER` host chains must already exist. A host that fails
either check is left completely untouched rather than half-configured.

`validate` runs the same preflight and mutates nothing. This matters because
`s5-5-runtime-check.sh --pre-start` treats a successful `validate` as its
firewall safety gate: a `validate` that passed against the wrong backend would
let the connector start against rules nothing consults.

`remove` **refuses while the connector is active or indeterminate.**
The connector is identified by exact Compose project and service labels (`aegis-prod`/`public-share-connector`).
Only positively safe existing states permit removal: `created` and `exited`.
These refuse with the firewall completely unchanged: `running`, `restarting`, `paused`,
`dead`, `removing`, `unknown`, and any malformed state. Wrong or missing Compose identity
fails closed. Any Docker failure or state uncertainty that is not positively "no such object"
fails closed. A positively absent connector permits removal (idempotent). The guard only
refuses — it never stops, kills, or removes a container and never drives systemd. Stopping
the connector first remains the job of systemd ordering (the connector unit `BindsTo`/`After`
the firewall unit) and of `rollback-s5-5.sh`.

**Scope boundary.** `AEGIS-PS-EGRESS` is anchored first in `DOCKER-USER`, so
anything it accepts is authorised for the whole host before Docker and UFW policy
runs. It therefore contains no blanket established/related accept. Return traffic
is permitted only toward the two connector addresses, so unrelated forwarded
traffic falls through to the pre-existing policy untouched, and an established
connector flow to an unauthorised destination still reaches the terminal deny.

### Edge-bridge firewall correction (Production root cause and procedure)

#### Production-discovered root cause

During live S5.5-F acceptance, the first isolation matrix established that routed egress was correctly isolated while same-bridge east-west traffic between the connector and Gateway bypassed `DOCKER-USER`:

- `br_netfilter not loaded`
- `bridge-nf-call-iptables unavailable`
- `same-bridge Gateway:22 returned ECONNREFUSED`
- `AEGIS-PS-EGRESS connector-edge DROP counter did not increment`
- `connector safety-stop returned it to exited/running=false`

Root cause: the Linux kernel on the Production host bridges Layer-2 traffic directly within `aegis_public_share_edge` without invoking iptables bridge-netfilter hooks.

Architectural resolution:
- **Routed egress** remains enforced by `iptables-nft` (`AEGIS-PS-EGRESS` in `DOCKER-USER` and `AEGIS-PS-INPUT` in `INPUT`).
- **Same-bridge east-west** isolation is now enforced by a native nftables bridge table (`table bridge aegis_s55_edge`, chain `forward`, hook `forward`, priority 0).

#### Corrected first-start order

Deploying the correction on Production follows this strict order:

1. `connector stopped` (prove `State.Running=false`, state `exited` or `created`)
2. `install exact reviewed corrected artifacts` (firewall script, runtime check, rollback script, endpoint allowlist)
3. `nft candidate check + firewall apply` (`nft --check` candidate validation before atomic batch apply)
4. `full three-plane validate` (iptables routed egress, iptables host input, native bridge table)
5. `runtime --pre-start` (verify topology, explicit `EnableIPv6=false`, credentials, stopped connector)
6. `start same connector object via systemd` (`systemctl start aegis-public-share-connector.service`)
7. `readiness + DNS` (verify tunnel transport readiness and internal container DNS resolution)
8. `isolation matrix with responsible-plane counters` (verify both routed and bridge DROP counters increment)
9. `2x live reconcile` (verify firewall validate and pre-start pass while connector is active)
10. `F1 final evidence review` (checkpoint immutable evidence before any further gate)

#### Strict operational constraints

- Never run `modprobe br_netfilter`
- Never mutate bridge sysctls (`/proc/sys/net/bridge/bridge-nf-call-*` must not be touched)
- Public DNS and TLS routes remain strictly forbidden (`NOT CONFIGURED`)
- Never run `compose down` or whole-stack commands
- Never recreate the connector container (`aegis-prod-public-share-connector-1` identity must be preserved)

#### Bridge counter evidence rule

For same-bridge negative probes (e.g. connector `172.31.240.3` -> Gateway `172.31.240.2:22`), network endpoint refusal or timeout alone is insufficient to claim pass. Acceptance requires proof that the native bridge DROP counter (`table bridge aegis_s55_edge`) increased during the probe.

## systemd lifecycle installation

```bash
sudo install -o root -g root -m 0644 \
  gateway/public-share/production/systemd/aegis-public-share-s5-5-firewall.service \
  gateway/public-share/production/systemd/aegis-public-share-connector.service \
  gateway/public-share/production/systemd/aegis-public-share-drift.service \
  gateway/public-share/production/systemd/aegis-public-share-drift.timer \
  /etc/systemd/system/
sudo systemctl daemon-reload

sudo systemctl enable --now aegis-public-share-s5-5-firewall.service
sudo systemctl enable --now aegis-public-share-connector.service
sudo systemctl enable --now aegis-public-share-drift.timer
```

Ordering is Docker/UFW ready -> firewall `apply` -> firewall `validate` ->
`s5-5-runtime-check.sh --pre-start` -> connector start. The connector unit
`BindsTo` the firewall unit, so the connector cannot run without its isolation
and stops if isolation stops.

## Pre-start validator

```bash
sudo /opt/aegis/runtime/public-share/s5-5-runtime-check.sh --pre-start
```

Fail-closed: it exits non-zero unless the firewall validates, the edge, upstream
and egress networks match the canonical contract exactly - Name, Driver,
Internal, Subnet, Gateway, plus `gateway_mode_ipv4=isolated` on edge and
upstream and the stable `aegis-ps-eg` bridge on egress -  the connector —
if it exists — is attached to exactly the edge and egress networks on its exact
fixed addresses, and the credential file passes the metadata checks above. It
never reads the token contents.

## Drift enforcement

```bash
sudo /opt/aegis/runtime/public-share/s5-5-runtime-check.sh --enforce-drift
systemctl list-timers aegis-public-share-drift.timer
```

The timer runs 1 minute after boot and every 60s thereafter. On unsafe drift it
stops **only** `aegis-public-share-connector.service`. It never stops the
gateway, drive, the database, monitoring, Twingate, the Docker daemon or UFW,
and it never weakens or removes a firewall rule to recover. A failed stop is
reported rather than escalated.

## Connector-only rollback

```bash
sudo /opt/aegis/runtime/public-share/rollback-s5-5.sh
```

Reverse order: drift timer stopped and disabled first, then the connector
service, then only the connector container, then `s5-5-firewall.sh remove`, then
the egress network — and the egress network only after its endpoint count is
proven to be zero. If any endpoint remains it refuses.

The accepted S5.4 baseline is preserved: `drive`, `public-share-gateway`, the
database, every volume, the edge/upstream/private networks and private sharing
are untouched. No whole-stack Compose teardown, no prune of any kind, and no
volume removal is ever performed. The rollback script enforces this, and the
contract tests assert those operations are absent from it.

## Verification

```bash
sudo /opt/aegis/runtime/public-share/s5-5-firewall.sh validate
sudo /opt/aegis/runtime/public-share/s5-5-runtime-check.sh --pre-start
sudo iptables -S AEGIS-PS-EGRESS
sudo iptables -S AEGIS-PS-INPUT
sudo docker network inspect aegis_public_share_egress
systemctl status aegis-public-share-connector.service
```

Every one of these commands remains gated by the banner at the top of this
section.
