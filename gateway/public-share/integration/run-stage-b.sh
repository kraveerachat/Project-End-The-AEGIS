#!/bin/sh
# PUBLIC-SHARE-6 Stage B runner — isolated PS6 harness on AEGIS server hardware.
# Keep this file LF-only: it is executed on the Linux host.
#
# Runs the SAME Stage A acceptance matrix on the server's hardware while touching
# no existing production service, data, network, runtime Compose, .env, migration
# or public ingress.
#
# ⚠️ IT REFUSES TO RUN unless every precondition below holds. Each guard exits
#    non-zero with a reason rather than "continuing carefully", because a Stage B
#    that half-runs on a production host is worse than one that does not start.
#
# ⚠️ WHAT IT NEVER DOES. No pull, no prune, no production container start, stop,
#    restart, recreate or exec. No production network attach or detach. No
#    production volume mount. No connection to Production PostgreSQL. No edit of
#    the runtime Compose file or Production .env. No migration against Production.
#    No host port. No ingress, DNS, TLS, NAT, tunnel, firewall or VLAN change.
#
# ⚠️ THE SOURCE SHA IS REQUIRED AND IS NOT DEFAULTED.
#    An earlier draft hardcoded the Stage A commit, which was wrong the moment
#    this file existed: that commit predates the PS6_DOCKER override and so
#    cannot run on this host at all. A pinned default would also always be one
#    commit stale, because adding it changes the branch head. Pass the SHA that
#    PR #105 actually points at when you run this, and the guard below verifies
#    the checkout really is that commit before anything is built.
#
# Usage (from a quiet window):
#   PS6_SOURCE_SHA=<PR #105 HEAD> sh run-stage-b.sh
#   sh run-stage-b.sh <PR #105 HEAD>
set -eu

PS6_SOURCE_SHA=${PS6_SOURCE_SHA:-${1:-}}
[ -n "$PS6_SOURCE_SHA" ] || {
  printf '\n[ps6-stage-b] REFUSING: no source SHA given.\n  Pass PR #105 HEAD, e.g.\n    PS6_SOURCE_SHA=<40-hex> sh run-stage-b.sh\n  Find it with: git ls-remote origin refs/heads/feat/idea1-public-share-internal-integration\n' >&2
  exit 2
}
case "$PS6_SOURCE_SHA" in
  *[!0-9a-f]*|"") printf '\n[ps6-stage-b] REFUSING: source SHA must be full 40-char lowercase hex\n' >&2; exit 2 ;;
