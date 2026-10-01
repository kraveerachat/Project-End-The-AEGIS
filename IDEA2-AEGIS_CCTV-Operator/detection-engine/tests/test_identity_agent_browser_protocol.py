import base64
import pathlib
import sys
import unittest

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

ENGINE_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

from aegis_identity_agent.browser_protocol import (
    BROWSER_ASSOCIATION_DOMAIN,
    build_browser_assertion,
    canonical_browser_association_payload,
)
from aegis_identity_agent.key_store import IdentitySigner, PublicIdentity


def token(byte):
    return base64.urlsafe_b64encode(bytes([byte]) * 32).rstrip(b"=").decode("ascii")


CLAIMS = {
    "version": 1,
    "purpose": "AEGIS-BROWSER-NODE-ASSOCIATION-V1",
    "audience": "https://aegis.internal",
    "challenge_id": token(1),
    "challenge_nonce": token(2),
    "session_binding": token(3),
    "node_id": "edge-node-01",
    "key_version": 7,
    "issued_at_ms": 1_750_000_000_000,
    "expires_at_ms": 1_750_000_030_000,
}


class BrowserAssociationProtocolTests(unittest.TestCase):
    def test_canonical_payload_is_fixed_and_cross_domain_use_fails(self):
        payload = canonical_browser_association_payload(CLAIMS)
        self.assertEqual(BROWSER_ASSOCIATION_DOMAIN.encode(), payload.splitlines()[0])
        self.assertNotIn(b"AEGIS-AGENT-AUTH-V1", payload)
        with self.assertRaisesRegex(ValueError, "purpose"):
            canonical_browser_association_payload({**CLAIMS, "purpose": "AEGIS-AGENT-AUTH-V1"})

    def test_agent_appends_its_identity_and_signs_only_the_fixed_claim_set(self):
        private = Ed25519PrivateKey.generate()
        signer = IdentitySigner(private, PublicIdentity("edge-node-01", 7, "public", "fingerprint"))
        challenge = {key: value for key, value in CLAIMS.items() if key not in {"node_id", "key_version"}}
        assertion = build_browser_assertion(challenge, signer)
        self.assertEqual(CLAIMS, assertion["claims"])
        signature = base64.urlsafe_b64decode(assertion["signature"] + "==")
        private.public_key().verify(signature, canonical_browser_association_payload(CLAIMS))
        self.assertEqual({"claims", "signature"}, set(assertion))

    def test_unknown_identity_fields_and_invalid_tokens_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "field"):
            canonical_browser_association_payload({**CLAIMS, "camera_id": "CAM-01"})
        with self.assertRaisesRegex(ValueError, "challenge"):
            canonical_browser_association_payload({**CLAIMS, "challenge_id": "-" + CLAIMS["challenge_id"][1:]})


if __name__ == "__main__":
    unittest.main()
