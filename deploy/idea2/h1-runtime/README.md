# H1 N1 persistent non-Production foundation

This is the reviewed repository contract for staged H1 lab gates. The Human
Owner separately reports live N1 PASS; this repository-only N2/N3 continuation
does not repeat or alter that lab. The separate remote source-checkout clean
gate returned `REMOTE_WORKTREE_CLEAN=NO` without path evidence and must be
resolved before new host source staging. N0's disposable
`deploy/idea2/h1-capacity-probe.compose.yml` remains independent and unchanged.
The fixed Compose project is `aegis-h1-lab`; it must never be pointed at
`aegis-prod` or the Production database. N1 starts only `postgres`, `migrate`,
and `monitor`. `gateway` is a disabled N3-profile source placeholder in the
base Compose file, with no host port or live TLS material; N2 cannot start it.

## Inputs and authority before a separate live authorization

- Reconfirm N0 PASS and the exact reviewed source commit, digest references,
  host capacity, network/port/resource absence, and Production baseline.
- Stage this repository at the reviewed commit on the non-Production host;
  check `git rev-parse HEAD` and compare it with `H1_MONITOR_SOURCE_SHA`.
  Use a fresh checkout with no modified, untracked, or ignored Monitor build
  context files. The validator enforces this; a correct SHA tag on a dirty
  Docker build context does **not** prove source equivalence.
- Create an owner-only, absolute-path lab environment file **outside** the
  repository, derived from `env.example`. On Linux require mode `0600`, owned
  by the invoking user. Never print, commit, transmit in logs, or attach it to
  evidence. Use independent random lab-only admin, application-role, and
  session secrets; never reuse Production credentials.
- `H1_DATABASE_URL` must use `monitor_h1_app`, hostname `postgres`, database
  `aegis_h1_lab`, and a URL-encoded `H1_APP_PASSWORD`. The validation helper
  checks these fields in memory without printing the rendered configuration.
  Preserve the reviewed secret file until the lab has been stopped and the
  rollback evidence accepted; `docker compose down` also needs interpolation.
- The official PostgreSQL image creates `postgres_h1_admin` only inside the
  new lab volume. Its init script creates separate non-superuser
  `monitor_h1_app` with table/sequence privileges. The schema migrator uses
  the lab admin role; the Monitor uses only the app role. The app role cannot
  create/drop schema or become the lab administrator.
- Do not start with an existing lab volume: initialization scripts run only
  when the PostgreSQL data directory is new. A pre-existing volume requires
  a separate data/role review, not an automatic overwrite.

## Read-only preflight (future separately authorized host step)

Run from the reviewed checkout. Set `H1_ENV_FILE` to the absolute owner-only
secret file path and `H1_MONITOR_SOURCE_SHA` to the exact reviewed HEAD. The
following commands are read-only and must not print Compose's interpolated
JSON, because that JSON contains secrets:

On `aegis-system`, leave Python, Git, and the owner-only secret file under the
invoking human account. Run `sudo -v` separately in the human terminal, then
select `AEGIS_H1_N1_DOCKER_MODE=sudo-noninteractive`. Only Docker commands use
`sudo -n env -u DOCKER_HOST docker --host unix:///var/run/docker.sock`. The
explicit local socket prevents an elevated Docker configuration from selecting
a remote daemon. Do not run the validator as root or use
`sudo -E`. Abort if sudo cannot run non-interactively, or if `DOCKER_HOST` or
`DOCKER_CONTEXT` is set. `direct` is the validator's default mode for hosts
where direct local Docker authorization has been separately proven; it is not
the reviewed `aegis-system` host mode.

```sh
sudo -v
export AEGIS_H1_N1_DOCKER_MODE=sudo-noninteractive
test "$(git rev-parse HEAD)" = "$H1_MONITOR_SOURCE_SHA"
test -z "$(git status --porcelain --untracked-files=all)"
test -z "$(git ls-files --others --ignored --exclude-standard -- IDEA2-AEGIS_Monitor)"
python3 deploy/idea2/h1-runtime/validate.py \
  --env-file "$H1_ENV_FILE" --source-sha "$H1_MONITOR_SOURCE_SHA"
sudo -n env -u DOCKER_HOST docker --host unix:///var/run/docker.sock compose --project-name aegis-h1-lab --env-file "$H1_ENV_FILE" \
  -f deploy/idea2/h1-runtime/compose.yml config --quiet
```

