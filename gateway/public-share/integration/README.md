# PUBLIC-SHARE-6 · internal integration harness

An isolated Docker stack that puts the **real** Public Share Gateway in front of
the **real** AEGIS Drive application on a **real** PostgreSQL 15 database, so the
gateway↔Drive contract can be measured instead of assumed.

It is driven by `IDEA1-AEGIS_Drive_LC/tests/publicShareInternalIntegration.test.js`.

```bash
cd IDEA1-AEGIS_Drive_LC
PUBLIC_SHARE_INTEGRATION_RUNTIME=1 node --test --test-concurrency=1 \
  --test-timeout=1800000 tests/publicShareInternalIntegration.test.js
```

Without `PUBLIC_SHARE_INTEGRATION_RUNTIME=1` the suite skips, so `npm test` never
builds an image or touches Docker implicitly.

### Three environment variables the suite understands

| Variable | Default | What it does |
| :--- | :--- | :--- |
| `PS6_DOCKER` | `docker` | how Docker is invoked; split on whitespace, so a wrapper with its own arguments works |
| `PS6_PROJECT` | `aegis-ps6-<pid>` | the Compose project the run owns; must match `^aegis-ps6-[a-z0-9][a-z0-9_-]*$` |
| `PS6_COMPOSE_ENV_FILE` | *(unset)* | an owned file the suite writes its four throwaway Compose interpolation values into, and passes to every `docker compose` as `--env-file` |

**`PS6_DOCKER`** exists because a hardcoded `docker` fails on hosts where the
invoking account cannot reach the daemon, with a socket permission error that
reads like a harness bug. The AEGIS server host (`aegis-system`) is exactly that
case: the administrative account is **not** in the `docker` group, and
`DOCKER_HOST` is set to a Podman socket that does not exist — so both the
privilege and the environment must be corrected at the call site. Every Docker
call in the suite goes through it; nothing invokes `docker` directly.

**`PS6_PROJECT`** exists because the *caller* has to be able to know the project
name. A `process.pid` chosen inside the test process is unknowable to the script
that launched it, so a runner could not clean up after a crashed run — and a
runner that guessed would be guessing about `docker compose down`, which is the
one place a wrong guess is expensive. With `PS6_PROJECT` the Stage B runner mints
the identifier before anything exists, passes it in, and owns it for the whole
run.

The `aegis-ps6-` prefix is **enforced, not conventional**. Every teardown in the
suite and in the runner is `-p "$PS6_PROJECT"`-scoped, so the prefix is what makes
it structurally impossible to aim that teardown at a production project — by
typo, by an inherited environment variable, or by a caller that meant well. An
invalid value throws immediately rather than surfacing later as a confusing
Compose error.

**`PS6_COMPOSE_ENV_FILE`** exists because **Stage B attempt #1 failed on exactly
its absence.** `docker-compose.yml` interpolates four variables:

```
PS6_SUPER_USER   PS6_SUPER_PASSWORD   PS6_DRIVE_DB_PASSWORD   PS6_SESSION_SECRET
```

The suite generates all four as throwaway random values in its own child
environment. That environment does **not** cross a `sudo` boundary — sudo
correctly refuses to carry arbitrary variables — so on the server host Compose
saw none of them and refused to start:

```
error while interpolating services.postgres.environment.POSTGRES_USER:
required variable PS6_SUPER_USER is missing a value
```

That is a harness credential-plumbing defect, **not** a product defect.

⚠️ **It is not fixed by weakening the privilege boundary.** There is no `sudo -E`,
no `--preserve-env`, no sudoers `env_keep` entry, no docker-group membership, no
passwordless sudo and no global environment change anywhere in this harness. The
boundary is exactly what it was: `sudo -n env -u DOCKER_HOST docker`.

Instead the plumbing is explicit. When `PS6_COMPOSE_ENV_FILE` is set, the suite
writes **only** those four values to that path at mode `0600` before the first
Compose invocation, and every Compose call becomes

```
docker compose --env-file <path> -p <project> -f <file> …
```

`--env-file` is a **top-level** Compose flag and must come before `-p` and `-f`
and before the subcommand; after the subcommand it is a different, service-scoped
flag that supplies no interpolation. A path survives `sudo` because it is an
argument, not an environment variable.

