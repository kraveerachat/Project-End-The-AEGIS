"""The optional, allowlisted ``graduated`` section of the Core status projection (synthetic TEST_ONLY data, no network).

The Core writes graduated-status.json (display data only). The publisher and the push client read it through a fail-closed gate
(regular file, bounded, schema version 1, never a symlink), copy only an allowlist of fields, and leave the section out when the
file is missing or invalid. Nothing here adds a command path: the envelope keeps its four keys and the web never receives RESTORE data.
"""

from __future__ import annotations

import json
import os

import pytest

from tools import status_projection_publisher as publisher
from tools import status_push_client as client

NOW = 1_700_000_100.0
URL = "https://idea3-core.aegis.internal/security/api/machine/v1"


def _core_status(**changes):
    value = {
        "state": "RUNNING", "profile": "production", "dry_run": False, "auto_contain": False,
        "broker": "CONNECTED", "device": "ONLINE", "uplink": "NORMAL", "armed": "MONITOR_ONLY",
        "dispatch": "DISABLED", "time_trust": "SYNCED", "updated_at": NOW - 5, "components": {"detector": "RUNNING"},
        "pid": 4242, "detail": "token=SHOULD-NOT-LEAK", "secret": "hunter2",
    }
    value.update(changes)
    return value


def _decision(**changes):
    value = {
        "at": NOW - 30, "attacker_ip": "203.0.113.7", "kind": "port_scan", "level": "MEDIUM", "action": "SOFTWARE_BLOCK",
        "outcome": "BLOCKED", "score": 30, "corroborated": False, "reasons": ["port_scan+30"], "mitre": ["T1046"],
        "extra": "dropped",
    }
    value.update(changes)
    return value


def _graduated(**changes):
    value = {
        "v": 1, "updated_at": NOW - 30, "auto_cut_latched": False, "highest_level": "MEDIUM", "cut_recommended_for": None,
        "decisions": [_decision()], "unknown_top_level": "dropped",
    }
    value.update(changes)
    return value


def _write(path, document):
    path.write_text(document if isinstance(document, str) else json.dumps(document), encoding="utf-8")
    return path


@pytest.fixture
def core_dir(tmp_path):
    directory = tmp_path / "core"
    directory.mkdir(mode=0o700)
    _write(directory / "status.json", _core_status())
    return directory


# ---------------------------------------------------------------------------------------------------- the file gate


def test_a_missing_file_means_no_section(tmp_path):
    assert publisher.load_graduated(tmp_path / publisher.GRADUATED_NAME) is None
    assert publisher.load_graduated(None) is None


def test_a_symlink_is_never_followed(tmp_path):
    target = _write(tmp_path / "real.json", _graduated())
    link = tmp_path / publisher.GRADUATED_NAME
    link.symlink_to(target)
    assert publisher.load_graduated(link) is None


@pytest.mark.parametrize("kind", ["directory", "fifo"])
def test_only_a_regular_file_is_read(tmp_path, kind):
    path = tmp_path / publisher.GRADUATED_NAME
    if kind == "directory":
        path.mkdir()
    else:
        os.mkfifo(path)
    assert publisher.load_graduated(path) is None


def test_an_oversized_file_is_refused(tmp_path):
    big = _graduated(decisions=[_decision()] * 3000)
    path = _write(tmp_path / publisher.GRADUATED_NAME, big)
    assert path.stat().st_size > publisher.GRADUATED_MAX_BYTES
    assert publisher.load_graduated(path) is None


@pytest.mark.parametrize("text", ["", "not json", "[]", "null", '{"v": 1}', '{"v": 2, "decisions": []}', '{"v": "1", "decisions": []}',
                                  '{"v": true, "decisions": []}', '{"v": 1, "decisions": {}}'])
def test_a_wrong_schema_or_shape_is_refused(tmp_path, text):
    assert publisher.load_graduated(_write(tmp_path / publisher.GRADUATED_NAME, text)) is None


def test_invalid_utf8_is_refused(tmp_path):
    path = tmp_path / publisher.GRADUATED_NAME
    path.write_bytes(b'{"v": 1, "decisions": [], "x": "\xff\xfe"}')
    assert publisher.load_graduated(path) is None


