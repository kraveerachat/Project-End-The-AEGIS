from __future__ import annotations

import importlib.util
import io
import pathlib
import sys
import types
import unittest
from contextlib import redirect_stdout
from unittest import mock

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


HERE = pathlib.Path(__file__).resolve().parent
MODULE_PATH = HERE.parent / "server" / "cli" / "manage_nodes.py"


class _PsycopgError(Exception):
    pass


def load_module():
    psycopg2 = types.ModuleType("psycopg2")
    psycopg2.Error = _PsycopgError
    psycopg2.OperationalError = _PsycopgError
    psycopg2.connect = mock.Mock()
    extras = types.ModuleType("psycopg2.extras")
    extras.RealDictCursor = object
    psycopg2.extras = extras

    with mock.patch.dict(sys.modules, {"psycopg2": psycopg2, "psycopg2.extras": extras}):
        spec = importlib.util.spec_from_file_location("manage_nodes_under_test", MODULE_PATH)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
    return module


def public_pem() -> bytes:
    return Ed25519PrivateKey.generate().public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )


def require_callable(testcase: unittest.TestCase, module, name: str):
    value = getattr(module, name, None)
    testcase.assertIsNotNone(value, f"{name} is not implemented")
    testcase.assertTrue(callable(value), f"{name} must be callable")
    return value


def reconciliation_cursor(
    *,
    nodes=None,
    users=None,
    cameras=None,
    policies=None,
    mappings=None,
):
    cursor = mock.MagicMock()
    cursor.fetchall.side_effect = [
        nodes
        if nodes is not None
        else [
            {"node_id": "edge-node-01", "physical_camera_id": 101},
            {"node_id": "edge-node-02", "physical_camera_id": 202},
            {"node_id": "edge-node-generic", "physical_camera_id": 303},
        ],
        users
        if users is not None
        else [
            {"id": 11, "username": "operator", "role": "CCTV-Operator", "active": True},
            {"id": 22, "username": "operator2", "role": "CCTV-Operator", "active": True},
        ],
        cameras
        if cameras is not None
        else [{"id": "CAM-01"}, {"id": "CAM-02"}],
        policies
        if policies is not None
        else [
            {"node_id": "edge-node-01", "mode": "fixed", "fixed_camera_id": "CAM-01"},
            {"node_id": "edge-node-02", "mode": "fixed", "fixed_camera_id": "CAM-02"},
            {"node_id": "edge-node-generic", "mode": "account", "fixed_camera_id": None},
        ],
        mappings
        if mappings is not None
        else [
            {"node_id": "edge-node-generic", "user_id": 11, "logical_camera_id": "CAM-01"},
            {"node_id": "edge-node-generic", "user_id": 22, "logical_camera_id": "CAM-02"},
        ],
    ]
    return cursor


