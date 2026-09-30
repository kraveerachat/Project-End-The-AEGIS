# H1 N1 persistent non-Production foundation

This is a repository-only candidate for the separately authorized N1 gate.
Nothing here proves that N1 has run. N0's disposable
`deploy/idea2/h1-capacity-probe.compose.yml` remains independent and unchanged.
The fixed Compose project is `aegis-h1-lab`; it must never be pointed at
`aegis-prod` or the Production database. N1 starts only `postgres`, `migrate`,
and `monitor`. `gateway` is a disabled N2-profile source placeholder, has no
host port or live TLS material, and must not be enabled at N1.

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

## Future N1 execution (NOT authorized by this repository checkpoint)

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