@pytest.mark.parametrize("change", [
    {"highest_level": "SEVERE"}, {"highest_level": None}, {"highest_level": "high"},
    {"cut_recommended_for": "2001:db8::1"}, {"cut_recommended_for": "not-an-ip"}, {"cut_recommended_for": 7},
    {"updated_at": None}, {"updated_at": "yesterday"}, {"updated_at": True}, {"updated_at": float("nan")}, {"updated_at": 1e30},
    {"auto_cut_latched": "yes"}, {"auto_cut_latched": 1},
])
def test_an_invalid_top_level_means_no_section(tmp_path, change):
    path = tmp_path / publisher.GRADUATED_NAME
    path.write_text(json.dumps(_graduated(**change), allow_nan=True), encoding="utf-8")
    assert publisher.load_graduated(path) is None


# ---------------------------------------------------------------------------------------------------- the allowlist


def test_only_the_allowlisted_fields_survive(tmp_path):
    section = publisher.load_graduated(_write(tmp_path / publisher.GRADUATED_NAME, _graduated(
        cut_recommended_for="203.0.113.7", auto_cut_latched=True, highest_level="CRITICAL")))
    assert set(section) == {"schemaVersion", "updatedAt", "highestLevel", "cutRecommendedFor", "autoCutLatched", "decisions"}
    assert section["highestLevel"] == "CRITICAL" and section["cutRecommendedFor"] == "203.0.113.7" and section["autoCutLatched"] is True
    (decision,) = section["decisions"]
    assert set(decision) == {"at", "attackerIp", "kind", "level", "action", "outcome", "score", "mitre"}
    text = json.dumps(section)
    for dropped in ("reasons", "corroborated", "extra", "unknown_top_level", "port_scan+30", "dropped"):
        assert dropped not in text


def test_times_are_utc_iso_strings(tmp_path):
    section = publisher.load_graduated(_write(tmp_path / publisher.GRADUATED_NAME, _graduated()))
    assert section["updatedAt"] == "2023-11-14T22:14:30Z" and section["decisions"][0]["at"] == "2023-11-14T22:14:30Z"


def test_an_empty_outcome_is_projected_as_none(tmp_path):
    document = _graduated(decisions=[_decision(level="LOW", action="NONE", outcome="", score=10)])
    (decision,) = publisher.load_graduated(_write(tmp_path / publisher.GRADUATED_NAME, document))["decisions"]
    assert decision["outcome"] == "NONE" and decision["action"] == "NONE"


@pytest.mark.parametrize("change", [
    {"attacker_ip": "2001:db8::7"}, {"attacker_ip": "300.1.1.1"}, {"attacker_ip": "203.0.113.7 "}, {"attacker_ip": 5},
    {"kind": "mass_delete"}, {"level": "SEVERE"}, {"action": "RESTORE"}, {"outcome": "RESTORED"},
    {"score": True}, {"score": -1}, {"score": publisher.GRADUATED_MAX_SCORE + 1}, {"score": 1.5}, {"at": "now"}, {"at": None},
    {"mitre": "T1046"}, {"mitre": None},
])
def test_a_decision_outside_the_vocabulary_is_dropped_not_repaired(tmp_path, change):
    document = _graduated(decisions=[_decision(**change), _decision(attacker_ip="198.51.100.9")])
    decisions = publisher.load_graduated(_write(tmp_path / publisher.GRADUATED_NAME, document))["decisions"]
    assert [d["attackerIp"] for d in decisions] == ["198.51.100.9"]


def test_there_is_no_restore_vocabulary_anywhere_in_the_section():
    for vocabulary in (publisher.GRADUATED_ACTIONS, publisher.GRADUATED_OUTCOMES):
        assert not [word for word in vocabulary if "RESTORE" in word]


def test_mitre_ids_are_checked_deduplicated_and_bounded(tmp_path):
    ids = ["T1046", "T1046", "T1110.001", "bogus", "T10", "t1046", "T1078", "T1498", "T1595", "T1190", "T1133", "T1059"]
    section = publisher.load_graduated(_write(tmp_path / publisher.GRADUATED_NAME, _graduated(decisions=[_decision(mitre=ids)])))
    assert section["decisions"][0]["mitre"] == ["T1046", "T1110.001", "T1078", "T1498", "T1595", "T1190"]