class ManageNodesTests(unittest.TestCase):
    def test_parser_exposes_only_expected_admin_commands(self):
        module = load_module()
        parser = module.build_parser()
        choices = next(
            action.choices for action in parser._actions if getattr(action, "choices", None)
        )
        self.assertEqual(
            {
                "register",
                "list",
                "disable",
                "rotate-key",
                "set-fixed-alias",
                "set-account-alias",
                "reconcile-account-aliases",
            },
            set(choices),
        )

    def test_public_key_loader_accepts_ed25519_spki_and_returns_fingerprint(self):
        module = load_module()
        with mock.patch.object(pathlib.Path, "read_bytes", return_value=public_pem()):
            pem, fingerprint = module.load_public_key(pathlib.Path("node.pub"))
        self.assertTrue(pem.startswith("-----BEGIN PUBLIC KEY-----"))
        self.assertRegex(fingerprint, r"^SHA256:[A-Za-z0-9_-]{43}$")

    def test_public_key_loader_rejects_private_key_material(self):
        module = load_module()
        private_pem = Ed25519PrivateKey.generate().private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        with mock.patch.object(pathlib.Path, "read_bytes", return_value=private_pem):
            with self.assertRaisesRegex(ValueError, "public"):
                module.load_public_key(pathlib.Path("node.key"))

    def test_public_key_loader_rejects_public_key_with_appended_private_material(self):
        module = load_module()
        key = Ed25519PrivateKey.generate()
        mixed_payload = key.public_key().public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        ) + key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        with mock.patch.object(pathlib.Path, "read_bytes", return_value=mixed_payload):
            with self.assertRaisesRegex(ValueError, "exactly one"):
                module.load_public_key(pathlib.Path("mixed.pem"))

    def test_identifiers_are_validated_without_machine_specific_defaults(self):
        module = load_module()
        for value in ("node-a", "edge.node_02", "CAM-02"):
            self.assertEqual(value, module.validate_identifier(value, "identifier"))
        for value in ("", "../node", "node id", "x" * 65):
            with self.assertRaises(ValueError):
                module.validate_identifier(value, "identifier")

    def test_list_output_omits_public_key_payload(self):
        module = load_module()
        rows = [{
            "node_id": "edge-node-02",
            "camera_id": "CAM-02",
            "public_key": "-----BEGIN PUBLIC KEY----- SECRET",
            "public_key_fingerprint": "SHA256:example",
            "key_version": 2,
            "active": True,
            "physical_camera_id": None,
            "policy_mode": None,
        }]
        output = io.StringIO()
        with redirect_stdout(output):
            module.print_nodes(rows)
        rendered = output.getvalue()
        self.assertIn("edge-node-02", rendered)
        self.assertIn("CAM-02", rendered)
        self.assertIn("SHA256:example", rendered)
        self.assertNotIn("BEGIN PUBLIC KEY", rendered)
        self.assertNotIn("SECRET", rendered)

    def test_register_confirms_camera_and_commits_one_versioned_registration(self):
        module = load_module()
        cursor = mock.MagicMock()
        cursor.__enter__.return_value = cursor
        cursor.fetchone.side_effect = [
            {"id": "CAMERA-NEW"},
            {"physical_camera_id": 41},
        ]
        connection = mock.MagicMock()
        connection.cursor.return_value = cursor
        args = types.SimpleNamespace(
            node_id="edge-new",
            camera_id="CAMERA-NEW",
            alias_mode="fixed",
            public_key=pathlib.Path("node.pub"),
        )

        with mock.patch.object(module, "connect", return_value=connection), mock.patch.object(
            module, "load_public_key", return_value=("PUBLIC PEM\n", "SHA256:fingerprint")
        ):
            module.cmd_register(args)

        self.assertEqual(4, cursor.execute.call_count)
        camera_query, camera_params = cursor.execute.call_args_list[0].args
        insert_query, insert_params = cursor.execute.call_args_list[1].args
        physical_query, physical_params = cursor.execute.call_args_list[2].args
        policy_query, policy_params = cursor.execute.call_args_list[3].args
        self.assertIn("WHERE id = %s", camera_query)
        self.assertEqual(("CAMERA-NEW",), camera_params)
        self.assertIn("INSERT INTO detection_nodes", insert_query)
        self.assertIn("1, TRUE", insert_query)
        self.assertEqual(
            ("edge-new", "CAMERA-NEW", "PUBLIC PEM\n", "SHA256:fingerprint"),
            insert_params,
        )
        self.assertIn("INSERT INTO physical_cameras", physical_query)
        self.assertIn("RETURNING physical_camera_id", physical_query)
        self.assertEqual(("edge-new",), physical_params)
        self.assertIn("INSERT INTO node_camera_alias_policy", policy_query)
        self.assertEqual(("edge-new", "CAMERA-NEW"), policy_params)
        connection.commit.assert_called_once_with()
        connection.rollback.assert_not_called()
        connection.close.assert_called_once_with()

    def test_parser_allows_account_mode_registration_without_legacy_camera(self):
        module = load_module()
        parser = module.build_parser()
        commands = next(
            action.choices for action in parser._actions if getattr(action, "choices", None)
        )
        register = commands["register"]
        actions = {action.dest: action for action in register._actions}

        self.assertIn("alias_mode", actions)
        self.assertEqual(("fixed", "account"), tuple(actions["alias_mode"].choices))
        self.assertFalse(actions["camera_id"].required)

    def test_account_mode_registration_uses_null_legacy_camera_and_server_generated_physical_identity(self):
        module = load_module()
        cursor = mock.MagicMock()
        cursor.__enter__.return_value = cursor
        cursor.fetchone.return_value = {"physical_camera_id": 303}
        connection = mock.MagicMock()
        connection.cursor.return_value = cursor
        args = types.SimpleNamespace(
            node_id="edge-c",
            camera_id=None,
            alias_mode="account",
            public_key=pathlib.Path("node.pub"),
        )

        with mock.patch.object(module, "connect", return_value=connection), mock.patch.object(
            module, "load_public_key", return_value=("PUBLIC PEM\n", "SHA256:fingerprint-c")
        ):
            module.cmd_register(args)

        statements = [call.args[0] for call in cursor.execute.call_args_list]
        self.assertEqual(3, len(statements))
        self.assertIn("INSERT INTO detection_nodes", statements[0])
        self.assertEqual(
            ("edge-c", None, "PUBLIC PEM\n", "SHA256:fingerprint-c"),
            cursor.execute.call_args_list[0].args[1],
        )
        self.assertIn("INSERT INTO physical_cameras", statements[1])
        self.assertEqual(("edge-c",), cursor.execute.call_args_list[1].args[1])
        self.assertIn("INSERT INTO node_camera_alias_policy", statements[2])
        self.assertIn("'account', NULL", statements[2])
        self.assertEqual(("edge-c",), cursor.execute.call_args_list[2].args[1])
        connection.commit.assert_called_once_with()
        connection.rollback.assert_not_called()

    def test_set_fixed_alias_is_atomic_and_removes_account_specific_rules(self):
        module = load_module()
        cursor = mock.MagicMock()
        cursor.__enter__.return_value = cursor
        cursor.fetchone.side_effect = [{"node_id": "edge-a"}, {"id": "CAM-01"}]
        connection = mock.MagicMock()
        connection.cursor.return_value = cursor
        args = types.SimpleNamespace(node_id="edge-a", camera_id="CAM-01")

        with mock.patch.object(module, "connect", return_value=connection):
            module.cmd_set_fixed_alias(args)

        statements = [call.args[0] for call in cursor.execute.call_args_list]
        self.assertEqual(4, len(statements))
        self.assertIn("FROM detection_nodes", statements[0])
        self.assertIn("FROM cameras", statements[1])
        self.assertIn("DELETE FROM node_account_camera_alias", statements[2])
        self.assertIn("INSERT INTO node_camera_alias_policy", statements[3])
        self.assertEqual(("edge-a", "CAM-01"), cursor.execute.call_args_list[3].args[1])
        connection.commit.assert_called_once_with()
        connection.rollback.assert_not_called()

    def test_set_fixed_alias_rolls_back_when_camera_is_unknown(self):
        module = load_module()
        cursor = mock.MagicMock()
        cursor.__enter__.return_value = cursor
        cursor.fetchone.side_effect = [{"node_id": "edge-a"}, None]
        connection = mock.MagicMock()
        connection.cursor.return_value = cursor
        args = types.SimpleNamespace(node_id="edge-a", camera_id="CAM-MISSING")

        with mock.patch.object(module, "connect", return_value=connection):
            with self.assertRaisesRegex(ValueError, "camera 'CAM-MISSING' does not exist"):
                module.cmd_set_fixed_alias(args)

        connection.rollback.assert_called_once_with()
        connection.commit.assert_not_called()

    def test_set_account_alias_resolves_live_operator_id_and_is_atomic(self):
        module = load_module()
        cursor = mock.MagicMock()
        cursor.__enter__.return_value = cursor
        cursor.fetchone.side_effect = [
            {"node_id": "edge-c"},
            {"id": "CAM-02"},
            {"id": 73, "role": "CCTV-Operator", "active": True},
        ]
        connection = mock.MagicMock()
        connection.cursor.return_value = cursor
        args = types.SimpleNamespace(
            node_id="edge-c",
            username="operator2",
            camera_id="CAM-02",
        )

        with mock.patch.object(module, "connect", return_value=connection):
            module.cmd_set_account_alias(args)

        statements = [call.args[0] for call in cursor.execute.call_args_list]
        self.assertEqual(5, len(statements))
        self.assertIn("FROM detection_nodes", statements[0])
        self.assertIn("FROM cameras", statements[1])
        self.assertIn("lower(username)", statements[2])
        self.assertIn("INSERT INTO node_camera_alias_policy", statements[3])
        self.assertIn("INSERT INTO node_account_camera_alias", statements[4])
        self.assertEqual(("edge-c", 73, "CAM-02"), cursor.execute.call_args_list[4].args[1])
        connection.commit.assert_called_once_with()
        connection.rollback.assert_not_called()

    def test_set_account_alias_rejects_disabled_or_non_operator_accounts(self):
        module = load_module()
        for user in (
            {"id": 7, "role": "SOC-Responder", "active": True},
            {"id": 8, "role": "CCTV-Operator", "active": False},
        ):
            with self.subTest(user=user):
                cursor = mock.MagicMock()
                cursor.__enter__.return_value = cursor
                cursor.fetchone.side_effect = [
                    {"node_id": "edge-c"},
                    {"id": "CAM-01"},
                    user,
                ]
                connection = mock.MagicMock()
                connection.cursor.return_value = cursor
                args = types.SimpleNamespace(
                    node_id="edge-c",
                    username="candidate",
                    camera_id="CAM-01",
                )

                with mock.patch.object(module, "connect", return_value=connection):
                    with self.assertRaisesRegex(ValueError, "active CCTV-Operator"):
                        module.cmd_set_account_alias(args)

                connection.rollback.assert_called_once_with()
                connection.commit.assert_not_called()

    def test_set_account_alias_rolls_back_when_user_is_unknown(self):
        module = load_module()
        cursor = mock.MagicMock()
        cursor.__enter__.return_value = cursor
        cursor.fetchone.side_effect = [
            {"node_id": "edge-c"},
            {"id": "CAM-01"},
            None,
        ]
        connection = mock.MagicMock()
        connection.cursor.return_value = cursor
        args = types.SimpleNamespace(
            node_id="edge-c",
            username="missing-user",
            camera_id="CAM-01",
        )

        with mock.patch.object(module, "connect", return_value=connection):
            with self.assertRaisesRegex(ValueError, "active CCTV-Operator"):
                module.cmd_set_account_alias(args)

        connection.rollback.assert_called_once_with()
        connection.commit.assert_not_called()

    def test_register_rolls_back_when_camera_is_unknown(self):
        module = load_module()
        cursor = mock.MagicMock()
        cursor.__enter__.return_value = cursor
        cursor.fetchone.return_value = None
        connection = mock.MagicMock()
        connection.cursor.return_value = cursor
        args = types.SimpleNamespace(
            node_id="edge-new",
            camera_id="CAMERA-MISSING",
            alias_mode="fixed",
            public_key=pathlib.Path("node.pub"),
        )

        with mock.patch.object(module, "connect", return_value=connection), mock.patch.object(
            module, "load_public_key", return_value=("PUBLIC PEM\n", "SHA256:fingerprint")
        ):
            with self.assertRaisesRegex(ValueError, "does not exist"):
                module.cmd_register(args)

        connection.rollback.assert_called_once_with()
        connection.commit.assert_not_called()
        connection.close.assert_called_once_with()

    def test_rotate_key_increments_version_and_reactivates_registration(self):
        module = load_module()
        cursor = mock.MagicMock()
        cursor.__enter__.return_value = cursor
        cursor.fetchone.return_value = {"key_version": 3}
        connection = mock.MagicMock()
        connection.__enter__.return_value = connection
        connection.cursor.return_value = cursor
        args = types.SimpleNamespace(
            node_id="edge-new",
            public_key=pathlib.Path("replacement.pub"),
        )

        with mock.patch.object(module, "connect", return_value=connection), mock.patch.object(
            module, "load_public_key", return_value=("NEW PUBLIC PEM\n", "SHA256:new")
        ):
            module.cmd_rotate_key(args)

        query, params = cursor.execute.call_args.args
        self.assertIn("key_version = key_version + 1", query)
        self.assertIn("active = TRUE", query)
        self.assertEqual(("NEW PUBLIC PEM\n", "SHA256:new", "edge-new"), params)
        connection.close.assert_called_once_with()

    def test_parser_exposes_atomic_account_alias_reconciliation(self):
        module = load_module()
        parser = module.build_parser()
        commands = next(
            action.choices for action in parser._actions if getattr(action, "choices", None)
        )

        self.assertIn(
            "reconcile-account-aliases",
            commands,
            "atomic account-alias reconciliation command is not implemented",
        )
        reconcile = commands["reconcile-account-aliases"]
        actions = {action.dest: action for action in reconcile._actions}
        self.assertTrue(actions["node_id"].required)
        self.assertEqual("_AppendAction", type(actions["node_id"]).__name__)
        self.assertTrue(actions["account_alias"].required)
        self.assertEqual("_AppendAction", type(actions["account_alias"]).__name__)
        self.assertFalse(actions["dry_run"].default)

    def test_reconcile_account_aliases_validates_then_writes_one_transaction(self):
        module = load_module()
        reconcile = require_callable(self, module, "reconcile_account_aliases")
        cursor = reconciliation_cursor()
        node_ids = ("edge-node-01", "edge-node-02", "edge-node-generic")
        account_aliases = (("operator", "CAM-01"), ("operator2", "CAM-02"))

        result = reconcile(cursor, node_ids, account_aliases, apply=True)

        calls = [call.args for call in cursor.execute.call_args_list]
        writes = [args for args in calls if args[0].lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE"))]
        first_write = next(index for index, args in enumerate(calls) if args in writes)
        self.assertGreaterEqual(first_write, 5, "all authority must be validated before writes")
        self.assertEqual(9, len(writes), "three policies and six account mappings are required")
        for query, params in writes:
            self.assertIsNotNone(params, "every write must use SQL parameters")
            self.assertNotIn("physical_cameras", query.lower())
            self.assertNotIn("detection_nodes", query.lower())
            self.assertNotIn("public_key", query.lower())
        policy_writes = [args for args in writes if "node_camera_alias_policy" in args[0]]
        mapping_writes = [args for args in writes if "node_account_camera_alias" in args[0]]
        self.assertEqual(3, len(policy_writes))
        self.assertEqual(6, len(mapping_writes))
        self.assertTrue(all("fixed_camera_id = NULL" in query for query, _ in policy_writes))
        self.assertEqual((101, 202, 303), tuple(result["physical_camera_ids"]))

    def test_reconcile_account_aliases_dry_run_performs_no_writes(self):
        module = load_module()
        reconcile = require_callable(self, module, "reconcile_account_aliases")
        cursor = reconciliation_cursor()

        result = reconcile(
            cursor,
            ("edge-node-01", "edge-node-02", "edge-node-generic"),
            (("operator", "CAM-01"), ("operator2", "CAM-02")),
            apply=False,
        )

        writes = [
            call.args[0]
            for call in cursor.execute.call_args_list
            if call.args[0].lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE"))
        ]
        self.assertEqual([], writes)
        self.assertFalse(result["applied"])
        self.assertEqual((101, 202, 303), tuple(result["physical_camera_ids"]))

    def test_reconcile_account_aliases_rejects_duplicate_or_malformed_inputs(self):
        module = load_module()
        parse_account_alias = require_callable(self, module, "parse_account_alias")
        reconcile = require_callable(self, module, "reconcile_account_aliases")

        self.assertEqual(("operator", "CAM-01"), parse_account_alias("Operator=CAM-01"))
        for invalid in ("operator", "=CAM-01", "operator=", "operator=CAM-01=extra"):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    parse_account_alias(invalid)

        duplicate_cases = (
            (("edge-node-01", "edge-node-01"), (("operator", "CAM-01"),)),
            (("edge-node-01",), (("operator", "CAM-01"), ("Operator", "CAM-02"))),
            ((), (("operator", "CAM-01"),)),
            (("edge-node-01",), ()),
        )
        for node_ids, aliases in duplicate_cases:
            with self.subTest(node_ids=node_ids, aliases=aliases):
                cursor = reconciliation_cursor()
                with self.assertRaises(ValueError):
                    reconcile(cursor, node_ids, aliases, apply=True)
                cursor.execute.assert_not_called()

    def test_reconcile_account_aliases_rejects_inactive_or_missing_authority(self):
        module = load_module()
        reconcile = require_callable(self, module, "reconcile_account_aliases")
        node_ids = ("edge-node-01", "edge-node-02", "edge-node-generic")
        aliases = (("operator", "CAM-01"), ("operator2", "CAM-02"))
        invalid_fixtures = (
            {"nodes": [{"node_id": "edge-node-01", "physical_camera_id": 101}]},
            {"users": [{"id": 11, "username": "operator", "role": "CCTV-Operator", "active": True}]},
            {"users": [
                {"id": 11, "username": "operator", "role": "CCTV-Operator", "active": True},
                {"id": 22, "username": "operator2", "role": "CCTV-Operator", "active": False},
            ]},
            {"cameras": [{"id": "CAM-01"}]},
        )

        for fixture in invalid_fixtures:
            with self.subTest(fixture=fixture):
                cursor = reconciliation_cursor(**fixture)
                with self.assertRaises(ValueError):
                    reconcile(cursor, node_ids, aliases, apply=True)
                writes = [
                    call.args[0]
                    for call in cursor.execute.call_args_list
                    if call.args[0].lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE"))
                ]
                self.assertEqual([], writes)

    def test_reconcile_account_aliases_rejects_unexpected_extra_account_mapping(self):
        module = load_module()
        reconcile = require_callable(self, module, "reconcile_account_aliases")
        cursor = reconciliation_cursor(
            mappings=[
                {"node_id": "edge-node-01", "user_id": 11, "logical_camera_id": "CAM-01"},
                {"node_id": "edge-node-01", "user_id": 999, "logical_camera_id": "CAM-02"},
            ]
        )

        with self.assertRaisesRegex(ValueError, "unexpected"):
            reconcile(
                cursor,
                ("edge-node-01", "edge-node-02", "edge-node-generic"),
                (("operator", "CAM-01"), ("operator2", "CAM-02")),
                apply=True,
            )

        writes = [
            call.args[0]
            for call in cursor.execute.call_args_list
            if call.args[0].lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE"))
        ]
        self.assertEqual([], writes)

    def test_reconcile_account_aliases_rolls_back_on_mapping_failure(self):
        module = load_module()
        handler = require_callable(self, module, "cmd_reconcile_account_aliases")
        cursor = reconciliation_cursor()
        cursor.__enter__.return_value = cursor

        def execute_or_fail(query, params=None):
            if query.lstrip().upper().startswith("INSERT") and "node_account_camera_alias" in query:
                raise _PsycopgError("simulated account-alias mapping write failure")

        cursor.execute.side_effect = execute_or_fail
        connection = mock.MagicMock()
        connection.cursor.return_value = cursor
        args = types.SimpleNamespace(
            node_id=["edge-node-01", "edge-node-02", "edge-node-generic"],
            account_alias=["operator=CAM-01", "operator2=CAM-02"],
            dry_run=False,
        )

        with mock.patch.object(module, "connect", return_value=connection):
            with self.assertRaisesRegex(_PsycopgError, "mapping write failure"):
                handler(args)

        connection.rollback.assert_called_once_with()
        connection.commit.assert_not_called()
        connection.close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
