import json
import pathlib
import sys
import unittest


ENGINE_ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO_ROOT = ENGINE_ROOT.parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

from aegis_identity_agent import protocol


VECTORS = json.loads(
    (REPO_ROOT / "IDEA2-AEGIS_Monitor" / "tests" / "fixtures" / "agentProofV1.json").read_text(
        encoding="utf-8"
    )
)


class AgentProtocolTests(unittest.TestCase):
    def test_auth_vector_matches_canonical_bytes(self):
        self.assertEqual("AEGIS-AGENT-AUTH-V1", protocol.AUTH_DOMAIN)
        self.assertEqual(
            VECTORS["auth"]["canonical"].encode("utf-8"),
            protocol.canonical_auth_payload(VECTORS["auth"]["fields"]),
        )

    def test_request_vector_matches_node_contract_and_rejects_cross_domain_use(self):
        self.assertEqual(
            VECTORS["request"]["canonical"].encode("utf-8"),
            protocol.canonical_request_payload(VECTORS["request"]["fields"]),
        )
        altered = {**VECTORS["request"]["fields"], "domain": "AEGIS-ENGINE-DETECTION-V1"}
        with self.assertRaisesRegex(ValueError, "domain"):
            protocol.canonical_request_payload(altered)

    def test_all_request_domains_are_distinct_and_route_bound(self):
        self.assertEqual(
            {
                "heartbeat": {
                    "domain": "AEGIS-AGENT-HEARTBEAT-V1",
                    "method": "POST",
                    "path": "/internal/heartbeat",
                },
                "detection": {
                    "domain": "AEGIS-ENGINE-DETECTION-V1",
                    "method": "POST",
                    "path": "/internal/detections",
                },
                "alert": {
                    "domain": "AEGIS-ENGINE-ALERT-V1",
                    "method": "POST",
                    "path": "/internal/alerts",
                },
                "clip": {
                    "domain": "AEGIS-ENGINE-CLIP-V1",
                    "method": "POST",
                    "path": "/internal/clips",
                },
            },
            protocol.REQUEST_PROOFS,
        )
        self.assertEqual(4, len({item["domain"] for item in protocol.REQUEST_PROOFS.values()}))

    def test_token_and_integer_parsers_enforce_canonical_boundaries(self):
        token = VECTORS["auth"]["fields"]["challengeId"]
        self.assertEqual(token, protocol.parse_canonical_token(token, 32, "challenge"))
        for invalid in (token + "=", "-" + token[1:], "_" + token[1:], "!" + token[1:]):
            with self.subTest(invalid=invalid):
                with self.assertRaisesRegex(ValueError, "challenge"):
                    protocol.parse_canonical_token(invalid, 32, "challenge")
        self.assertEqual(0, protocol.parse_uint("0", label="sequence"))
        self.assertEqual((1 << 64) - 1, protocol.parse_uint(str((1 << 64) - 1), label="sequence"))
        for invalid in ("", "-1", "+1", "01", "1.0", str(1 << 64)):
            with self.subTest(invalid=invalid):
                with self.assertRaisesRegex(ValueError, "sequence"):
                    protocol.parse_uint(invalid, label="sequence")

    def test_strict_json_bytes_reject_duplicate_keys_invalid_utf8_and_size_overflow(self):
        self.assertEqual(
            {"nodeId": "edge-a"},
            protocol.parse_strict_json_bytes(b'{"nodeId":"edge-a"}'),
        )
        with self.assertRaisesRegex(ValueError, "duplicate"):
            protocol.parse_strict_json_bytes(b'{"nodeId":"edge-a","nodeId":"edge-b"}')
        with self.assertRaisesRegex(ValueError, "UTF-8"):
            protocol.parse_strict_json_bytes(b"\xc3\x28")
        with self.assertRaisesRegex(ValueError, "object"):
            protocol.parse_strict_json_bytes(b"[]")
        with self.assertRaisesRegex(ValueError, "size"):
            protocol.parse_strict_json_bytes(b" " * (16 * 1024 + 1))

    def test_canonical_builders_reject_unknown_fields(self):
        with self.assertRaisesRegex(ValueError, "field"):
            protocol.canonical_auth_payload({**VECTORS["auth"]["fields"], "extra": "not-signed"})
        with self.assertRaisesRegex(ValueError, "field"):
            protocol.canonical_request_payload({**VECTORS["request"]["fields"], "extra": "not-signed"})


if __name__ == "__main__":
    unittest.main()