def test_only_the_newest_decisions_are_kept(tmp_path):
    decisions = [_decision(attacker_ip=f"203.0.113.{n}", at=NOW - 100 + n) for n in range(1, 10)]
    section = publisher.load_graduated(_write(tmp_path / publisher.GRADUATED_NAME, _graduated(decisions=decisions)))
    assert [d["attackerIp"] for d in section["decisions"]] == [f"203.0.113.{n}" for n in range(5, 10)]
    assert len(section["decisions"]) == publisher.GRADUATED_MAX_DECISIONS


# ---------------------------------------------------------------------------------------------------- the projection


def test_without_a_section_the_projection_is_unchanged():
    document = _core_status()
    plain = publisher.build_projection(document, published_at=NOW)
    assert "graduated" not in plain["web_projection"]
    assert publisher.build_projection(document, published_at=NOW, graduated=None) == plain


def test_a_section_is_added_to_the_web_projection_only_and_as_a_copy(tmp_path):
    section = publisher.load_graduated(_write(tmp_path / publisher.GRADUATED_NAME, _graduated()))
    projection = publisher.build_projection(_core_status(), published_at=NOW, graduated=section)
    assert projection["web_projection"]["graduated"] == section
    assert "graduated" not in {key for key in projection if key != "web_projection"}
    section["highestLevel"] = "LOW"
    assert projection["web_projection"]["graduated"]["highestLevel"] == "MEDIUM", "the projection holds a copy"


def test_publish_once_picks_up_the_file_beside_status_json(core_dir, tmp_path):
    _write(core_dir / publisher.GRADUATED_NAME, _graduated())
    destination = tmp_path / "out"
    destination.mkdir(mode=0o700)
    assert publisher.publish_once(core_dir / "status.json", destination, now=NOW).published
    web = json.loads((destination / publisher.OUTPUT_NAME).read_text())["web_projection"]
    assert web["graduated"]["highestLevel"] == "MEDIUM"


def test_publish_once_without_or_with_an_invalid_file_still_publishes_status_without_the_section(core_dir, tmp_path):
    destination = tmp_path / "out"
    destination.mkdir(mode=0o700)
    for content in (None, "garbage", _graduated(highest_level="SEVERE")):
        if content is not None:
            _write(core_dir / publisher.GRADUATED_NAME, content)
        assert publisher.publish_once(core_dir / "status.json", destination, now=NOW).published
        assert "graduated" not in json.loads((destination / publisher.OUTPUT_NAME).read_text())["web_projection"]


def test_publish_once_accepts_an_explicit_source(core_dir, tmp_path):
    elsewhere = _write(tmp_path / "elsewhere.json", _graduated(highest_level="HIGH"))
    destination = tmp_path / "out"
    destination.mkdir(mode=0o700)
    assert publisher.publish_once(core_dir / "status.json", destination, now=NOW, graduated_source=elsewhere).published
    assert json.loads((destination / publisher.OUTPUT_NAME).read_text())["web_projection"]["graduated"]["highestLevel"] == "HIGH"


# ---------------------------------------------------------------------------------------------------- the push


class Recorder:
    def __init__(self):
        self.calls = []

    def __call__(self, method, url, body, headers):
        self.calls.append((method, url, body, dict(headers)))
        return 200, b'{"status":"ACCEPTED"}'


def test_the_push_envelope_carries_the_section_and_keeps_its_four_keys(core_dir):
    _write(core_dir / publisher.GRADUATED_NAME, _graduated(cut_recommended_for="203.0.113.7", highest_level="HIGH"))
    transport = Recorder()
    assert client.StatusPusher(core_dir / "status.json", URL, transport).push_once(now=NOW).accepted
    envelope = json.loads(transport.calls[0][2])
    assert sorted(envelope) == ["projection", "schema", "sentAtMs", "version"]
    assert envelope["projection"]["graduated"]["cutRecommendedFor"] == "203.0.113.7"
    text = json.dumps(envelope)
    assert "RESTORE" not in text and "hunter2" not in text and "SHOULD-NOT-LEAK" not in text and "reasons" not in text


def test_the_push_without_a_file_has_no_section(core_dir):
    transport = Recorder()
    assert client.StatusPusher(core_dir / "status.json", URL, transport).push_once(now=NOW).accepted
    assert "graduated" not in json.loads(transport.calls[0][2])["projection"]


