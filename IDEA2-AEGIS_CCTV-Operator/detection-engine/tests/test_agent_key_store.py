import pathlib
import sys
import tempfile
import types
import unittest
from unittest import mock


ENGINE_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

from aegis_identity_agent.key_store import (
    DpapiCurrentUserProtector,
    IdentityKeyStore,
    KeyStoreError,
    validate_windows_service_acl,
)


FILE_ALL_ACCESS = 0x1F01FF


class FakeSid:
    def __init__(self, canonical, display):
        self.canonical = canonical
        self.display = display

    def __str__(self):
        return self.display


class FakeDacl:
    def __init__(self, aces):
        self.aces = tuple(aces)

    def GetAceCount(self):
        return len(self.aces)

    def GetAce(self, index):
        return self.aces[index]


class FakeDescriptor:
    def __init__(self, owner, aces, *, protected=True):
        self.owner = owner
        self.dacl = None if aces is None else FakeDacl(aces)
        self.protected = protected

    def GetSecurityDescriptorControl(self):
        return (4 if self.protected else 0, 1)

    def GetSecurityDescriptorOwner(self):
        return self.owner

    def GetSecurityDescriptorDacl(self):
        return self.dacl


def windows_acl_modules(descriptor=None, *, descriptor_error=None):
    service_lookup = FakeSid("S-1-5-80-service", "service lookup")
    system_lookup = FakeSid("S-1-5-18", "system lookup")
    conversion_calls = []

    def get_named_security_info(*_args):
        if descriptor_error is not None:
            raise descriptor_error
        return descriptor

    def lookup_account_name(_system, account):
        if account == r"NT SERVICE\AEGISIdentityAgent":
            return service_lookup, "AEGIS"
        if account == r"NT AUTHORITY\SYSTEM":
            return system_lookup, "NT AUTHORITY"
        raise AssertionError(f"unexpected account lookup: {account}")

    def convert_sid_to_string_sid(sid):
        conversion_calls.append(sid)
        return sid.canonical

    win32security = types.SimpleNamespace(
        ACCESS_ALLOWED_ACE_TYPE=0,
        DACL_SECURITY_INFORMATION=2,
        INHERITED_ACE=16,
        OWNER_SECURITY_INFORMATION=1,
        SE_DACL_PROTECTED=4,
        SE_FILE_OBJECT=1,
        ConvertSidToStringSid=convert_sid_to_string_sid,
        GetNamedSecurityInfo=get_named_security_info,
        LookupAccountName=lookup_account_name,
    )
    ntsecuritycon = types.SimpleNamespace(FILE_ALL_ACCESS=FILE_ALL_ACCESS)
    return win32security, ntsecuritycon, conversion_calls


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

    def test_generate_signer_resumes_an_existing_bound_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / "machine-identity.dpapi"
            store = self.store(path)
            first = store.generate_signer().public_identity
            protected = path.read_bytes()
            resumed = store.generate_signer().public_identity
            self.assertEqual(first, resumed)
            self.assertEqual(protected, path.read_bytes())

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

    def test_windows_acl_accepts_exact_canonical_sids_without_equalsid(self):
        service_owner = FakeSid("S-1-5-80-service", "localized service display")
        service_ace = FakeSid("S-1-5-80-service", "different service display")
        system_ace = FakeSid("S-1-5-18", "localized system display")
        descriptor = FakeDescriptor(
            service_owner,
            (
                ((0, 0), FILE_ALL_ACCESS, service_ace),
                ((0, 0), FILE_ALL_ACCESS, system_ace),
            ),
        )
        win32security, ntsecuritycon, conversions = windows_acl_modules(descriptor)

        self.assertFalse(hasattr(win32security, "EqualSid"))
        with mock.patch.dict(
            sys.modules,
            {"win32security": win32security, "ntsecuritycon": ntsecuritycon},
        ):
            self.assertTrue(validate_windows_service_acl(pathlib.Path("identity")))

        self.assertGreaterEqual(len(conversions), 5)
        self.assertIn(service_owner, conversions)
        self.assertIn(service_ace, conversions)
        self.assertIn(system_ace, conversions)

    def test_windows_acl_rejects_wrong_owner_and_non_exact_ace_sets(self):
        service = FakeSid("S-1-5-80-service", "service")
        system = FakeSid("S-1-5-18", "system")
        other = FakeSid("S-1-5-32-544", "administrators")
        cases = {
            "wrong owner": FakeDescriptor(other, (((0, 0), FILE_ALL_ACCESS, service), ((0, 0), FILE_ALL_ACCESS, system))),
            "extra ace": FakeDescriptor(service, (((0, 0), FILE_ALL_ACCESS, service), ((0, 0), FILE_ALL_ACCESS, system), ((0, 0), FILE_ALL_ACCESS, other))),
            "duplicate ace": FakeDescriptor(service, (((0, 0), FILE_ALL_ACCESS, service), ((0, 0), FILE_ALL_ACCESS, service))),
            "inherited ace": FakeDescriptor(service, (((0, 16), FILE_ALL_ACCESS, service), ((0, 0), FILE_ALL_ACCESS, system))),
            "deny ace": FakeDescriptor(service, (((1, 0), FILE_ALL_ACCESS, service), ((0, 0), FILE_ALL_ACCESS, system))),
            "insufficient rights": FakeDescriptor(service, (((0, 0), FILE_ALL_ACCESS - 1, service), ((0, 0), FILE_ALL_ACCESS, system))),
            "excess rights": FakeDescriptor(service, (((0, 0), FILE_ALL_ACCESS | 0x01000000, service), ((0, 0), FILE_ALL_ACCESS, system))),
            "unprotected dacl": FakeDescriptor(service, (((0, 0), FILE_ALL_ACCESS, service), ((0, 0), FILE_ALL_ACCESS, system)), protected=False),
            "missing dacl": FakeDescriptor(service, None),
        }

        for label, descriptor in cases.items():
            with self.subTest(label=label):
                win32security, ntsecuritycon, _conversions = windows_acl_modules(descriptor)
                with mock.patch.dict(
                    sys.modules,
                    {"win32security": win32security, "ntsecuritycon": ntsecuritycon},
                ):
                    self.assertFalse(validate_windows_service_acl(pathlib.Path("identity")))

    def test_windows_acl_unreadable_or_malformed_descriptor_fails_closed(self):
        win32security, ntsecuritycon, _conversions = windows_acl_modules(
            descriptor_error=OSError("descriptor unavailable")
        )
        with mock.patch.dict(
            sys.modules,
            {"win32security": win32security, "ntsecuritycon": ntsecuritycon},
        ):
            self.assertFalse(validate_windows_service_acl(pathlib.Path("identity")))

        malformed = types.SimpleNamespace(
            GetSecurityDescriptorControl=lambda: (_ for _ in ()).throw(ValueError("malformed"))
        )
        win32security, ntsecuritycon, _conversions = windows_acl_modules(malformed)
        with mock.patch.dict(
            sys.modules,
            {"win32security": win32security, "ntsecuritycon": ntsecuritycon},
        ):
            self.assertFalse(validate_windows_service_acl(pathlib.Path("identity")))

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
        self.assertIn("Invoke-CheckedServiceControl $ServiceName config", provision)
        self.assertIn("service must be stopped", combined)
        self.assertIn("WaitForStatus('Stopped'", combined)
        self.assertIn("--result-output", provision)
        self.assertNotIn("& $python $runner --generate-key", provision)
        self.assertIn("IdentityAgentProvisioning", combined)
        key_store_source = (ENGINE_ROOT / "aegis_identity_agent" / "key_store.py").read_text(encoding="utf-8")
        self.assertIn("GetSecurityDescriptorOwner", key_store_source)


if __name__ == "__main__":
    unittest.main()
