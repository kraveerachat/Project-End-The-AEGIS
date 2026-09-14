#!/usr/bin/env python3
"""SSH/admin-only provisioning for IDEA2 detection-node registrations."""
from __future__ import annotations

import argparse
import base64
import hashlib
import os
import pathlib
import re
import sys
from collections.abc import Mapping

import psycopg2
import psycopg2.extras
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def die(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def validate_identifier(value: str, label: str) -> str:
    value = str(value).strip()
    if not IDENTIFIER_RE.fullmatch(value):
        raise ValueError(
            f"{label} must be 1-64 characters using only letters, digits, '.', '_' or '-'"
        )
    return value


def parse_account_alias(value: str) -> tuple[str, str]:
    username, separator, camera_id = str(value).partition("=")
    if not separator or "=" in camera_id:
        raise ValueError("account alias must use USERNAME=CAMERA_ID")
    return (
        validate_identifier(username, "username").lower(),
        validate_identifier(camera_id, "camera id"),
    )


def _normalize_reconciliation_inputs(
    node_ids,
    account_aliases,
) -> tuple[tuple[str, ...], tuple[tuple[str, str], ...]]:
    normalized_nodes = tuple(validate_identifier(node_id, "node id") for node_id in node_ids)
    if not normalized_nodes:
        raise ValueError("at least one node id is required")
    if len(set(normalized_nodes)) != len(normalized_nodes):
        raise ValueError("node ids must be unique")

    normalized_aliases = tuple(
        (
            validate_identifier(username, "username").lower(),
            validate_identifier(camera_id, "camera id"),
        )
        for username, camera_id in account_aliases
    )
    if not normalized_aliases:
        raise ValueError("at least one account alias is required")
    usernames = tuple(username for username, _camera_id in normalized_aliases)
    if len(set(usernames)) != len(usernames):
        raise ValueError("account alias usernames must be unique")
    return normalized_nodes, normalized_aliases


def load_public_key(path: pathlib.Path) -> tuple[str, str]:
    """Load only an Ed25519 SubjectPublicKeyInfo PEM and fingerprint raw bytes."""
    payload = path.read_bytes()
    normalized = payload.replace(b"\r\n", b"\n")
    if not normalized.startswith(b"-----BEGIN PUBLIC KEY-----\n"):
        raise ValueError("key file must contain an Ed25519 public key in PEM SPKI format")
    try:
        key = serialization.load_pem_public_key(normalized)
    except (TypeError, ValueError) as exc:
        raise ValueError("key file is not a valid public PEM") from exc
    if not isinstance(key, Ed25519PublicKey):
        raise ValueError("public key must be Ed25519")
    raw = key.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    if len(raw) != 32:
        raise ValueError("Ed25519 public key must be exactly 32 bytes")
    canonical = key.public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    if normalized != canonical:
        raise ValueError("key file must contain exactly one canonical public PEM block")
    digest = hashlib.sha256(raw).digest()
    fingerprint = "SHA256:" + base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return canonical.decode("ascii"), fingerprint


def connect():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        die("DATABASE_URL is not set")
    try:
        return psycopg2.connect(dsn)
    except psycopg2.OperationalError as exc:
        die(f"could not connect to the database: {exc}")


def print_nodes(rows) -> None:
    if not rows:
        print("(no detection nodes found)")
        return
    print(
        f"{'NODE':<24} {'PHYSICAL':<10} {'POLICY':<9} {'CAMERA':<12} "
        f"{'VERSION':<9} {'ACTIVE':<8} FINGERPRINT"
    )
    for row in rows:
        physical_id = row.get("physical_camera_id") or "-"
        policy_mode = row.get("policy_mode") or "-"
        camera_id = row.get("camera_id") or "-"
        print(
            f"{row['node_id']:<24} {str(physical_id):<10} {policy_mode:<9} "
            f"{camera_id:<12} "
            f"{row['key_version']:<9} {str(row['active']):<8} "
            f"{row['public_key_fingerprint']}"
        )


def cmd_register(args: argparse.Namespace) -> None:
    node_id = validate_identifier(args.node_id, "node id")
    alias_mode = getattr(args, "alias_mode", "fixed")
    if alias_mode not in {"fixed", "account"}:
        raise ValueError("alias mode must be 'fixed' or 'account'")
    if alias_mode == "fixed":
        if args.camera_id is None:
            raise ValueError("camera id is required for fixed alias mode")
        camera_id = validate_identifier(args.camera_id, "camera id")
    else:
        if args.camera_id is not None:
            raise ValueError("camera id must be omitted for account alias mode")
        camera_id = None
    public_key, fingerprint = load_public_key(args.public_key)
    conn = connect()
    try:
        conn.autocommit = False
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if alias_mode == "fixed":
                cur.execute("SELECT id FROM cameras WHERE id = %s", (camera_id,))
                if not cur.fetchone():
                    raise ValueError(f"camera '{camera_id}' does not exist")
            cur.execute(
                """
                INSERT INTO detection_nodes
                  (node_id, camera_id, public_key, public_key_fingerprint, key_version, active)
                VALUES (%s, %s, %s, %s, 1, TRUE)
                """,
                (node_id, camera_id, public_key, fingerprint),
            )
            cur.execute(
                """
                INSERT INTO physical_cameras (node_id)
                VALUES (%s)
                RETURNING physical_camera_id
                """,
                (node_id,),
            )
            physical = cur.fetchone()
            if alias_mode == "fixed":
                cur.execute(
                    """
                    INSERT INTO node_camera_alias_policy (node_id, mode, fixed_camera_id)
                    VALUES (%s, 'fixed', %s)
                    """,
                    (node_id, camera_id),
                )
            else:
                cur.execute(
                    """
                    INSERT INTO node_camera_alias_policy (node_id, mode, fixed_camera_id)
                    VALUES (%s, 'account', NULL)
                    """,
                    (node_id,),
                )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    print(
        f"registered node={node_id} physical_camera_id={physical['physical_camera_id']} "
        f"camera={camera_id} fingerprint={fingerprint} version=1"
    )


def cmd_list(args: argparse.Namespace) -> None:
    conn = connect()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT dn.node_id, dn.camera_id, dn.public_key_fingerprint,
                       dn.key_version, dn.active, pc.physical_camera_id,
                       ap.mode AS policy_mode
                  FROM detection_nodes dn
             LEFT JOIN physical_cameras pc ON pc.node_id = dn.node_id
             LEFT JOIN node_camera_alias_policy ap ON ap.node_id = dn.node_id
              ORDER BY dn.node_id
                """
            )
            rows = cur.fetchall()
    finally:
        conn.close()
    print_nodes(rows)


def cmd_disable(args: argparse.Namespace) -> None:
    node_id = validate_identifier(args.node_id, "node id")
    conn = connect()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE detection_nodes SET active = FALSE, updated_at = now() WHERE node_id = %s",
                    (node_id,),
                )
                if cur.rowcount != 1:
                    raise ValueError(f"node '{node_id}' does not exist")
    finally:
        conn.close()
    print(f"disabled node={node_id}")


def cmd_rotate_key(args: argparse.Namespace) -> None:
    node_id = validate_identifier(args.node_id, "node id")
    public_key, fingerprint = load_public_key(args.public_key)
    conn = connect()
    try:
        with conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    """
                    UPDATE detection_nodes
                       SET public_key = %s,
                           public_key_fingerprint = %s,
                           key_version = key_version + 1,
                           active = TRUE,
                           updated_at = now()
                     WHERE node_id = %s
                 RETURNING key_version
                    """,
                    (public_key, fingerprint, node_id),
                )
                row = cur.fetchone()
                if not row:
                    raise ValueError(f"node '{node_id}' does not exist")
    finally:
        conn.close()
    print(f"rotated node={node_id} fingerprint={fingerprint} version={row['key_version']}")


def _require_node(cur, node_id: str) -> None:
    cur.execute("SELECT node_id FROM detection_nodes WHERE node_id = %s", (node_id,))
    if not cur.fetchone():
        raise ValueError(f"node '{node_id}' does not exist")


def _require_camera(cur, camera_id: str) -> None:
    cur.execute("SELECT id FROM cameras WHERE id = %s", (camera_id,))
    if not cur.fetchone():
        raise ValueError(f"camera '{camera_id}' does not exist")


def cmd_set_fixed_alias(args: argparse.Namespace) -> None:
    node_id = validate_identifier(args.node_id, "node id")
    camera_id = validate_identifier(args.camera_id, "camera id")
    conn = connect()
    try:
        conn.autocommit = False
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            _require_node(cur, node_id)
            _require_camera(cur, camera_id)
            cur.execute(
                "DELETE FROM node_account_camera_alias WHERE node_id = %s",
                (node_id,),
            )
            cur.execute(
                """
                INSERT INTO node_camera_alias_policy (node_id, mode, fixed_camera_id)
                VALUES (%s, 'fixed', %s)
                ON CONFLICT (node_id) DO UPDATE
                  SET mode = 'fixed', fixed_camera_id = EXCLUDED.fixed_camera_id
                """,
                (node_id, camera_id),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    print(f"fixed alias node={node_id} camera={camera_id}")


def cmd_set_account_alias(args: argparse.Namespace) -> None:
    node_id = validate_identifier(args.node_id, "node id")
    camera_id = validate_identifier(args.camera_id, "camera id")
    username = validate_identifier(args.username, "username").lower()
    conn = connect()
    try:
        conn.autocommit = False
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            _require_node(cur, node_id)
            _require_camera(cur, camera_id)
            cur.execute(
                """
                SELECT id, role, active
                  FROM users
                 WHERE lower(username) = %s
                 LIMIT 1
                """,
                (username,),
            )
            user = cur.fetchone()
            if not user or not user["active"] or user["role"] != "CCTV-Operator":
                raise ValueError(f"user '{username}' must be an active CCTV-Operator")
            cur.execute(
                """
                INSERT INTO node_camera_alias_policy (node_id, mode, fixed_camera_id)
                VALUES (%s, 'account', NULL)
                ON CONFLICT (node_id) DO UPDATE
                  SET mode = 'account', fixed_camera_id = NULL
                """,
                (node_id,),
            )
            cur.execute(
                """
                INSERT INTO node_account_camera_alias (node_id, user_id, logical_camera_id)
                VALUES (%s, %s, %s)
                ON CONFLICT (node_id, user_id) DO UPDATE
                  SET logical_camera_id = EXCLUDED.logical_camera_id
                """,
                (node_id, user["id"], camera_id),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    print(f"account alias node={node_id} username={username} camera={camera_id}")


def reconcile_account_aliases(cur, node_ids, account_aliases, apply: bool) -> dict:
    normalized_nodes, normalized_aliases = _normalize_reconciliation_inputs(
        node_ids,
        account_aliases,
    )
    requested_node_ids = set(normalized_nodes)
    requested_usernames = {username for username, _camera_id in normalized_aliases}
    requested_camera_ids = {camera_id for _username, camera_id in normalized_aliases}

    cur.execute(
        """
        SELECT dn.node_id, pc.physical_camera_id
          FROM detection_nodes dn
          JOIN physical_cameras pc
            ON pc.node_id = dn.node_id
           AND pc.active = TRUE
         WHERE dn.node_id = ANY(%s)
           AND dn.active = TRUE
         ORDER BY dn.node_id
           FOR UPDATE OF dn, pc
        """,
        (list(normalized_nodes),),
    )
    node_rows = cur.fetchall()
    nodes_by_id = {row["node_id"]: row for row in node_rows}
    if set(nodes_by_id) != requested_node_ids:
        missing = sorted(requested_node_ids - set(nodes_by_id))
        raise ValueError(
            "each target node must be active with one active physical camera; "
            f"missing={','.join(missing)}"
        )

    cur.execute(
        """
        SELECT id, lower(username) AS username, role, active
          FROM users
         WHERE lower(username) = ANY(%s)
         ORDER BY lower(username)
           FOR UPDATE
        """,
        (list(sorted(requested_usernames)),),
    )
    user_rows = cur.fetchall()
    users_by_name = {row["username"].lower(): row for row in user_rows}
    for username in sorted(requested_usernames):
        user = users_by_name.get(username)
        if not user or not user["active"] or user["role"] != "CCTV-Operator":
            raise ValueError(f"user '{username}' must be an active CCTV-Operator")

    cur.execute(
        """
        SELECT id
          FROM cameras
         WHERE id = ANY(%s)
         ORDER BY id
           FOR UPDATE
        """,
        (list(sorted(requested_camera_ids)),),
    )
    camera_rows = cur.fetchall()
    existing_camera_ids = {row["id"] for row in camera_rows}
    if existing_camera_ids != requested_camera_ids:
        missing = sorted(requested_camera_ids - existing_camera_ids)
        raise ValueError(f"logical camera does not exist: {','.join(missing)}")

    cur.execute(
        """
        SELECT node_id, mode, fixed_camera_id
          FROM node_camera_alias_policy
         WHERE node_id = ANY(%s)
         ORDER BY node_id
           FOR UPDATE
        """,
        (list(normalized_nodes),),
    )
    policy_rows = cur.fetchall()

    cur.execute(
        """
        SELECT node_id, user_id, logical_camera_id
          FROM node_account_camera_alias
         WHERE node_id = ANY(%s)
         ORDER BY node_id, user_id
           FOR UPDATE
        """,
        (list(normalized_nodes),),
    )
    mapping_rows = cur.fetchall()
    requested_user_ids = {users_by_name[username]["id"] for username in requested_usernames}
    unexpected = [
        row
        for row in mapping_rows
        if row["node_id"] in requested_node_ids and row["user_id"] not in requested_user_ids
    ]
    if unexpected:
        raise ValueError("unexpected account alias mapping exists for a target node")

    if apply:
        for node_id in normalized_nodes:
            cur.execute(
                """
                INSERT INTO node_camera_alias_policy (node_id, mode, fixed_camera_id)
                VALUES (%s, 'account', NULL)
                ON CONFLICT (node_id) DO UPDATE
                  SET mode = 'account', fixed_camera_id = NULL
                """,
                (node_id,),
            )
        for node_id in normalized_nodes:
            for username, camera_id in normalized_aliases:
                cur.execute(
                    """
                    INSERT INTO node_account_camera_alias
                      (node_id, user_id, logical_camera_id)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (node_id, user_id) DO UPDATE
                      SET logical_camera_id = EXCLUDED.logical_camera_id
                    """,
                    (node_id, users_by_name[username]["id"], camera_id),
                )

        expected_nodes = []
        expected_users = []
        expected_cameras = []
        for node_id in normalized_nodes:
            for username, camera_id in normalized_aliases:
                expected_nodes.append(node_id)
                expected_users.append(users_by_name[username]["id"])
                expected_cameras.append(camera_id)
        cur.execute(
            """
            SELECT
              (
                SELECT count(*)
                  FROM node_camera_alias_policy
                 WHERE node_id = ANY(%s)
                   AND mode = 'account'
                   AND fixed_camera_id IS NULL
              ) = %s AS policies_match,
              (
                SELECT count(*)
                  FROM node_account_camera_alias
                 WHERE node_id = ANY(%s)
              ) = %s AS mapping_count_matches,
              NOT EXISTS (
                SELECT 1
                  FROM unnest(%s::text[], %s::bigint[], %s::text[])
                       AS expected(node_id, user_id, logical_camera_id)
             LEFT JOIN node_account_camera_alias actual
                    ON actual.node_id = expected.node_id
                   AND actual.user_id = expected.user_id
                   AND actual.logical_camera_id = expected.logical_camera_id
                 WHERE actual.node_id IS NULL
              ) AS mappings_match
            """,
            (
                list(normalized_nodes),
                len(normalized_nodes),
                list(normalized_nodes),
                len(expected_nodes),
                expected_nodes,
                expected_users,
                expected_cameras,
            ),
        )
        verification = cur.fetchone()
        if isinstance(verification, Mapping) and not all(
            verification.get(field)
            for field in ("policies_match", "mapping_count_matches", "mappings_match")
        ):
            raise ValueError("account alias reconciliation state verification failed")

    return {
        "applied": bool(apply),
        "node_ids": normalized_nodes,
        "account_aliases": normalized_aliases,
        "physical_camera_ids": tuple(
            nodes_by_id[node_id]["physical_camera_id"] for node_id in normalized_nodes
        ),
        "node_count": len(normalized_nodes),
        "account_count": len(normalized_aliases),
        "mapping_count": len(normalized_nodes) * len(normalized_aliases),
        "existing_policy_count": len(policy_rows),
    }


def cmd_reconcile_account_aliases(args: argparse.Namespace) -> None:
    node_ids, account_aliases = _normalize_reconciliation_inputs(
        tuple(args.node_id),
        tuple(parse_account_alias(value) for value in args.account_alias),
    )
    conn = connect()
    try:
        conn.autocommit = False
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            result = reconcile_account_aliases(
                cur,
                node_ids,
                account_aliases,
                apply=not args.dry_run,
            )
        if args.dry_run:
            conn.rollback()
        else:
            conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    action = "validated" if args.dry_run else "reconciled"
    print(
        f"{action} nodes={result['node_count']} accounts={result['account_count']} "
        f"mappings={result['mapping_count']} physical_camera_ids="
        f"{','.join(str(value) for value in result['physical_camera_ids'])}"
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    register = commands.add_parser("register", help="register a node and its physical camera")
    register.add_argument("--node-id", required=True)
    register.add_argument("--alias-mode", choices=("fixed", "account"), default="fixed")
    register.add_argument("--camera-id")
    register.add_argument("--public-key", required=True, type=pathlib.Path)
    register.set_defaults(handler=cmd_register)

    listing = commands.add_parser("list", help="list registrations without key payloads")
    listing.set_defaults(handler=cmd_list)

    disable = commands.add_parser("disable", help="disable a node registration")
    disable.add_argument("--node-id", required=True)
    disable.set_defaults(handler=cmd_disable)

    rotate = commands.add_parser("rotate-key", help="replace a node public key")
    rotate.add_argument("--node-id", required=True)
    rotate.add_argument("--public-key", required=True, type=pathlib.Path)
    rotate.set_defaults(handler=cmd_rotate_key)

    fixed = commands.add_parser("set-fixed-alias", help="set one fixed logical alias for a node")
    fixed.add_argument("--node-id", required=True)
    fixed.add_argument("--camera-id", required=True)
    fixed.set_defaults(handler=cmd_set_fixed_alias)

    account = commands.add_parser(
        "set-account-alias",
        help="set one account-specific logical alias for a node",
    )
    account.add_argument("--node-id", required=True)
    account.add_argument("--username", required=True)
    account.add_argument("--camera-id", required=True)
    account.set_defaults(handler=cmd_set_account_alias)

    reconcile = commands.add_parser(
        "reconcile-account-aliases",
        help="atomically reconcile account aliases for explicit nodes",
    )
    reconcile.add_argument("--node-id", action="append", required=True)
    reconcile.add_argument("--account-alias", action="append", required=True)
    reconcile.add_argument("--dry-run", action="store_true")
    reconcile.set_defaults(handler=cmd_reconcile_account_aliases)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    try:
        args.handler(args)
    except (ValueError, OSError, psycopg2.Error) as exc:
        die(str(exc))


if __name__ == "__main__":
    main()