The path must be absolute and, when `PS6_WORKDIR` is set, inside it — the file
holds secrets and the caller's cleanup is what removes it, so a path outside that
directory would outlive the run. An invalid value throws at module load.

**Unset is the developer-machine path and is unchanged**: no file is written, no
`--env-file` is passed, and Compose reads the four values from the inherited
child environment exactly as before.

```bash
PS6_DOCKER="sudo -n env -u DOCKER_HOST docker" \
PS6_PROJECT="aegis-ps6-stage-b-20260908-120000" \
PS6_WORKDIR="/tmp/aegis-ps6-stage-b-20260908-120000" \
PS6_COMPOSE_ENV_FILE="/tmp/aegis-ps6-stage-b-20260908-120000/evidence/compose.env" \
PUBLIC_SHARE_INTEGRATION_RUNTIME=1 \
  node --test --test-concurrency=1 --test-timeout=1800000 \
  tests/publicShareInternalIntegration.test.js
```

`run-stage-b.sh` sets all four for you; the block above is what it does.

⚠️ On such a host the harness runs Docker as root. It still creates only its own
project, its own three networks and its own anonymous volumes, still publishes no
host port, and still tears down only `-p "$PS6_PROJECT"` — it never runs a bare
`compose down`, `system prune`, `image prune`, `volume prune` or `builder prune`.
Read the compose file before granting it root.

---

## Stage B: running it on the AEGIS server host

`run-stage-b.sh` is the only supported way to run this harness on the server. It
is not a convenience wrapper; it is the set of refusals.

```bash
sudo -v                                    # the OWNER runs this, by hand
PS6_SOURCE_SHA=<PR #105 HEAD> sh run-stage-b.sh 2>&1 | tee ps6-stage-b.log
```

### Privilege model — owner-mediated, non-interactive, fail-closed

The runner **never** prompts for a credential and never asks for, captures,
stores or echoes one. It uses `sudo -n` exclusively:

- the owner establishes the sudo timestamp by hand with `sudo -v` beforehand;
- every Docker child process is `sudo -n env -u DOCKER_HOST docker …`, so a
  `sudo` password prompt can never appear inside a Node `execFile`/`spawn` where
  nothing would be able to answer it;
- if `sudo -n` is not already authorised the runner **refuses to start**;
- if authorisation lapses mid-run the runner **fails closed** — it performs the
  cleanup that is still possible, prints the exact commands the owner must run by
  hand, and stops rather than retrying in a way that could prompt;
- an optional bounded keepalive (`sudo -n -v`, capped by
  `PS6_SUDO_KEEPALIVE_MAX_SECONDS`, default 5400 s) only refreshes a timestamp
  that already exists — `-n` cannot create one — and is killed by the cleanup
  trap.

Nothing in the runner modifies sudoers, group membership, `DOCKER_HOST` outside
its own child processes, or any Docker/Podman service.

### What the runner owns, and the cleanup trap

An `EXIT`/`INT`/`TERM` trap is armed **before** anything is created, so an
interrupt at any point still tears down exactly what exists. It may remove only:

1. the one Compose project `$PS6_PROJECT`;
2. the three PS6-created networks;
3. the project's anonymous volumes;
4. the images the project *built* — via `down --rmi local`, which is Compose's
   own scoping: `postgres:15-alpine` and `node:20-alpine` carry an explicit
   `image:` key and are therefore a custom tag, which `local` never removes;
5. the one temporary directory `/tmp/$PS6_PROJECT/`, which holds **both** the
   pinned source tree and all evidence files — including the one Compose env
   file, `/tmp/$PS6_PROJECT/evidence/compose.env`.

It never touches `aegis-prod`, a production network, `aegis_postgres_data`,
`aegis_drive_storage`, a production image, or any unrelated Docker object, and
there is no `prune` of any kind anywhere in the file.

Point 5 is a fix, not a restatement: an earlier draft wrote `$WORKDIR.pre` and
`$WORKDIR.post` as *siblings* of the work directory, so they survived the very
`rm -rf` that was supposed to clean up after the run.

### The Compose env file

One file, `/tmp/$PS6_PROJECT/evidence/compose.env`:

- created **empty and `0600`** by the runner before the suite starts (`umask 077`,
  then an explicit `chmod`, then a verified `stat`), so there is never a window at
  a wider mode;
- written by the suite with the four throwaway interpolation values and nothing
  else — never a Production credential, because the suite reads no `.env` and
  generates every value with `randomBytes`;
