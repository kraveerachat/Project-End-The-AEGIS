#!/usr/bin/env python3
"""AEGIS Monitor (IDEA2) — SSH-only operator provisioning CLI.

Why this exists (see server/cli/README.md for the full write-up):
  IDEA2 deliberately has no in-app "create operator" UI surface for real
  account provisioning — every additional web-exposed write endpoint is
  attack surface an SME's edge box doesn't need. Provisioning instead
  happens here: an admin with SSH access to the host runs this script
  directly against the `aegis_monitor` Postgres database. No new port,
  no new web route, no new session/CSRF surface to defend.

What it does:
  add-operator     Create a CCTV-Operator or SOC-Responder account (--role,
                    default CCTV-Operator) with a bcrypt-hashed password and
                    assign it zero or more cameras in `camera_assignment`.
                    Password is entered interactively via getpass by default
                    — never as a CLI argument (shell history / `ps` would
                    leak it) — or piped via --password-stdin for scripted
                    local test-fixture setup (see that flag's help text).
  list-cameras      Read-only: camera ids + who they're currently assigned to.
  list-operators    Read-only: existing CCTV-Operator / SOC-Responder accounts.

Connection:
  Reads DATABASE_URL from the environment (same variable the Node app uses,
  see docker-compose.yml / .env.example) — never hardcode credentials, and
  never pass them as a CLI argument (shell history, `ps`, /proc/*/cmdline
  would all leak them).

    export DATABASE_URL=postgresql://aegis:<password>@localhost:5432/aegis_monitor
    python server/cli/manage_users.py add-operator \\
        --username m.reyes --display-name "M. Reyes" --camera CAM-05

    # scripted local test fixture, known password, immediately usable:
    echo 'CamOne#2026' | python server/cli/manage_users.py add-operator \\
        --username op_cam1 --display-name "Op Cam1" --role CCTV-Operator \\
        --camera CAM-01 --password-stdin --skip-force-reset --yes
"""
from __future__ import annotations

import argparse
import getpass
import os
import re
import socket
import sys
from datetime import datetime, timezone

import bcrypt
import psycopg2
import psycopg2.extras

USERNAME_RE = re.compile(r"^[a-z][a-z0-9._-]{2,39}$")
MIN_PASSWORD_LENGTH = 12
BCRYPT_COST = 12


