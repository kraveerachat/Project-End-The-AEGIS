import pathlib
import sys
import tempfile
import unittest


ENGINE_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

from aegis_identity_agent.key_store import (
    DpapiCurrentUserProtector,
    IdentityKeyStore,
    KeyStoreError,
)


class FakeProtector:
    def protect(self, plaintext, entropy):
        return b"DPAPI\0" + entropy + b"\0" + bytes(plaintext)[::-1]

    def unprotect(self, blob, entropy):
        prefix = b"DPAPI\0" + entropy + b"\0"
        if not blob.startswith(prefix):
            raise KeyStoreError("protected identity cannot be decrypted")
        return blob[len(prefix):][::-1]


class IdentityKeyStoreTests(unittest.TestCase):
    def store(self, path, **kwargs):
        return IdentityKeyStore(
            path,
            node_id="edge-a",
            key_version=4,
            protector=FakeProtector(),
            acl_validator=kwargs.pop("acl_validator", lambda _path: True),
            reparse_checker=kwargs.pop("reparse_checker", lambda _path: False),
            **kwargs,
        )

    def test_generate_is_create_new_encrypted_and_exports_public_only(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / "machine-identity.dpapi"
            store = self.store(path)
            public = store.generate()
            persisted = path.read_bytes()
            self.assertTrue(persisted.startswith(b"DPAPI\0"))
            self.assertNotIn(b"PRIVATE KEY", persisted)
            self.assertIn("BEGIN PUBLIC KEY", public.public_key_pem)
            self.assertNotIn("PRIVATE", public.public_key_pem)
            self.assertEqual(64, len(public.fingerprint_sha256))
            self.assertEqual(public, store.load().public_identity)
            with self.assertRaises(KeyStoreError):
                store.generate()

    def test_missing_corrupt_wrong_identity_acl_and_reparse_fail_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / "machine-identity.dpapi"
            with self.assertRaises(KeyStoreError):
                self.store(path).load()
            path.write_bytes(b"corrupt")
            with self.assertRaises(KeyStoreError):
                self.store(path).load()
            with self.assertRaises(KeyStoreError):
                self.store(path, acl_validator=lambda _path: False).load()
            with self.assertRaises(KeyStoreError):
                self.store(path, reparse_checker=lambda _path: True).load()

    def test_signer_exposes_only_sign_and_public_metadata(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / "machine-identity.dpapi"
            signer = self.store(path).generate_signer()
            signature = signer.sign(b"bounded message")
            self.assertEqual(64, len(signature))
            self.assertFalse(hasattr(signer, "private_key_bytes"))
            self.assertNotIn("PRIVATE", repr(signer))

    def test_dpapi_adapter_uses_current_user_without_local_machine_flag(self):
        calls = []

        class FakeWin32Crypt:
            @staticmethod
            def CryptProtectData(data, description, entropy, _reserved, _prompt, flags):
                calls.append(("protect", flags, description))
                return b"protected"

            @staticmethod
            def CryptUnprotectData(data, entropy, _reserved, _prompt, flags):
                calls.append(("unprotect", flags, None))
                return ("AEGIS Identity Agent", b"plain")

        protector = DpapiCurrentUserProtector(win32crypt_module=FakeWin32Crypt)
        self.assertEqual(b"protected", protector.protect(b"plain", b"entropy"))
        self.assertEqual(b"plain", protector.unprotect(b"protected", b"entropy"))
        self.assertEqual([0, 0], [item[1] for item in calls])

    def test_preflight_and_provision_scripts_preserve_the_service_identity_boundary(self):
        scripts = ENGINE_ROOT / "windows" / "identity-agent"
        preflight = (scripts / "invoke_dpapi_preflight.ps1").read_text(encoding="utf-8")
        provision = (scripts / "provision_identity_key.ps1").read_text(encoding="utf-8")
        combined = preflight + provision
        self.assertIn("NT SERVICE\\AEGISIdentityAgent", combined)
        self.assertIn("CurrentUser", preflight)
        self.assertIn("PASS", preflight)
        self.assertIn("SYSTEM", combined)
        self.assertNotIn("LocalMachine", combined)
        self.assertNotIn("BEGIN PRIVATE KEY", combined)
        self.assertIn("Fingerprint", provision)
        self.assertIn("--preflight-output", preflight)
        self.assertNotIn("Get-WinEvent", preflight)
        self.assertIn("sc.exe config", provision)
        self.assertIn("--result-output", provision)
        self.assertNotIn("& $python $runner --generate-key", provision)
        self.assertIn("IdentityAgentProvisioning", combined)
        key_store_source = (ENGINE_ROOT / "aegis_identity_agent" / "key_store.py").read_text(encoding="utf-8")
        self.assertIn("GetSecurityDescriptorOwner", key_store_source)


if __name__ == "__main__":
    unittest.main()