The N1 owner must also prove no lab containers/networks/volume exist, compare
current Production resource identity/counts with the accepted baseline, and
review image IDs and available disk/RAM against the N0 capacity gate. Abort on
any project/name/credential/image/port/volume mismatch, unavailable Docker
management, or changed Production baseline. Do not emit `docker compose config`
without `--quiet` in a log or terminal recording.

## Historical N1 execution contract (not re-run by N2/N3 work)

Only after a new explicit live approval and the read-only preflight PASS:

```sh
sudo -n env -u DOCKER_HOST docker --host unix:///var/run/docker.sock compose --project-name aegis-h1-lab --env-file "$H1_ENV_FILE" \
  -f deploy/idea2/h1-runtime/compose.yml up -d --build postgres migrate monitor
```

The health dependency is PostgreSQL healthy → migration exit 0 → Monitor
`/healthz` healthy. No service publishes a host port. The gateway profile is
never enabled. Inspect exact project labels, image IDs, health, lab database
name/role (not credentials), and Production identity before/after. For the
required second schema application, run the same migrator in the same project
under separate approval, then compare catalog/table/row-count evidence:

```sh
sudo -n env -u DOCKER_HOST docker --host unix:///var/run/docker.sock compose --project-name aegis-h1-lab --env-file "$H1_ENV_FILE" \
  -f deploy/idea2/h1-runtime/compose.yml run --rm migrate
```

The ordered runner applies `schema.sql` followed by migrations 001–004 with
`ON_ERROR_STOP=1`. A second run must exit 0 and preserve the expected schema
and rows; merely repeating the command without comparison is not acceptance.
N1 stops on any migration/health/identity instability. Do not seed accounts,
Nodes, camera registrations, DNS, TLS, tunnel, or Machine A runtime at N1.

## Exact rollback boundary

`python3 deploy/idea2/h1-runtime/cleanup.py` prints the project-specific plan
only; it never executes Docker commands. After capturing evidence, a separately
approved operator may stop/remove only `aegis-h1-lab` by the printed Compose
command. Removing `aegis-h1-lab_postgres_data` is a **separate irreversible
data-loss decision** after exact volume identity and evidence review. No
automatic `-v`, prune, Production project operation, or broad cleanup is
permitted. Recheck Production identity and resource counts after rollback.
For clarity, the separately approved project-only stop command in the reviewed
host mode is:

```sh
sudo -n env -u DOCKER_HOST docker --host unix:///var/run/docker.sock compose --project-name aegis-h1-lab --env-file "$H1_ENV_FILE" \
  -f deploy/idea2/h1-runtime/compose.yml down
```

## N2 — candidate DNS and trust (separate future live authorization)

N2 does **not** enable the gateway profile, build an image, publish 18443, or
perform browser/Requests live validation. The owner must separately review the
candidate DNS record `idea2-h1.aegis-lab.internal`, a non-Production public CA,
the single-SAN leaf certificate, and the owner-only leaf key path on the lab
host. The CA private key must remain outside the lab, Machine A, Git, evidence,
and logs. Never copy the leaf private key to Machine A. The existing managed
`AEGIS_AGENT_CA_BUNDLE` lifecycle is the Agent trust authority; ambient
`REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, HTTP fallback, and `verify=False` are
forbidden. Machine A platform trust is a separate public-CA-only review.

Before any live trust mutation, review ownership, path, expiry, and rollback of
the candidate DNS record, public CA and leaf, Windows trust entry, and managed
Agent bundle. With separately approved public CA/leaf/key paths, run the offline
validator on the lab host without printing PEM contents:

```sh
python3 deploy/idea2/h1-runtime/validate_n2_n3.py \
  --public-ca "$H1_PUBLIC_CA_PATH" \
  --leaf-cert "$H1_TLS_CERT_PATH" \
  --leaf-key "$H1_TLS_KEY_PATH"
