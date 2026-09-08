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

### Running it on a host that needs a different Docker invocation

`PS6_DOCKER` overrides how Docker is called; it defaults to plain `docker` and is
split on whitespace, so a wrapper with its own arguments works. Every Docker call
in the suite goes through it.

This exists because a hardcoded `docker` fails on hosts where the invoking
account cannot reach the daemon, with a socket permission error that reads like a
harness bug. The AEGIS server host (`aegis-system`) is exactly that case: the
administrative account is **not** in the `docker` group, and `DOCKER_HOST` is set
to a Podman socket that does not exist — so both the privilege and the
environment must be corrected at the call site:

```bash
PS6_DOCKER="sudo env -u DOCKER_HOST docker" \
PUBLIC_SHARE_INTEGRATION_RUNTIME=1 \
  node --test --test-concurrency=1 --test-timeout=1800000 \
  tests/publicShareInternalIntegration.test.js
```

⚠️ On such a host the harness runs Docker as root. It still creates only its own
project, its own three networks and its own anonymous volumes, still publishes no
host port, and still tears down only `-p aegis-ps6-<pid>` — it never runs a bare
`compose down`, `system prune` or `volume prune`. Read the compose file before
granting it root.

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
| `PS6-INT-15` | the harness removes every container, network and volume it created |

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
teardown actually removed everything.
