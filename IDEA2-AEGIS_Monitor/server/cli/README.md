# manage_users.py — AEGIS Monitor (IDEA2) operator provisioning

SSH-only CLI for creating `CCTV-Operator` accounts and assigning cameras.
This is the **only** supported way to provision real IDEA2 accounts.

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

# create an operator and hand them CAM-05 + CAM-06
python3 manage_users.py add-operator \
  --username m.reyes --display-name "M. Reyes" \
  --camera CAM-05 --camera CAM-06

# review accounts
python3 manage_users.py list-operators
```

`add-operator` prompts for the password twice via `getpass` (never echoed,
never a CLI argument, never in shell history) and hashes it with bcrypt
(cost 12) before it ever reaches the database — the plaintext exists only in
the admin's terminal for the few seconds it takes to type it. The account is
created with `must_reset_password = TRUE`, so the temporary password only
has to work for one login; the operator sets their own password immediately
after via `POST /api/password/reset`.

Reassigning a camera that's already assigned to someone else prompts for
confirmation unless you pass `--yes`. User creation + all camera assignments
happen in a single transaction — a bad camera id or a duplicate username
rolls the whole operation back, never a half-created account.

## What this does *not* do

There's no `--password` flag and never will be — accepting a password as a
CLI argument puts it in shell history and `ps`/`/proc/*/cmdline` for any
other process on the box to read. If you need unattended/scripted
provisioning, that's a different threat model (secrets manager, not a
terminal prompt) and out of scope for this tool.

IDEA2 has no `audit_log` table yet (unlike IDEA1 — see `../db/schema.sql`
vs. IDEA1's), so this script doesn't write one either; it prints a
`provisioned by <user>@<host> at <UTC time>` line so the admin's own SSH
session scrollback (or a bastion host's session recording, if you have one)
carries that record instead. Adding a real audit table for IDEA2 is a
bigger, separate architecture decision.