- **never printed.** The runner echoes the path and the mode; nothing anywhere
  reads, `cat`s, sources or logs the contents, and the suite's own error paths
  carry key names only;
- never committed — it only ever exists under `/tmp/$PS6_PROJECT/`;
- removed by the existing cleanup trap, explicitly by name and then with the
  directory, on success, on failure, and on `INT`/`TERM`. A post-run check fails
  the run if it survives.

**The runner's own teardown uses the same file**:

```
docker compose --env-file "$PS6_COMPOSE_ENV_FILE" -p "$PS6_PROJECT" -f "$COMPOSE_FILE" down …
```

Without it, cleanup would fail interpolation for exactly the reason attempt #1
did, and would tear nothing down. If the file is missing or empty — a run that
died before the suite could write it — that project-scoped `down` is **skipped**,
because it could only fail, and the label-scoped sweeps do the teardown instead:
containers, volumes and networks by `com.docker.compose.project=$PS6_PROJECT`, and
images by the `$PS6_PROJECT-` repository prefix with an explicit refusal for base
images and anything matching `aegis-prod`/`aegis_prod`. That path needs no
interpolation at all and is still fail-closed.

**Guard 8** refuses a pinned source tree whose acceptance suite does not read
`PS6_COMPOSE_ENV_FILE`, for the same reason guard 7 refuses one that does not read
`PS6_PROJECT`: such a tree would get exactly as far as attempt #1 did, on a
production host, before anyone found out.

### Pre/post inventory: stable identity, not human strings

The runner does **not** diff `docker ps --format '{{.Status}}'`. That prints
`Up 4 days (healthy)` — a human string whose uptime advances between the two
snapshots, so the diff is guaranteed to differ for reasons that mean nothing.

What it captures for every container outside its own project is stable identity:

| Field | Source |
| :--- | :--- |
| container name | `{{.Name}}` |
| container ID | `{{.Id}}` |
| image ID | `{{.Image}}` |
| Compose project | `com.docker.compose.project` label |
| running state | `{{.State.Running}}` |
| health state | `{{.State.Health.Status}}`, or `none` |
| network attachments | every network name and IP |

plus every network (ID, name, driver, scope), volume and image outside the
project. After cleanup those snapshots must be **identical**, every production
service must still report a healthy state, `aegis_postgres_data` and
`aegis_drive_storage` must still exist, every image the project built must be
gone *by ID*, every base image must still be present, and nothing may match
`/tmp/aegis-ps6-*`.

### No host-side `npm ci`

The acceptance suite imports `node:test`, `node:assert`, `node:child_process`,
`node:crypto`, `node:fs/promises`, `node:url` and `node:util` — Node built-ins,
every one. It loads nothing from `node_modules`, so the host-side `npm ci` an
earlier draft ran installed roughly a thousand packages the run never touched.
Removing it deletes a whole class of host mutation, removes the audit noise, and
*shrinks* the Drive build context, because this repository ships no
`.dockerignore` for `IDEA1-AEGIS_Drive_LC` and a populated `node_modules` would
otherwise be uploaded to the daemon on every build.

⚠️ The Drive image is unaffected. It is still built from the shipped
`IDEA1-AEGIS_Drive_LC/Dockerfile`, which runs its own `npm ci` inside the build
stage. No Dockerfile was modified to make this possible.

---

## Why it exists

PUBLIC-SHARE-3's harness proves the gateway *configuration* against a
purpose-built recorder. PUBLIC-SHARE-5 proves the security *matrix* against the
Express app in-process, with a local TCP hop standing in for the gateway. Both
said the same thing about what they left undone:

> No test in this repository yet puts the real gateway in front of the real
> Drive — that is exactly PUBLIC-SHARE-6's job.

This harness is that job. Every assertion in the suite crosses a real nginx
container into a real Node application over a real network.

---

## Topology

```text
recipient ──edge──▶ gateway ──upstream──▶ drive ──data──▶ postgres
172.31.250.3      .250.2 / .251.2       172.31.251.3     172.31.252.2
```

Three networks rather than one, because the interesting claim is negative. The
recipient sits **only** on the edge network, so "a recipient cannot reach Drive
except through the gateway" is enforced by Docker and can be probed. PUBLIC-SHARE-3
could not make that claim: there, the client *was* the upstream.

