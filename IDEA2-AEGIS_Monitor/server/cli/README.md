# AEGIS Monitor (IDEA2) SSH-only administration

## Detection-node registration (`manage_nodes.py`)

The server-side registry separates Detection Node identity, globally unique
physical-camera identity, and logical camera aliases. Heartbeat data is
telemetry only and cannot register a node, move physical-camera authority, or
change alias policy.

Only an Ed25519 public key in canonical SubjectPublicKeyInfo PEM form is
accepted. Never copy a node private key to the Monitor host or pass private-key
material to this CLI.

```bash
python3 manage_nodes.py register \
  --node-id edge-node-new \
  --camera-id CAMERA-ALREADY-PROVISIONED \
  --public-key /secure/path/node-identity-public.pem

python3 manage_nodes.py list
python3 manage_nodes.py disable --node-id edge-node-new
python3 manage_nodes.py rotate-key \
  --node-id edge-node-new \
  --public-key /secure/path/replacement-public.pem

# Separate reviewed rollout action after the Agent proof path is verified.
python3 manage_nodes.py set-ingest-auth-mode \
  --node-id edge-node-new \
  --mode ed25519_required
```

`register` creates the node, a server-generated physical-camera identity, and
its initial logical-alias policy in one transaction. `list` prints only the
fingerprint and registration metadata; it does not print the stored public-key
payload. New registrations default to `legacy_shared_key`; migration 004 also
preserves that mode for existing rows. Changing one exact Node to
`ed25519_required` is a separate reviewed operational action and does not move
its physical camera or logical-alias policy. Apply migrations 001–004 through the reviewed deployment process
before using this CLI. These source tests do not authorize running migrations
or registration commands against Production.

Account policy remains independent from physical identity:

```bash
python3 manage_nodes.py reconcile-account-aliases \
  --node-id edge-node-a \
  --node-id edge-node-b \
  --account-alias operator=CAM-01 \
  --account-alias operator2=CAM-02 \
  --dry-run
```

Removing `--dry-run` is a separate reviewed administrative action. Changing
logical aliases must not change any node's physical-camera registration.

## Machine A Human Gate registration sequence

Original Task 15 prepares this sequence but does not execute it. Run it only in
an approved **non-Production** Monitor administration shell during Task 16,
after the Machine A service-identity DPAPI preflight and public-key export have
passed. `DATABASE_URL`, the approved Node ID, and the public-key export path are
`DISCOVER_AT_HUMAN_GATE`; provide them out-of-band and never paste the database
URL, password, token, or key contents into chat.

First run `list` and stop if the Node already exists unexpectedly. For one new
Machine A Node, use account alias mode so both accounts share the one
server-generated physical-camera identity:

```bash
python3 manage_nodes.py list
python3 manage_nodes.py register \
  --node-id "$NODE_ID" \
  --alias-mode account \
  --public-key "$PUBLIC_KEY_EXPORT"

python3 manage_nodes.py reconcile-account-aliases \
  --node-id "$NODE_ID" \
  --account-alias operator=CAM-01 \
  --account-alias operator2=CAM-02 \
  --dry-run

python3 manage_nodes.py reconcile-account-aliases \
  --node-id "$NODE_ID" \
  --account-alias operator=CAM-01 \
  --account-alias operator2=CAM-02

python3 manage_nodes.py set-ingest-auth-mode \
  --node-id "$NODE_ID" \
  --mode ed25519_required

python3 manage_nodes.py list

node --input-type=module -e "import { approvedStreamUrlForPhysicalCamera as approved } from '../auth/physicalStreamSource.js'; const id=Number(process.argv[1]); const url=approved(id,process.argv[2]); if(url!=='http://aegis-stream-host.internal:18077/stream.mjpg') process.exit(1); console.log('PHYSICAL_STREAM_SOURCE=PASS')" "$PHYSICAL_CAMERA_ID" "$NODE_ID"
```

Expected evidence is one active Node, one immutable physical-camera ID, key
version matching Machine A provisioning, `account` alias policy, both account
mappings, `ed25519_required`, and `PHYSICAL_STREAM_SOURCE=PASS` from the
server-owned `AEGIS_TRUSTED_PHYSICAL_STREAM_SOURCES` /
`AEGIS_MONITOR_STREAM_HOST` environment. The CLI prints only
fingerprint/registration metadata, never the private key. The public-key file
is safe evidence but its contents need not be returned to chat.

Abort before any write if the database is Production, the Node/public-key
fingerprint/key version is unexpected, CAM-01/CAM-02 or either active operator
is missing, or the dry-run fails. Heartbeat cannot create or change any row in
this authority model. Browser values cannot override it. Do not register a
second physical camera for `operator2`.