def test_the_worst_case_envelope_stays_under_the_push_size_bound(core_dir):
    worst = [
        _decision(attacker_ip="255.255.255.255", kind="ssh_login_after_failures", level="CRITICAL", action="RECOMMEND_CUT",
                  outcome="CUT_REFUSED", score=publisher.GRADUATED_MAX_SCORE, at=NOW - n,
                  mitre=["T1110.001", "T1078.003", "T1498.001", "T1595.002", "T1190", "T1133"])
        for n in range(publisher.GRADUATED_MAX_DECISIONS + 3)
    ]
    _write(core_dir / publisher.GRADUATED_NAME, _graduated(decisions=worst, cut_recommended_for="255.255.255.255",
                                                           auto_cut_latched=True, highest_level="CRITICAL"))
    transport = Recorder()
    assert client.StatusPusher(core_dir / "status.json", URL, transport).push_once(now=NOW).accepted
    body = transport.calls[0][2]
    assert len(body) < client.MAX_BODY_BYTES * 0.6, len(body)
    assert len(json.loads(body)["projection"]["graduated"]["decisions"]) == publisher.GRADUATED_MAX_DECISIONS


def test_an_explicit_push_source_overrides_the_sibling(core_dir, tmp_path):
    _write(core_dir / publisher.GRADUATED_NAME, _graduated(highest_level="LOW"))
    other = _write(tmp_path / "other.json", _graduated(highest_level="CRITICAL"))
    transport = Recorder()
    pusher = client.StatusPusher(core_dir / "status.json", URL, transport, graduated_source=other)
    assert pusher.push_once(now=NOW).accepted
    assert json.loads(transport.calls[0][2])["projection"]["graduated"]["highestLevel"] == "CRITICAL"


def test_the_publisher_gate_does_not_import_core_modules_for_the_section():
    import ast
    from pathlib import Path

    source = Path(publisher.__file__).read_text(encoding="utf-8")
    imported = {node.module for node in ast.walk(ast.parse(source)) if isinstance(node, ast.ImportFrom) and node.module}
    assert imported <= {"__future__", "datetime", "pathlib", "aegis_soc", "aegis_soc.status_projection"}


def test_the_graduated_push_matches_the_committed_cross_language_fixture(tmp_path):
    """The web contract tests read this fixture; it must be exactly what the publisher builds (regenerate it if the contract changes)."""
    from pathlib import Path

    document = {
        "state": "RUNNING", "profile": "production", "dry_run": False, "auto_contain": False, "broker": "CONNECTED",
        "device": "ONLINE", "uplink": "NORMAL", "armed": "MONITOR_ONLY", "dispatch": "DISABLED", "time_trust": "SYNCED",
        "updated_at": 1_700_000_095.0, "components": {"detector": "RUNNING"},
    }
    graduated = {
        "v": 1, "updated_at": 1_700_000_090.0, "auto_cut_latched": False, "highest_level": "HIGH", "cut_recommended_for": "203.0.113.7",
        "decisions": [
            {"at": 1_700_000_040.0, "attacker_ip": "203.0.113.7", "kind": "port_scan", "level": "MEDIUM", "action": "SOFTWARE_BLOCK",
             "outcome": "BLOCKED", "score": 30, "corroborated": False, "reasons": ["port_scan+30"], "mitre": ["T1046"]},
            {"at": 1_700_000_070.0, "attacker_ip": "203.0.113.7", "kind": "ssh_brute_force", "level": "HIGH", "action": "RECOMMEND_CUT",
             "outcome": "RECOMMENDED", "score": 70, "corroborated": False, "reasons": ["ssh_brute_force+40"], "mitre": ["T1110"]},
        ],
    }
    section = publisher.load_graduated(_write(tmp_path / publisher.GRADUATED_NAME, graduated))
    envelope = publisher.build_push_envelope(publisher.build_projection(document, published_at=1_700_000_100.0, graduated=section),
                                             sent_at_ms=1_700_000_100_000)
    fixture = Path(__file__).resolve().parents[1] / "web" / "tests" / "fixtures" / "core-status-push-graduated.json"
    assert json.loads(fixture.read_text(encoding="utf-8")) == envelope