esac
[ ${#PS6_SOURCE_SHA} -eq 40 ] || {
  printf '\n[ps6-stage-b] REFUSING: source SHA must be the full 40 characters, not abbreviated\n' >&2
  exit 2
}

PRODUCTION_CHECKOUT=/opt/aegis/Project-End-The-AEGIS
DOCKER="sudo env -u DOCKER_HOST docker"
REQUIRED_IMAGES="postgres:15-alpine node:20-alpine nginx:alpine"
PS6_NETWORKS="aegis_ps6_edge aegis_ps6_upstream aegis_ps6_data"
WORKDIR=${PS6_WORKDIR:-/tmp/ps6-stage-b}

say() { printf '\n[ps6-stage-b] %s\n' "$*"; }
die() { printf '\n[ps6-stage-b] REFUSING: %s\n' "$*" >&2; exit 1; }

# ── Guard 1 · the daemon is reachable the way this host requires ─────────────
say "guard 1 — Docker daemon"
$DOCKER version --format 'server {{.Server.Version}}' \
  || die "cannot reach the system Docker daemon through: $DOCKER"
$DOCKER compose version >/dev/null || die "docker compose plugin unavailable"

# ── Guard 2 · never build from, or even touch, the production checkout ───────
say "guard 2 — production checkout is off limits"
case "$WORKDIR" in
  "$PRODUCTION_CHECKOUT"|"$PRODUCTION_CHECKOUT"/*)
    die "PS6_WORKDIR is inside the production checkout" ;;
esac
[ -e "$WORKDIR" ] && die "$WORKDIR already exists — remove it or set PS6_WORKDIR"

# ── Guard 3 · the required base images are already present; never pull ───────
say "guard 3 — required base images already present"
for image in $REQUIRED_IMAGES; do
  $DOCKER image inspect "$image" >/dev/null 2>&1 \
    || die "$image is not present locally, and this runner never pulls"
  printf '  present: %s\n' "$image"
done

# ── Guard 4 · PS6 network names are free ─────────────────────────────────────
say "guard 4 — PS6 network names are free"
for net in $PS6_NETWORKS aegis_public_share; do
  if $DOCKER network inspect "$net" >/dev/null 2>&1; then
    die "$net already exists — this runner never adopts a network it did not create"
  fi
  printf '  absent: %s\n' "$net"
done

# ── Guard 5 · no subnet overlap with anything currently defined ──────────────
# PS6 declares 172.31.250.0/29, .251.0/29 and .252.0/29 explicitly, so a real
# overlap makes network creation fail rather than silently share. This check
# turns that late failure into an early, readable one.
say "guard 5 — subnet overlap"
for net in $($DOCKER network ls --format '{{.Name}}'); do
  for subnet in $($DOCKER network inspect "$net" --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}'); do
    case "$subnet" in
      172.31.250.*|172.31.251.*|172.31.252.*)
        die "network $net already uses $subnet, which PS6 needs" ;;
    esac
  done
done
echo "  no conflict with 172.31.250-252.0/29"

# ── Pre-state · recorded so the cleanup report can be checked against it ─────
say "pre-state — production inventory (read-only)"
PRE=$WORKDIR.pre
mkdir -p "$(dirname "$PRE")"
{
  echo "### containers"
  $DOCKER ps --format '{{.Names}}\t{{.Status}}'
  echo "### networks"
  $DOCKER network ls --format '{{.Name}}\t{{.Driver}}'
  echo "### volumes"
  $DOCKER volume ls --format '{{.Name}}'
  echo "### images"
  $DOCKER images --format '{{.Repository}}:{{.Tag}}\t{{.ID}}'
} > "$PRE"
cat "$PRE"

# ── Source · a temporary tree pinned to PR #105 HEAD, never production ───────
say "source — temporary worktree at $PS6_SOURCE_SHA"
git -C "$PRODUCTION_CHECKOUT" rev-parse HEAD >/dev/null 2>&1 \
  && echo "  production checkout left untouched at $(git -C "$PRODUCTION_CHECKOUT" rev-parse HEAD)"
git clone --no-checkout --quiet https://github.com/kraveerachat/Project-End-The-AEGIS.git "$WORKDIR"
git -C "$WORKDIR" fetch --quiet origin "$PS6_SOURCE_SHA"
git -C "$WORKDIR" checkout --quiet "$PS6_SOURCE_SHA"
ACTUAL=$(git -C "$WORKDIR" rev-parse HEAD)
[ "$ACTUAL" = "$PS6_SOURCE_SHA" ] || die "source SHA is $ACTUAL, expected $PS6_SOURCE_SHA"
echo "  verified source SHA: $ACTUAL"

# ── Dependencies · the runner needs the repo's own test dependencies ─────────
say "dependencies — npm ci in the temporary tree"
( cd "$WORKDIR/IDEA1-AEGIS_Drive_LC" && npm ci --no-audit --no-fund >/dev/null )

# ── Run · sequential, project-scoped, no host port, no production contact ────
# --test-concurrency=1 keeps the build and the transfers sequential rather than
# parallel, which is the approved build-load posture.
say "run — Stage B acceptance matrix"
cd "$WORKDIR/IDEA1-AEGIS_Drive_LC"
set +e
PS6_DOCKER="$DOCKER" PUBLIC_SHARE_INTEGRATION_RUNTIME=1 \
  node --test --test-concurrency=1 --test-timeout=1800000 \
  tests/publicShareInternalIntegration.test.js
RESULT=$?
set -e

# ── Post-state · prove nothing outside the harness moved ────────────────────
say "post-state — production inventory (read-only)"
POST=$WORKDIR.post
{
  echo "### containers"
  $DOCKER ps --format '{{.Names}}\t{{.Status}}'
  echo "### networks"
  $DOCKER network ls --format '{{.Name}}\t{{.Driver}}'
  echo "### volumes"
  $DOCKER volume ls --format '{{.Name}}'
  echo "### images"
  $DOCKER images --format '{{.Repository}}:{{.Tag}}\t{{.ID}}'
} > "$POST"

say "diff — pre vs post (empty means nothing outside the harness changed)"
diff "$PRE" "$POST" && echo "  IDENTICAL"

say "leftovers — PS6-owned objects that survived teardown (expect none)"
$DOCKER ps -a --filter 'label=com.docker.compose.project' --format '{{.Names}}' | grep -i 'aegis-ps6' || echo "  no PS6 container"
$DOCKER network ls --format '{{.Name}}' | grep -E 'aegis_ps6_' || echo "  no PS6 network"

say "temporary source — removing $WORKDIR"
rm -rf "$WORKDIR"
echo "  removed"

say "done — acceptance exit code $RESULT"
echo "Production migration 009 and the Public UI flag were NOT read by this"
echo "runner: doing so would require connecting to Production PostgreSQL or"
echo "reading Production configuration, both of which are out of scope. Their"
echo "state is unchanged because nothing here writes to them — see the pre/post"
echo "diff above and the topology guards."
exit $RESULT