def die(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def connect():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        die(
            "DATABASE_URL is not set. Export it before running this script, e.g.\n"
            "  export DATABASE_URL=postgresql://aegis:<password>@localhost:5432/aegis_monitor"
        )
    try:
        return psycopg2.connect(dsn)
    except psycopg2.OperationalError as e:
        die(f"could not connect to the database: {e}")


def read_new_password() -> str:
    """getpass only — never accepted as a CLI arg (shell history / process list)."""
    while True:
        pw1 = getpass.getpass(f"Temporary password for the new account (min {MIN_PASSWORD_LENGTH} chars): ")
        if len(pw1) < MIN_PASSWORD_LENGTH:
            print(f"  too short — need at least {MIN_PASSWORD_LENGTH} characters", file=sys.stderr)
            continue
        if len(pw1.encode("utf-8")) > 72:
            # bcrypt silently truncates beyond 72 bytes — fail loudly instead
            print("  too long — bcrypt supports at most 72 bytes", file=sys.stderr)
            continue
        pw2 = getpass.getpass("Confirm: ")
        if pw1 != pw2:
            print("  did not match — try again", file=sys.stderr)
            continue
        return pw1


def read_password_from_stdin() -> str:
    """--password-stdin path: one line off stdin, no confirmation prompt.

    This exists for scripted local test-fixture provisioning (a known password
    piped in from a setup script) — it is NOT a substitute for getpass in any
    interactive/production use. A piped value never gets the "type it twice"
    typo check a human gets, and depending on the caller it may end up in that
    caller's own shell history — that risk is the caller's to own, not this
    script's, which is why this path requires the explicit --password-stdin flag.
    """
    line = sys.stdin.readline()
    if not line:
        die("--password-stdin was set but stdin was empty")
    pw = line.rstrip("\n")
    if len(pw) < MIN_PASSWORD_LENGTH:
        die(f"piped password is shorter than {MIN_PASSWORD_LENGTH} characters")
    if len(pw.encode("utf-8")) > 72:
        die("piped password exceeds bcrypt's 72-byte limit")
    return pw


def actor_label() -> str:
    """Best-effort 'who ran this' line for the SSH session's own terminal/scroll-back.

    IDEA2 has no audit_log table today (unlike IDEA1 — see schema.sql) — that's a
    larger, separate architecture decision. Until that lands, the accountability
    trail for CLI-driven provisioning is the admin's own SSH session log (bastion
    host recording, `script`/`tee`, or shell history with timestamps), not this
    tool. Printing the actor here just makes that scrollback self-describing.
    """
    try:
        user = os.getlogin()
    except OSError:
        user = os.environ.get("USER") or os.environ.get("USERNAME") or "unknown"
    host = socket.gethostname()
    at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return f"{user}@{host} at {at}"


def cmd_list_cameras(args: argparse.Namespace) -> None:
    conn = connect()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT c.id, c.name, c.zone, c.online,
                       a.user_id, u.username AS assigned_username
                  FROM cameras c
                  LEFT JOIN camera_assignment a ON a.camera_id = c.id
                  LEFT JOIN users u ON u.id = a.user_id
                 ORDER BY c.id
                """
            )
            rows = cur.fetchall()
    finally:
        conn.close()

    if not rows:
        print("(no cameras found)")
        return
    # camera_assignment.user_id → users.id is ON DELETE CASCADE, so a NULL here
    # always means "no operator assigned" (explicit SOC-Team route or no row at
    # all) — never a dangling reference; the Node app's resolveRoute() treats
    # both the same way (see server/db/store.js)
    print(f"{'CAMERA':<10} {'ZONE':<12} {'ONLINE':<8} ASSIGNED TO")
    for r in rows:
        assignee = r["assigned_username"] or "SOC-Team"
        print(f"{r['id']:<10} {r['zone']:<12} {str(r['online']):<8} {assignee}")


def cmd_list_operators(args: argparse.Namespace) -> None:
    conn = connect()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT username, display_name, role, active, must_reset_password, created_at
                  FROM users
                 ORDER BY created_at
                """
            )
            rows = cur.fetchall()
    finally:
        conn.close()

    if not rows:
        print("(no users found)")
        return
    print(f"{'USERNAME':<20} {'ROLE':<16} {'ACTIVE':<8} {'MUST RESET':<11} DISPLAY NAME")
    for r in rows:
        print(
            f"{r['username']:<20} {r['role']:<16} {str(r['active']):<8} "
            f"{str(r['must_reset_password']):<11} {r['display_name']}"
        )