Every network is `internal: true` **and** `gateway_mode_ipv4: isolated`. Both are
required and neither is redundant:

| Control | Removes |
| :--- | :--- |
| `internal: true` | the default route — no Internet, no external connectivity |
| `gateway_mode_ipv4: isolated` | the Docker-host bridge address, which an ordinary internal bridge keeps and through which host services stay reachable |

Consequently **no host port exists anywhere in the stack**, and every request is
generated from inside the topology by the member that should generate it. The
gateway being dual-homed does not weaken B5 (*Gateway → everything else =
nothing*): both of its networks are internal and isolated, so it has no Internet
path, no host path and no route to PostgreSQL. Reaching its one upstream is what
a gateway is for.

The gateway image is built from `../Dockerfile` with `../nginx.conf.template`
unchanged — the build context is the parent directory on purpose, so this harness
cannot quietly test a modified gateway.

---

## The database starts deliberately old

`db-init/00-aegis-drive.sh` applies `schema.sql` and `seed.sql`, then **rolls the
`shares.scope` CHECK back to its pre-009 (008-era) definition** and leaves
migration 009 unapplied.

That is not a quirk; it is the point. `schema.sql` already carries `public`, so a
database built straight from it would make migration 009 a no-op and the evidence
for it worthless. Production is not a fresh `schema.sql` database — it is an
008-era database — so the only honest rehearsal is against that shape. The suite
then observes the before state, applies the real migration file, and observes the
after state, including that the scoped `drive_app` role **cannot** apply it.

---

## What it proves

| ID | Claim |
| :--- | :--- |
| `PS6-INT-1` | three internal isolated networks, exact membership, no host port |
| `PS6-INT-2` | the recipient reaches the gateway and nothing else |
| `PS6-INT-3` | migration 009 is load-bearing on a real 008-era database, is re-runnable, and is refused to `drive_app` |
| `PS6-INT-4` | the private path uploads 64 MiB and mints a public share whose URL survives a poisoned `Host` |
| `PS6-INT-5` | password page, wrong password, correct password, exact length, exact SHA-256, delivery headers, one hit |
| `PS6-INT-6` | a slow client with a 75s stall still receives every byte |
| `PS6-INT-7` | an interrupted transfer harms neither tier, and a later redemption is intact |
| `PS6-INT-8` | four concurrent downloads all complete intact, counting one hit each |
| `PS6-INT-9` | no AEGIS surface but `/s/:token` is reachable, and refusals never reach the application |
| `PS6-INT-10` | forged forwarding headers cannot move the attributed source |
| `PS6-INT-11` | an unknown `Host` terminates at the gateway |
| `PS6-INT-12` | the ingress split holds in both directions |
| `PS6-INT-13` | B5: the gateway reaches its upstream and nothing else; logs leak no token, password or address |
| `PS6-INT-14` | revocation propagates through the gateway immediately |
| `PS6-INT-15` | the harness removes every container, network and volume it created, and removes no shared base image |

`PS6-INT-6` is the one worth understanding. With `proxy_buffering off` the gateway
stops reading from Drive while the recipient is not draining, so a single 75s
client stall lands directly on `proxy_read_timeout` and `send_timeout` — whose
nginx defaults are 60s. It passes only because the shipped template raises both
to 300s. Lower them and this test fails, which is what makes it a measurement
rather than a delay.

---

## What it does **not** prove

**Public Internet Share remains NOT IMPLEMENTED.** This is *internal*
integration:

- no ingress method is chosen — **G4 is open**;
- nothing is exposed to the Internet — **G5 is open**;
- the feature is not complete — **G6 is open**;
- there is no TLS, no DNS, no NAT, no tunnel, no public hostname;
- a "recipient" here is a container on an isolated Docker network, **not** someone
  on ordinary Internet access. That is PUBLIC-SHARE-7;
- nothing in Production is contacted, restarted, migrated or read.

---

## Safety

The stack owns its project name, its three networks, its containers and its
anonymous volumes. It generates throwaway credentials per run, reads no `.env`,
mounts no Production path (the only mounts are read-only copies of the
repository's own SQL), declares no named volume, and publishes no host port. The
suite refuses to start if any of its three network names already exists, so it can
never adopt or delete a network it did not create, and `PS6-INT-15` asserts the
teardown actually removed everything — every container, every network, every
project-labelled volume — while the shared base images are still present.