For a failed new-node rollout, preserve the Machine identity and disable only
the exact non-Production Node after Human Owner review:

```bash
python3 manage_nodes.py disable --node-id "$NODE_ID"
python3 manage_nodes.py list
```

Switching an existing strict Node back to `legacy_shared_key` is not automatic
rollback. It requires a separate owner decision and must not change Detector B
or any other Node. The CLI has no default key-destruction operation.

## Operator account provisioning (`manage_users.py`)

SSH-only CLI for creating `CCTV-Operator` and `SOC-Responder` accounts and
assigning cameras. This is the **only** supported way to provision real
IDEA2 accounts.

## Why a CLI instead of a web UI

Every write endpoint a web app exposes is attack surface: another route to
authorize correctly, another CSRF/session edge case, another thing that can
be probed from the internet-facing side of the gateway. IDEA2's own account
creation demo (`server/db/store.js`'s `addOperator`) already documents this
gap in its own comment — it issues a random password that is *never shown to
anyone*, because the in-app "Operators" screen was built for camera-routing
demos, not real credential issuance.

Provisioning a real, usable account needs a human to actually know the
password. Putting that behind a web form means either (a) accepting the
password over HTTP(S) from the browser — more exposure for a value that only
ever needs to exist in one admin's terminal — or (b) emailing/messaging it
through yet another integration. SSH access to the host is already the
trust boundary for this system (see `DESIGN.md` / `05 - Security
Architecture.md`); this script just uses that boundary directly instead of
building a new one.

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate   # optional but recommended
pip install -r requirements.txt
export DATABASE_URL=postgresql://aegis:<password>@localhost:5432/aegis_monitor
```

`DATABASE_URL` is the same variable the Node app uses (see
`../../.env.example` / root `docker-compose.yml`) — on the actual host,
copy it from there rather than retyping the password.

## Usage

```bash
# see what cameras exist and who has them today
python3 manage_users.py list-cameras

# create a CCTV-Operator and hand them CAM-05 + CAM-06 (interactive password)
python3 manage_users.py add-operator \
  --username m.reyes --display-name "M. Reyes" \
  --camera CAM-05 --camera CAM-06

# create a SOC-Responder (no cameras — they see everything)
python3 manage_users.py add-operator \
  --username soc.lead --display-name "SOC Lead" --role SOC-Responder

# review accounts
python3 manage_users.py list-operators
```

`add-operator` prompts for the password twice via `getpass` by default (never
echoed, never a CLI argument, never in shell history) and hashes it with
bcrypt (cost 12) before it ever reaches the database — the plaintext exists
only in the admin's terminal for the few seconds it takes to type it. The
account is created with `must_reset_password = TRUE` by default, so the
temporary password only has to work for one login; the user sets their own
password immediately after via `POST /api/password/reset`.

Reassigning a camera that's already assigned to someone else prompts for
confirmation unless you pass `--yes`. User creation + all camera assignments
happen in a single transaction — a bad camera id or a duplicate username
rolls the whole operation back, never a half-created account.

## Scripted local test-fixture provisioning

`--password-stdin` (read one line from stdin instead of an interactive
`getpass` prompt) and `--skip-force-reset` (don't set `must_reset_password`,
so the exact password you set works immediately) exist together for one
purpose: seeding a local test environment with known, deterministic
credentials so you can log in and exercise the UI/RBAC without also having
to drive the force-reset flow first.

```bash
echo 'CamOne#2026' | python3 manage_users.py add-operator \
  --username op_cam1 --display-name "Op Cam1" --role CCTV-Operator \
  --camera CAM-01 --password-stdin --skip-force-reset --yes
```

Both flags are opt-in and off by default — real provisioning (no flags) still
gets getpass + a mandatory reset. There's no `--password` flag and never
will be: accepting a password as a CLI argument puts it in shell history and
`ps`/`/proc/*/cmdline` for any other process on the box to read, which is
true whether the account is a test fixture or a real one. `--password-stdin`
narrows that exposure to "whatever piped it in," which is an acceptable
trade for a throwaway local test password but not for anything real —
don't reach for it outside test-fixture scripting.

IDEA2 has no `audit_log` table yet (unlike IDEA1 — see `../db/schema.sql`
vs. IDEA1's), so this script doesn't write one either; it prints a
`provisioned by <user>@<host> at <UTC time>` line so the admin's own SSH
session scrollback (or a bastion host's session recording, if you have one)
carries that record instead. Adding a real audit table for IDEA2 is a
bigger, separate architecture decision.