def cmd_add_operator(args: argparse.Namespace) -> None:
    username = args.username.strip().lower()
    display_name = args.display_name.strip()
    cameras = list(dict.fromkeys(args.camera or []))  # de-dupe, preserve order

    if not USERNAME_RE.match(username):
        die("username must be lowercase, start with a letter, and use only a-z 0-9 . _ - (3-40 chars)")
    if not display_name or len(display_name) > 80:
        die("display name is required and must be at most 80 characters")

    password = read_password_from_stdin() if args.password_stdin else read_new_password()
    password_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=BCRYPT_COST)).decode("ascii")
    del password
    must_reset = not args.skip_force_reset

    conn = connect()
    try:
        conn.autocommit = False
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT 1 FROM users WHERE lower(username) = %s", (username,))
            if cur.fetchone():
                die(f"username '{username}' already exists")

            if cameras:
                cur.execute("SELECT id FROM cameras WHERE id = ANY(%s)", (cameras,))
                found = {row["id"] for row in cur.fetchall()}
                missing = [c for c in cameras if c not in found]
                if missing:
                    die(f"unknown camera id(s): {', '.join(missing)} — see `list-cameras`")

                # warn (and require confirmation) before silently taking a camera
                # away from whoever currently has it — camera_assignment.camera_id
                # is the primary key, so a camera can only ever have one assignee
                cur.execute(
                    """
                    SELECT a.camera_id, u.username
                      FROM camera_assignment a
                      LEFT JOIN users u ON u.id = a.user_id
                     WHERE a.camera_id = ANY(%s) AND a.user_id IS NOT NULL
                    """,
                    (cameras,),
                )
                taken = cur.fetchall()
                if taken and not args.yes:
                    for row in taken:
                        print(
                            f"warning: {row['camera_id']} is currently assigned to "
                            f"'{row['username']}' — this will reassign it to '{username}'",
                            file=sys.stderr,
                        )
                    reply = input("Proceed with reassignment? [y/N] ").strip().lower()
                    if reply != "y":
                        die("aborted — no changes made")

            cur.execute(
                """
                INSERT INTO users (username, password_hash, role, display_name, active, must_reset_password)
                VALUES (%s, %s, %s, %s, TRUE, %s)
                RETURNING id
                """,
                (username, password_hash, args.role, display_name, must_reset),
            )
            user_id = cur.fetchone()["id"]

            for camera_id in cameras:
                cur.execute(
                    """
                    INSERT INTO camera_assignment (camera_id, user_id, assigned_at)
                    VALUES (%s, %s, now())
                    ON CONFLICT (camera_id) DO UPDATE SET user_id = EXCLUDED.user_id, assigned_at = now()
                    """,
                    (camera_id, user_id),
                )

        conn.commit()
    except psycopg2.Error as e:
        conn.rollback()
        die(f"database error, rolled back — no changes were made: {e}")
    finally:
        conn.close()

    reset_note = "must reset password on first login" if must_reset else "password is usable as-is (--skip-force-reset)"
    print(f"✓ created {args.role} '{username}' (id={user_id}), {reset_note}")
    if cameras:
        print(f"✓ assigned cameras: {', '.join(cameras)}")
    elif args.role == "CCTV-Operator":
        print("  no cameras assigned yet — this operator has no Scoped View until you assign one")
    print(f"  provisioned by {actor_label()}")
    if not args.password_stdin:
        print(
            "\nHand the password to the user out-of-band (in person, secure chat) — it was never "
            "written to disk, logged, or stored anywhere but their own memory just now."
        )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="AEGIS Monitor (IDEA2) — SSH-only operator provisioning CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_add = sub.add_parser("add-operator", help="create a CCTV-Operator/SOC-Responder and assign cameras")
    p_add.add_argument("--username", required=True, help="lowercase, e.g. m.reyes")
    p_add.add_argument("--display-name", required=True, help="e.g. 'M. Reyes'")
    p_add.add_argument(
        "--role", choices=["CCTV-Operator", "SOC-Responder"], default="CCTV-Operator",
        help="account role (default: CCTV-Operator)",
    )
    p_add.add_argument(
        "--camera", action="append", metavar="CAM-ID",
        help="camera id to assign (repeatable, e.g. --camera CAM-05 --camera CAM-06)",
    )
    p_add.add_argument("--yes", "-y", action="store_true", help="skip the reassignment confirmation prompt")
    p_add.add_argument(
        "--password-stdin", action="store_true",
        help="read the password from stdin instead of an interactive getpass prompt — "
             "for scripted local test-fixture setup only, see module docstring",
    )
    p_add.add_argument(
        "--skip-force-reset", action="store_true",
        help="do NOT set must_reset_password — the account can log in with this exact password "
             "immediately. For local test fixtures with a known password; never for real provisioning",
    )
    p_add.set_defaults(func=cmd_add_operator)

    p_lc = sub.add_parser("list-cameras", help="list cameras and their current assignment")
    p_lc.set_defaults(func=cmd_list_cameras)

    p_lo = sub.add_parser("list-operators", help="list existing accounts")
    p_lo.set_defaults(func=cmd_list_operators)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
