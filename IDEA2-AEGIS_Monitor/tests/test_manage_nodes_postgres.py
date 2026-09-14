from __future__ import annotations

import importlib.util
import os
import pathlib
import tempfile
import types
import unittest
import uuid
from unittest import mock

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


HERE = pathlib.Path(__file__).resolve().parent
MODULE_PATH = HERE.parent / "server" / "cli" / "manage_nodes.py"
TEST_DATABASE_URL = os.environ.get("AEGIS_MONITOR_TEST_DATABASE_URL")


def load_manage_nodes():
    spec = importlib.util.spec_from_file_location("manage_nodes_postgres_under_test", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def open_validated_test_database(database_url, psycopg2_module):
    try:
        parameters = psycopg2_module.extensions.parse_dsn(database_url)
    except psycopg2_module.ProgrammingError as exc:
        raise RuntimeError("invalid PostgreSQL test database URL") from exc

    expected_database = parameters.get("dbname")
    if not expected_database:
        raise RuntimeError("PostgreSQL test database URL must include a database name")
    if expected_database == "aegis_monitor" or not expected_database.startswith(
        "aegis_monitor_lr0_test"
    ):
        raise RuntimeError(
            "refusing account-alias integration tests outside an "
            "aegis_monitor_lr0_test* database"
        )

    connection = psycopg2_module.connect(database_url)
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT current_database()")
            actual_database = cursor.fetchone()[0]
        if actual_database != expected_database or not actual_database.startswith(
            "aegis_monitor_lr0_test"
        ):
            raise RuntimeError(
                "refusing account-alias integration tests outside the "
                "validated disposable database"
            )
    except Exception:
        connection.close()
        raise
    return connection


class DatabaseUrlSafetyTests(unittest.TestCase):
    class FakeProgrammingError(Exception):
        pass

    def _psycopg2(self, parsed_dsn=None, parse_error=None, current_database=None):
        cursor = mock.MagicMock()
        cursor.__enter__.return_value = cursor
        cursor.fetchone.return_value = (current_database,)
        connection = mock.MagicMock()
        connection.cursor.return_value = cursor
        parse_dsn = mock.Mock(
            return_value=parsed_dsn,
            side_effect=parse_error,
        )
        module = types.SimpleNamespace(
            ProgrammingError=self.FakeProgrammingError,
            extensions=types.SimpleNamespace(parse_dsn=parse_dsn),
            connect=mock.Mock(return_value=connection),
        )
        return module, connection

    def _open(self, database_url, psycopg2_module):
        opener = globals().get("open_validated_test_database")
        self.assertIsNotNone(
            opener,
            "pre-connect disposable-database validation is not implemented",
        )
        return opener(database_url, psycopg2_module)

    def test_production_database_name_is_rejected_before_connection(self):
        psycopg2_module, _connection = self._psycopg2(
            parsed_dsn={"dbname": "aegis_monitor"},
        )

        with self.assertRaisesRegex(RuntimeError, "refusing"):
            self._open(
                "postgresql://postgres@127.0.0.1:55432/aegis_monitor",
                psycopg2_module,
            )

        psycopg2_module.connect.assert_not_called()

    def test_malformed_or_ambiguous_dsn_is_rejected_before_connection(self):
        malformed_module, _connection = self._psycopg2(
            parse_error=self.FakeProgrammingError("invalid dsn"),
        )
        with self.assertRaisesRegex(RuntimeError, "invalid PostgreSQL test database URL"):
            self._open("not-a-postgresql-dsn", malformed_module)
        malformed_module.connect.assert_not_called()

        ambiguous_module, _connection = self._psycopg2(parsed_dsn={})
        with self.assertRaisesRegex(RuntimeError, "database name"):
            self._open("postgresql://postgres@127.0.0.1:55432", ambiguous_module)
        ambiguous_module.connect.assert_not_called()

    def test_valid_dsn_connects_and_server_database_name_is_verified(self):
        database_url = (
            "postgresql://postgres@127.0.0.1:55432/aegis_monitor_lr0_test_unit"
        )
        psycopg2_module, connection = self._psycopg2(
            parsed_dsn={"dbname": "aegis_monitor_lr0_test_unit"},
            current_database="aegis_monitor_lr0_test_unit",
        )

        self.assertIs(connection, self._open(database_url, psycopg2_module))
        psycopg2_module.connect.assert_called_once_with(database_url)

        mismatch_module, mismatch_connection = self._psycopg2(
            parsed_dsn={"dbname": "aegis_monitor_lr0_test_unit"},
            current_database="aegis_monitor",
        )
        with self.assertRaisesRegex(RuntimeError, "refusing"):
            self._open(database_url, mismatch_module)
        mismatch_connection.close.assert_called_once_with()


@unittest.skipUnless(
    TEST_DATABASE_URL,
    "AEGIS_MONITOR_TEST_DATABASE_URL is required for disposable PostgreSQL tests",
)
class NodeRegistryPostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg2

        cls.psycopg2 = psycopg2
        cls.connection = open_validated_test_database(TEST_DATABASE_URL, psycopg2)
        cls.module = load_manage_nodes()

    @classmethod
    def tearDownClass(cls):
        cls.connection.close()

    def setUp(self):
        self.suffix = uuid.uuid4().hex[:10]
        self.node_ids = (f"registry-{self.suffix}-a", f"registry-{self.suffix}-b")
        self.tempdir = tempfile.TemporaryDirectory()
        self.public_key = pathlib.Path(self.tempdir.name) / "node-public.pem"
        self.public_key.write_bytes(
            Ed25519PrivateKey.generate().public_key().public_bytes(
                serialization.Encoding.PEM,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
        )

    def tearDown(self):
        self.connection.rollback()
        with self.connection.cursor() as cursor:
            cursor.execute(
                "DELETE FROM node_account_camera_alias WHERE node_id = ANY(%s)",
                (list(self.node_ids),),
            )
            cursor.execute(
                "DELETE FROM node_camera_alias_policy WHERE node_id = ANY(%s)",
                (list(self.node_ids),),
            )
            cursor.execute(
                "DELETE FROM physical_cameras WHERE node_id = ANY(%s)",
                (list(self.node_ids),),
            )
            cursor.execute(
                "DELETE FROM detection_nodes WHERE node_id = ANY(%s)",
                (list(self.node_ids),),
            )
        self.connection.commit()
        self.tempdir.cleanup()

    def _register(self, node_id, public_key=None):
        args = types.SimpleNamespace(
            node_id=node_id,
            alias_mode="fixed",
            camera_id="CAM-01",
            public_key=public_key or self.public_key,
        )
        with mock.patch.dict(os.environ, {"DATABASE_URL": TEST_DATABASE_URL}):
            self.module.cmd_register(args)

    def test_registration_creates_one_node_one_physical_camera_and_fixed_alias(self):
        self._register(self.node_ids[0])
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT dn.node_id, dn.camera_id, dn.key_version, dn.active,
                       pc.physical_camera_id, policy.mode, policy.fixed_camera_id
                  FROM detection_nodes dn
                  JOIN physical_cameras pc USING (node_id)
                  JOIN node_camera_alias_policy policy USING (node_id)
                 WHERE dn.node_id = %s
                """,
                (self.node_ids[0],),
            )
            row = cursor.fetchone()
        self.assertEqual(self.node_ids[0], row[0])
        self.assertEqual("CAM-01", row[1])
        self.assertEqual(1, row[2])
        self.assertTrue(row[3])
        self.assertGreater(row[4], 0)
        self.assertEqual(("fixed", "CAM-01"), row[5:])

    def test_duplicate_node_and_public_key_fingerprint_conflicts_are_rejected(self):
        self._register(self.node_ids[0])
        with self.assertRaises(self.psycopg2.IntegrityError):
            self._register(self.node_ids[0])

        with self.assertRaises(self.psycopg2.IntegrityError):
            self._register(self.node_ids[1])

        with self.connection.cursor() as cursor:
            cursor.execute(
                "SELECT count(*) FROM detection_nodes WHERE node_id = ANY(%s)",
                (list(self.node_ids),),
            )
            count = cursor.fetchone()[0]
        self.assertEqual(1, count)


@unittest.skipUnless(
    TEST_DATABASE_URL,
    "AEGIS_MONITOR_TEST_DATABASE_URL is required for disposable PostgreSQL tests",
)
class AccountAliasPolicyPostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg2
        import psycopg2.extras

        cls.psycopg2 = psycopg2
        cls.real_dict_cursor = psycopg2.extras.RealDictCursor
        cls.connection = open_validated_test_database(TEST_DATABASE_URL, psycopg2)
        cls.module = load_manage_nodes()

    @classmethod
    def tearDownClass(cls):
        cls.connection.close()

    def setUp(self):
        suffix = uuid.uuid4().hex[:10]
        self.node_ids = (
            f"lr0-node-{suffix}-a",
            f"lr0-node-{suffix}-b",
            f"lr0-node-{suffix}-c",
        )
        self.usernames = (f"lr0-operator-{suffix}", f"lr0-operator2-{suffix}")
        self.user_ids: tuple[int, int]
        self._seed_legacy_fixture()

    def tearDown(self):
        self.connection.rollback()
        with self.connection.cursor() as cursor:
            cursor.execute(
                "DELETE FROM node_account_camera_alias WHERE node_id = ANY(%s)",
                (list(self.node_ids),),
            )
            cursor.execute(
                "DELETE FROM node_camera_alias_policy WHERE node_id = ANY(%s)",
                (list(self.node_ids),),
            )
            cursor.execute(
                "DELETE FROM physical_cameras WHERE node_id = ANY(%s)",
                (list(self.node_ids),),
            )
            cursor.execute(
                "DELETE FROM detection_nodes WHERE node_id = ANY(%s)",
                (list(self.node_ids),),
            )
            cursor.execute(
                "DELETE FROM users WHERE username = ANY(%s)",
                (list(self.usernames) + [f"{self.usernames[0]}-extra"],),
            )
        self.connection.commit()

    def _seed_legacy_fixture(self):
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO cameras (id, name, zone)
                VALUES ('CAM-01', 'LR0 Camera 1', 'LR0'),
                       ('CAM-02', 'LR0 Camera 2', 'LR0')
                ON CONFLICT (id) DO NOTHING
                """
            )
            user_ids = []
            for username in self.usernames:
                cursor.execute(
                    """
                    INSERT INTO users (username, password_hash, role, display_name, active)
                    VALUES (%s, 'not-a-real-login-hash', 'CCTV-Operator', %s, TRUE)
                    RETURNING id
                    """,
                    (username, username),
                )
                user_ids.append(cursor.fetchone()[0])
            self.user_ids = tuple(user_ids)

            legacy_cameras = ("CAM-01", "CAM-02", None)
            policy_rows = (("fixed", "CAM-01"), ("fixed", "CAM-02"), ("account", None))
            for index, node_id in enumerate(self.node_ids):
                cursor.execute(
                    """
                    INSERT INTO detection_nodes
                      (node_id, camera_id, public_key, public_key_fingerprint, key_version, active)
                    VALUES (%s, %s, %s, %s, 1, TRUE)
                    """,
                    (
                        node_id,
                        legacy_cameras[index],
                        "TEST PUBLIC KEY",
                        f"SHA256:lr0-{node_id}",
                    ),
                )
                cursor.execute(
                    "INSERT INTO physical_cameras (node_id) VALUES (%s)",
                    (node_id,),
                )
                cursor.execute(
                    """
                    INSERT INTO node_camera_alias_policy (node_id, mode, fixed_camera_id)
                    VALUES (%s, %s, %s)
                    """,
                    (node_id, *policy_rows[index]),
                )

            cursor.execute(
                """
                INSERT INTO node_account_camera_alias
                  (node_id, user_id, logical_camera_id)
                VALUES (%s, %s, 'CAM-01'), (%s, %s, 'CAM-02')
                """,
                (self.node_ids[2], self.user_ids[0], self.node_ids[2], self.user_ids[1]),
            )
        self.connection.commit()

    def _account_aliases(self):
        return ((self.usernames[0], "CAM-01"), (self.usernames[1], "CAM-02"))

    def _reconcile(self):
        handler = getattr(self.module, "cmd_reconcile_account_aliases", None)
        self.assertIsNotNone(handler, "cmd_reconcile_account_aliases is not implemented")
        args = types.SimpleNamespace(
            node_id=list(self.node_ids),
            account_alias=[f"{username}={camera_id}" for username, camera_id in self._account_aliases()],
            dry_run=False,
        )
        with mock.patch.dict(os.environ, {"DATABASE_URL": TEST_DATABASE_URL}):
            return handler(args)

    def _snapshot_physical(self):
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT node_id, physical_camera_id
                  FROM physical_cameras
                 WHERE node_id = ANY(%s)
                 ORDER BY node_id
                """,
                (list(self.node_ids),),
            )
            return tuple(cursor.fetchall())

    def _snapshot_policy(self):
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT node_id, mode, fixed_camera_id
                  FROM node_camera_alias_policy
                 WHERE node_id = ANY(%s)
                 ORDER BY node_id
                """,
                (list(self.node_ids),),
            )
            policies = tuple(cursor.fetchall())
            cursor.execute(
                """
                SELECT node_id, user_id, logical_camera_id
                  FROM node_account_camera_alias
                 WHERE node_id = ANY(%s)
                 ORDER BY node_id, user_id
                """,
                (list(self.node_ids),),
            )
            return policies, tuple(cursor.fetchall())

    def test_legacy_fixed_nodes_reconcile_atomically_and_preserve_physical_ids(self):
        before_physical = self._snapshot_physical()

        self._reconcile()

        after_physical = self._snapshot_physical()
        policies, mappings = self._snapshot_policy()
        self.assertEqual(before_physical, after_physical)
        self.assertEqual(
            tuple((node_id, "account", None) for node_id in sorted(self.node_ids)),
            policies,
        )
        expected_mappings = sorted(
            (node_id, user_id, camera_id)
            for node_id in self.node_ids
            for user_id, camera_id in zip(self.user_ids, ("CAM-01", "CAM-02"))
        )
        self.assertEqual(tuple(expected_mappings), mappings)

    def test_already_reconciled_state_is_idempotent(self):
        self._reconcile()
        first_physical = self._snapshot_physical()
        first_policy = self._snapshot_policy()

        self._reconcile()

        self.assertEqual(first_physical, self._snapshot_physical())
        self.assertEqual(first_policy, self._snapshot_policy())
        self.assertEqual(6, len(first_policy[1]))

    def test_unexpected_extra_mapping_rolls_back_every_policy_change(self):
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO users (username, password_hash, role, display_name, active)
                VALUES (%s, 'not-a-real-login-hash', 'CCTV-Operator', %s, TRUE)
                RETURNING id
                """,
                (f"{self.usernames[0]}-extra", "LR0 extra operator"),
            )
            extra_user_id = cursor.fetchone()[0]
            cursor.execute(
                """
                INSERT INTO node_account_camera_alias (node_id, user_id, logical_camera_id)
                VALUES (%s, %s, 'CAM-02')
                """,
                (self.node_ids[0], extra_user_id),
            )
        self.connection.commit()
        before_physical = self._snapshot_physical()
        before_policy = self._snapshot_policy()

        handler = getattr(self.module, "cmd_reconcile_account_aliases", None)
        self.assertIsNotNone(handler, "cmd_reconcile_account_aliases is not implemented")
        args = types.SimpleNamespace(
            node_id=list(self.node_ids),
            account_alias=[f"{username}={camera_id}" for username, camera_id in self._account_aliases()],
            dry_run=False,
        )
        with self.assertRaisesRegex(ValueError, "unexpected"):
            with mock.patch.dict(os.environ, {"DATABASE_URL": TEST_DATABASE_URL}):
                handler(args)

        self.assertEqual(before_physical, self._snapshot_physical())
        self.assertEqual(before_policy, self._snapshot_policy())


if __name__ == "__main__":
    unittest.main()