```

This requires the reviewed Python `cryptography==50.0.1` dependency (already
pinned by the Identity Agent) in a separately managed validation environment;
do not install it into the host system implicitly. The helper prints only
public certificate fingerprints, SAN, issuer/subject, and validity. A failed
chain, cert/key mismatch, wrong/extra SAN, expired certificate, private key in
the public bundle, missing file, path under the repository or Production, or
untrusted/replaceable POSIX path aborts this offline crypto check. The command
does not inspect Machine A trust or the Agent's managed bundle: the Human Owner
must separately attest the approved public CA fingerprint at both trust paths,
and unmanaged trust sources abort N2. Evidence must include DNS authority,
public fingerprints, exact SAN and validity, public trust/bundle attestation, and
explicitly `N2_GATEWAY_STARTED=NO`, `N2_18443_LISTENER=NO`. N2 rollback removes
only separately proven task-owned DNS/trust/material; preserve shared trust
entries and all N1 lab data. `N2=PASS` does not prove HTTPS reachability.

## N3 — candidate gateway and live TLS/route evidence (separate authorization)

N3 is the first stage that may build/start the dedicated H1 gateway. The exact
approved host tuple is `192.168.10.10:18443`; `0.0.0.0`, `::`, `18078`, and
Production listeners are forbidden. The candidate browser origin and Agent
audience are `https://idea2-h1.aegis-lab.internal:18443`; the Agent base adds
`/agent`. N3 overlay inputs are explicit `H1_GATEWAY_SOURCE_SHA`,
`H1_GATEWAY_BIND_IPV4`, `H1_GATEWAY_HTTPS_PORT`, `H1_TLS_CERT_PATH`, and
`H1_TLS_KEY_PATH` in the owner-only external lab env file. The cert and key
mount read-only at `/run/aegis-h1-tls/tls.crt` and `.key`; the gateway joins
only `lab_ingress` and proxies only the project Monitor at `monitor:8002`.

After separate human approval, first prove the N1 containers/volume and
Production baseline unchanged, Monitor healthy, exact cert/key and bind paths,
source checkout clean, reviewed image digest/source, and no listener collision.
Immediately before the gateway-only start, rerun the certificate/path check
and compare its public fingerprints with the reviewed N2 evidence; if any path,
owner, parent permissions, or fingerprint changed, abort. The live start
procedure must be separately reviewed to avoid rebuilding or recreating N1
services and must verify their identities again afterward.
The read-only validator renders the two Compose files **in memory** and never
prints the secret-bearing JSON:

```sh
python3 deploy/idea2/h1-runtime/validate_n2_n3.py \
  --public-ca "$H1_PUBLIC_CA_PATH" \
  --leaf-cert "$H1_TLS_CERT_PATH" \
  --leaf-key "$H1_TLS_KEY_PATH" \
  --monitor-source-sha "$H1_MONITOR_SOURCE_SHA" \
  --gateway-source-sha "$H1_GATEWAY_SOURCE_SHA" \
  --env-file "$H1_ENV_FILE"
```

Only after that PASS and live authorization may the owner build the gateway
from the reviewed checkout, record its immutable image ID, and start **only**
`gateway` using the base plus `compose.n3.yml` and `--profile n3`. The host
uses the same sudo-noninteractive local Docker socket boundary as N1. The
approved N3 execution command must be reviewed separately; this repository
checkpoint does not run it. A later live N3 gate must check browser TLS and
Agent's actual Python Requests verification, wrong-host/wrong-CA/expired or
absent-bundle denial, exact allowed/denied route matrix, listener ownership,
lab Monitor upstream identity, canonical audience, and unchanged Production
gateway state. Offline crypto validation is not a substitute.

`python3 deploy/idea2/h1-runtime/cleanup_n3.py` prints gateway-only stop/remove
commands for review; it never executes. N3 rollback must preserve N1
PostgreSQL/Monitor, networks, and `aegis-h1-lab_postgres_data`; never run project
`down`, volume removal, or prune as part of gateway rollback.
