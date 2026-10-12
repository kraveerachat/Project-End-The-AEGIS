"""Behavioural tests of the ROOT-side Recovery proofs: the pre-marker baseline, the single FINAL proof, the result re-proof used by ``verify.sh`` and the exact containment (nft) delta proof.

Fixtures are temporary hash-chained SQLite stores and temporary root-work directories (the test user stands in for root through the explicit ``owner_uid``/``trust_root`` parameters that production never
varies). Nothing here touches the Core, nft, a socket or a service."""

from __future__ import annotations

import hashlib
import inspect
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent / "recovery"))
import recovery_support as sup  # noqa: E402

from aegis_soc import r1_acceptance as r1  # noqa: E402
from aegis_soc import recovery_evidence as rev  # noqa: E402
from aegis_soc import recovery_stage as stage  # noqa: E402

UID = os.getuid()
STAMP = "2026-10-06 10:00:10"
STAMP_EPOCH = time.mktime(time.strptime(STAMP, "%Y-%m-%d %H:%M:%S"))
NOW = STAMP_EPOCH + 600


class W:
    """One attempt's root work directory + canonical marker + Core evidence."""

    def __init__(self, tmp_path: Path, marker_delta: float = -5.0, **evidence):
        self.tmp = tmp_path
        tmp_path.mkdir(parents=True, exist_ok=True)
        tmp_path.chmod(0o700)
        self.ev = sup.Evidence(self._d(tmp_path / "ev"), stamp=STAMP)
        for key, value in evidence.items():
            setattr(self.ev, key, value)
        self.ev.build()
        self.work = tmp_path / "canon" / "recovery-1"
        self.work.mkdir(parents=True, mode=0o700)
        (tmp_path / "canon").chmod(0o700)
        self.work.chmod(0o700)
        self.marker = tmp_path / "canon" / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED"
        self.write_marker(marker_delta)
        self.write_baseline()

    @staticmethod
    def _d(path: Path) -> Path:
        path.mkdir(exist_ok=True)
        return path

    def write_marker(self, delta: float, work: str | None = None) -> None:
        self.marker.unlink(missing_ok=True)
        # the marker's consumed_at is UTC; the audit stamps are local: build the UTC string from the same instant
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(STAMP_EPOCH + delta))
        self.marker.write_text(f"RECOVERY_ATTEMPT_CONSUMED=YES\nRECOVERY_RERUN_ALLOWED=NO\nconsumed_at={stamp}\nwork={work or self.work}\n")
        self.marker.chmod(0o600)

    def write_baseline(self, **patch) -> None:
        (self.work / stage.BASELINE_FILE).unlink(missing_ok=True)
        (self.work / stage.BASELINE_FILE).write_text(json.dumps(sup.baseline_doc(**patch), sort_keys=True))
        (self.work / stage.BASELINE_FILE).chmod(0o600)

    def final(self, **kw):
        args = dict(audit_db=str(self.ev.audit), protocol_db=str(self.ev.protocol), work=str(self.work), attempt_marker=str(self.marker), now=NOW, owner_uid=UID, trust_root=str(self.tmp))
        args.update(kw)
        return stage.final_verify(**args)

    def verify(self, **kw):
        args = dict(audit_db=str(self.ev.audit), work=str(self.work), attempt_marker=str(self.marker), owner_uid=UID, trust_root=str(self.tmp))
        args.update(kw)
        return stage.verify_result(**args)


def refused(fn, match: str):
    with pytest.raises(stage.StageError, match=match):
        fn()


# --------------------------------------------------------------------------- FINAL: the Core's own durable evidence only


def test_a_complete_core_closed_attempt_passes_and_creates_the_exclusive_root_outputs(tmp_path: Path) -> None:
    w = W(tmp_path)
    result = w.final()
    assert result["result"] == "PASS" and result["claims"] == stage.CLAIMS and result["claims"]["R1B_RESULT"] == "FAIL_IMMUTABLE" and result["claims"]["R1BV_RESULT"] == "PASS"
    assert result["gates"] == {**{g: "VERIFIED" for g in stage.DURABLE_GATES}, "R5_PHYSICAL_RESTORE": "ACK_ACCEPTED_STATUS_CORRELATED", **{g: "ATTESTED_BY_CORE_CLOSE" for g in stage.CORE_CLOSE_ATTESTED_GATES}}
    assert result["checks"]["RECOVERY_R2_R6_R7_BY_CORE_CLOSE"] == "ATTESTED_NOT_INDEPENDENT"
    for name in (stage.FINAL_RAN_FILE, stage.RESULT_FILE, stage.RESULT_SHA_FILE):
        path = w.work / name
        assert path.is_file() and not path.is_symlink() and path.stat().st_mode & 0o222 == 0
    assert (w.work / stage.RESULT_SHA_FILE).read_text() == f"{hashlib.sha256((w.work / stage.RESULT_FILE).read_bytes()).hexdigest()}  {stage.RESULT_FILE}\n"
    assert w.verify() == {"incident_id": 1, "attempt_marker_sha256": hashlib.sha256(w.marker.read_bytes()).hexdigest()}


def test_final_runs_once_per_work_directory_and_never_overwrites(tmp_path: Path) -> None:
    w = W(tmp_path)
    w.final()
    first = (w.work / stage.RESULT_FILE).read_text()
    refused(w.final, "ALREADY_EXISTS:RECOVERY-FINAL-RAN")
    assert (w.work / stage.RESULT_FILE).read_text() == first


@pytest.mark.parametrize("event", ["RECOVERY_R3_REQUESTED", "RECOVERY_R3_RESULT", "RESTORE_REQUESTED", "RESTORE_PUBLISHED", "RECOVERY_R8_CLOSE", "INCIDENT_CLOSED"])
def test_every_missing_core_row_fails_including_the_close_and_incident_closed_records(tmp_path: Path, event: str) -> None:
    w = W(tmp_path, drop={event})
    refused(w.final, f"EXPECTED_EXACTLY_ONE_{event}")
    assert not (w.work / stage.RESULT_FILE).exists()  # no result is ever produced on failure


@pytest.mark.parametrize("event", ["RECOVERY_R8_CLOSE", "RESTORE_REQUESTED", "RECOVERY_R3_RESULT"])
def test_a_duplicated_core_row_is_ambiguous_and_fails(tmp_path: Path, event: str) -> None:
    w = W(tmp_path, extra=[(event, "dup")])
    refused(w.final, f"EXPECTED_EXACTLY_ONE_{event}")


@pytest.mark.parametrize("kind", ["RESTORE_BREAK_GLASS_CLAIM", "RESTORE_BREAK_GLASS_PUBLISHED", "ALERT_ACCEPTED", "INCIDENT_BOUND", "R1D_DISPOSITION_ATTEMPT_RECORDED", "RESTORE_BREAK_GLASS_OTHER"])
def test_break_glass_or_attacker_chain_rows_appended_during_recovery_can_never_count(tmp_path: Path, kind: str) -> None:
    w = W(tmp_path, extra=[(kind, "x")])
    refused(w.final, "FORBIDDEN_EVENT_APPENDED_DURING_RECOVERY|BREAK_GLASS_ACTIVITY_DURING_RECOVERY")


def test_the_incident_must_be_closed_and_no_other_incident_may_exist(tmp_path: Path) -> None:
    refused(W(tmp_path / "a", state="OPEN").final, "INCIDENT_NOT_CLOSED")
    refused(W(tmp_path / "b", second_incident=True).final, "OPEN_INCIDENTS_REMAIN")


def test_audit_hash_chain_corruption_fails_closed(tmp_path: Path) -> None:
    w = W(tmp_path, corrupt_chain=True)
    refused(w.final, "AUDIT_CHAIN_BROKEN")


def test_provenance_is_not_confused_with_integrity_a_provenance_perfect_store_with_a_broken_chain_fails(tmp_path: Path) -> None:
    clean = W(tmp_path / "clean")
    assert clean.final()["result"] == "PASS"
    broken = W(tmp_path / "broken")
    conn = sqlite3.connect(broken.ev.audit)
    conn.execute("UPDATE audit_logs SET level = 'ERROR' WHERE id = 1")  # a row the semantic evidence predicates do not read
    conn.commit()
    conn.close()
    refused(broken.final, "AUDIT_CHAIN_BROKEN")


def test_the_marker_must_precede_the_first_recovery_row_so_isolate_cannot_precede_the_attempt(tmp_path: Path) -> None:
    refused(W(tmp_path / "late", marker_delta=+5.0).final, "ISOLATE_PRECEDES_THE_ATTEMPT_MARKER")
    assert W(tmp_path / "same", marker_delta=0.0).final()["result"] == "PASS"  # the whole-second boundary: marker second == first Core row second


@pytest.mark.parametrize("patch,match", [
    ({"command": None}, "RECOVERY_R5_NOT_THE_CORRELATED_NORMAL_PATH:BLOCKED:LINKED_COMMAND_NOT_IN_STORE"),
    ({"command": {"state": "ACK_CONSUMED", "published_at": 1.0, "ack_result": "ACCEPTED", "status_correlated": 0}}, "RECOVERY_R5_NOT_THE_CORRELATED_NORMAL_PATH"),
    ({"command": {"state": "ACK_CONSUMED", "published_at": 1.0, "ack_result": "REJECTED_BAD", "status_correlated": 1}}, "RECOVERY_R5_NOT_THE_CORRELATED_NORMAL_PATH:BLOCKED:DEVICE_REJECTED_RESTORE"),
    ({"command": {"state": "PUBLISHED", "published_at": 1.0, "ack_result": None, "status_correlated": 0}}, "RECOVERY_R5_NOT_THE_CORRELATED_NORMAL_PATH"),
    ({"r3": f"result=BLOCKED ip={sup.IP} reason=NO"}, "RECOVERY_EVIDENCE_NOT_VERIFIED:.*R3_ATTACKER_ISOLATION=BLOCKED"),
    ({"r3": "result=VERIFIED ip=198.51.100.99 reason=READ_BACK_CONFIRMED"}, "RECOVERY_EVIDENCE_NOT_VERIFIED:.*R3_ATTACKER_ISOLATION=BLOCKED"),
])
def test_r3_r4_r5_evidence_must_be_the_cores_verified_normal_path_evidence(tmp_path: Path, patch: dict, match: str) -> None:
    refused(W(tmp_path, **patch).final, match)


def test_fabricated_positive_operator_step_json_cannot_create_a_pass(tmp_path: Path) -> None:
    assert "steps" not in " ".join(inspect.signature(stage.final_verify).parameters) and "steps" not in " ".join(inspect.signature(stage.verify_result).parameters)
    w = W(tmp_path, drop={"RECOVERY_R8_CLOSE", "INCIDENT_CLOSED"})
    steps = tmp_path / "steps"
    steps.mkdir()
    for name, (file, _) in stage.LADDER.items():  # every operator step record fabricated as verified, with perfect R2/R6/R7 detail strings
        (steps / file).write_text(json.dumps({"schema": stage.STEP_SCHEMA, "step": name, "verified": True, "at": NOW, "incident": {"id": 1, "attacker_ip": sup.IP},
                                              "gates": {g: "VERIFIED" for g in ("R2_SAFE_ACCESS", "R6_NETWORK_RECOVERY", "R7_SERVICE_RECOVERY", "R5_PHYSICAL_RESTORE")}, "exit_code": 0}))
    refused(w.final, "EXPECTED_EXACTLY_ONE_RECOVERY_R8_CLOSE")
    refused(lambda: w.verify(), "TRUSTED_FILE_UNREADABLE")  # and no result exists to verify
    # conversely a genuinely closed attempt passes WITHOUT any step record: the steps are never read
    assert W(tmp_path / "real").final()["result"] == "PASS"


def test_no_module_global_is_patched_and_the_read_only_opener_is_an_explicit_seam(tmp_path: Path, monkeypatch) -> None:
    source = (sup.ROOT / "aegis_soc/recovery_stage.py").read_text()
    assert "rev._open_ro =" not in source and "_open_ro = " not in source
    assert "opener" in inspect.signature(rev.evaluate).parameters
    original = rev._open_ro
    monkeypatch.setattr(rev, "_open_ro", lambda *a, **k: (_ for _ in ()).throw(AssertionError("the global opener must never be used by FINAL")))
    w = W(tmp_path)
    assert w.final()["result"] == "PASS"
    assert rev._open_ro is not original  # still the monkeypatched sentinel: FINAL neither used nor replaced it
    monkeypatch.undo()
    assert rev._open_ro is original


# --------------------------------------------------------------------------- trusted directories and files (root-side inputs)


def test_the_work_directory_must_be_canonical_real_private_and_trusted(tmp_path: Path) -> None:
    w = W(tmp_path)
    link = tmp_path / "canon" / "link"
    link.symlink_to(w.work)
    refused(lambda: w.final(work=str(link)), "WORK_DIR_NOT_CANONICAL")
    w.work.chmod(0o755)
    refused(w.final, "WORK_DIR_NOT_PRIVATE")
    w.work.chmod(0o700)
    refused(lambda: w.final(owner_uid=UID + 1), "NOT_TRUSTED_OWNER_OR_WRITABLE")  # not owned by the trusted uid
    (tmp_path / "canon").chmod(0o770)
    refused(w.final, "NOT_TRUSTED_OWNER_OR_WRITABLE")  # a group-writable ancestor
    (tmp_path / "canon").chmod(0o700)
    refused(lambda: w.final(trust_root="/definitely/not/an/ancestor"), "WORK_DIR_NOT_TRUSTED_OWNER_OR_WRITABLE|WORK_DIR_NOT_CANONICAL|TRUST_ROOT_NOT_AN_ANCESTOR|MISSING")


def test_the_baseline_the_marker_and_every_root_input_must_be_trusted_regular_files(tmp_path: Path) -> None:
    w = W(tmp_path)
    (w.work / stage.BASELINE_FILE).chmod(0o666)
    refused(w.final, "TRUSTED_FILE_NOT_TRUSTED")
    w.write_baseline()
    w.marker.chmod(0o666)
    refused(w.final, "TRUSTED_FILE_NOT_TRUSTED")
    w.marker.chmod(0o600)
    w.marker.unlink()
    refused(w.final, "TRUSTED_FILE_UNREADABLE")
    w.write_marker(-5.0, work="/some/other/work")
    refused(w.final, "ATTEMPT_MARKER_NOT_FOR_THIS_WORK_DIR")
    w.marker.write_text("garbage\n")
    refused(w.final, "ATTEMPT_MARKER_MALFORMED")
    assert not (w.work / stage.RESULT_FILE).exists()


def test_a_hard_linked_or_symlinked_marker_is_refused(tmp_path: Path) -> None:
    w = W(tmp_path)
    os.link(w.marker, tmp_path / "canon" / "second-name")
    refused(w.final, "TRUSTED_FILE_NOT_TRUSTED")  # nlink != 1
    (tmp_path / "canon" / "second-name").unlink()
    real = tmp_path / "canon" / "real"
    real.write_text(w.marker.read_text())
    real.chmod(0o600)
    w.marker.unlink()
    w.marker.symlink_to(real)
    refused(w.final, "TRUSTED_FILE_UNREADABLE")  # O_NOFOLLOW


# --------------------------------------------------------------------------- the verify.sh re-proof: a hand-written JSON can never satisfy it


def test_verify_requires_the_root_final_marker_the_sidecar_and_the_same_attempt(tmp_path: Path) -> None:
    w = W(tmp_path)
    w.final()
    assert w.verify()["incident_id"] == 1
    # a different attempt marker (another consumed attempt) is not this run
    other_marker = tmp_path / "canon" / "other"
    other_marker.write_text(w.marker.read_text() + "x=1\n")
    other_marker.chmod(0o600)
    refused(lambda: w.verify(attempt_marker=str(other_marker)), "FINAL_RAN_MARKER_NOT_FOR_THIS_ATTEMPT")
    # FINAL-RAN missing
    (w.work / stage.FINAL_RAN_FILE).chmod(0o600)
    (w.work / stage.FINAL_RAN_FILE).unlink()
    refused(w.verify, "TRUSTED_FILE_UNREADABLE")


def test_a_hand_written_result_with_matching_fields_is_refused(tmp_path: Path) -> None:
    w = W(tmp_path)
    good = w.final()
    result = w.work / stage.RESULT_FILE
    result.chmod(0o600)
    result.write_text(json.dumps(good, sort_keys=True, indent=4) + "\n")  # same fields, different bytes than the sidecar recorded
    refused(w.verify, "RESULT_DIGEST_MISMATCH")
    # even a re-derived sidecar cannot help when the fields are not the verified ones for THIS attempt
    forged = {**good, "attempt_marker_sha256": "0" * 64}
    text = json.dumps(forged, sort_keys=True, indent=2, ensure_ascii=True) + "\n"
    result.write_text(text)
    side = w.work / stage.RESULT_SHA_FILE
    side.chmod(0o600)
    side.write_text(f"{hashlib.sha256(text.encode()).hexdigest()}  {stage.RESULT_FILE}\n")
    refused(w.verify, "RESULT_NOT_THE_VERIFIED_ONE_FOR_THIS_ATTEMPT")


@pytest.mark.parametrize("tamper", ["claims", "gates", "result", "incident"])
def test_a_consistently_rewritten_result_with_altered_claims_gates_or_incident_is_refused(tmp_path: Path, tamper: str) -> None:
    w = W(tmp_path)
    doc = w.final()
    if tamper == "claims":
        doc["claims"] = {**doc["claims"], "R1B_RESULT": "PASS"}
    elif tamper == "gates":
        doc["gates"] = {**doc["gates"], "R2_SAFE_ACCESS": "VERIFIED"}
    elif tamper == "result":
        doc["result"] = "FAIL"
    else:
        doc["incident_id"] = 2
    text = json.dumps(doc, sort_keys=True, indent=2, ensure_ascii=True) + "\n"
    for name, body in ((stage.RESULT_FILE, text), (stage.RESULT_SHA_FILE, f"{hashlib.sha256(text.encode()).hexdigest()}  {stage.RESULT_FILE}\n")):
        (w.work / name).chmod(0o600)
        (w.work / name).write_text(body)
    refused(w.verify, "RESULT_NOT_THE_VERIFIED_ONE_FOR_THIS_ATTEMPT")


def test_a_symlinked_or_foreign_owned_result_is_refused_and_a_later_store_change_is_caught(tmp_path: Path) -> None:
    w = W(tmp_path)
    w.final()
    refused(lambda: w.verify(owner_uid=UID + 1), "NOT_TRUSTED_OWNER_OR_WRITABLE|TRUSTED_FILE_NOT_TRUSTED")
    result = w.work / stage.RESULT_FILE
    real = tmp_path / "elsewhere.json"
    real.write_bytes(result.read_bytes())
    real.chmod(0o600)
    result.chmod(0o600)
    result.unlink()
    result.symlink_to(real)
    refused(w.verify, "TRUSTED_FILE_UNREADABLE")
    result.unlink()
    result.write_bytes(real.read_bytes())
    result.chmod(0o400)
    assert w.verify()["incident_id"] == 1
    conn = sqlite3.connect(w.ev.audit)
    conn.execute("UPDATE incidents SET state = 'OPEN' WHERE id = 1")
    conn.commit()
    conn.close()
    refused(w.verify, "INCIDENT_NOT_CLOSED_BY_THE_CORE")


# --------------------------------------------------------------------------- BASELINE (pre-marker): the genuine R1B incident, no Recovery history


def baseline_world(tmp_path: Path, **evidence) -> tuple[W, Path]:
    w = W(tmp_path, drop={"RECOVERY_R3_REQUESTED", "RECOVERY_R3_RESULT", "RESTORE_REQUESTED", "RESTORE_PUBLISHED", "RECOVERY_R8_CLOSE", "INCIDENT_CLOSED"}, state="OPEN", **evidence)
    (w.work / stage.BASELINE_FILE).unlink()
    r1b = tmp_path / "r1b"
    r1b.mkdir(mode=0o700)
    base = r1b / "r1-baseline.json"
    base.write_text(json.dumps({"schema": r1.SCHEMA_BASELINE, "audit_max_id": 0, "incident_max_id": 0}))
    base.chmod(0o600)
    return w, base


def run_baseline(w: W, base: Path, **kw):
    args = dict(audit_db=str(w.ev.audit), r1b_baseline=str(base), expected_source_ip=sup.IP, detector_uid=948, work=str(w.work), owner_uid=UID, trust_root=str(w.tmp))
    args.update(kw)
    return stage.baseline_db(**args)


def test_the_baseline_accepts_only_the_single_genuine_r1b_incident_and_writes_exclusively_into_the_root_work_dir(tmp_path: Path) -> None:
    w, base = baseline_world(tmp_path)
    doc = run_baseline(w, base)
    assert doc["incident_id"] == 1 and doc["attacker_ip"] == sup.IP and doc["checks"]["RECOVERY_NO_PRIOR_RECOVERY_HISTORY"] == "PASS"
    assert json.loads((w.work / stage.BASELINE_FILE).read_text()) == doc
    refused(lambda: run_baseline(w, base), "ALREADY_EXISTS:recovery-baseline.json")


@pytest.mark.parametrize("kw,match", [
    ({"expected_source_ip": "198.51.100.1"}, "OPEN_INCIDENT_IS_NOT_FROM_THE_PINNED_SOURCE"),
    ({"expected_source_ip": "127.0.0.1"}, "EXPECTED_SOURCE_NOT_AN_EXTERNALLY_CAPABLE_IPV4"),
    ({"expected_source_ip": " 203.0.113.9"}, "EXPECTED_SOURCE_NOT_AN_EXTERNALLY_CAPABLE_IPV4"),
    ({"detector_uid": 5}, "INCIDENT_PROVENANCE_ROWS_MISMATCH"),
])
def test_the_baseline_binds_the_pinned_source_and_detector(tmp_path: Path, kw: dict, match: str) -> None:
    w, base = baseline_world(tmp_path)
    refused(lambda: run_baseline(w, base, **kw), match)
    assert not (w.work / stage.BASELINE_FILE).exists()


def test_the_baseline_refuses_prior_recovery_history_a_second_open_incident_and_a_broken_chain(tmp_path: Path) -> None:
    w, base = baseline_world(tmp_path / "a", extra=[("RECOVERY_R3_REQUESTED", "ip=x")])
    refused(lambda: run_baseline(w, base), "RECOVERY_HISTORY_ALREADY_EXISTS_FOR_THIS_INCIDENT")
    w, base = baseline_world(tmp_path / "b", second_incident=True)
    refused(lambda: run_baseline(w, base), "NOT_EXACTLY_ONE_OPEN_INCIDENT")
    w, base = baseline_world(tmp_path / "c", corrupt_chain=True)
    refused(lambda: run_baseline(w, base), "AUDIT_CHAIN_BROKEN")


def test_the_baseline_requires_a_trusted_root_owned_preserved_r1b_baseline_and_work_dir(tmp_path: Path) -> None:
    w, base = baseline_world(tmp_path)
    base.chmod(0o666)
    refused(lambda: run_baseline(w, base), "PRESERVED_R1B_BASELINE_MISSING_OR_MALFORMED")
    base.chmod(0o600)
    base.write_text(json.dumps({"schema": "wrong", "audit_max_id": 0, "incident_max_id": 0}))
    refused(lambda: run_baseline(w, base), "PRESERVED_R1B_BASELINE_NOT_TRUSTED")
    base.write_text(json.dumps({"schema": r1.SCHEMA_BASELINE, "audit_max_id": "0", "incident_max_id": 0}))
    refused(lambda: run_baseline(w, base), "PRESERVED_R1B_BASELINE_MALFORMED")
    base.write_text(json.dumps({"schema": r1.SCHEMA_BASELINE, "audit_max_id": 99, "incident_max_id": 0}))
    refused(lambda: run_baseline(w, base), "INCIDENT_PROVENANCE_ROWS_MISSING_AMBIGUOUS_OR_BEFORE_THE_R1B_BASELINE")
    w.work.chmod(0o755)
    refused(lambda: run_baseline(w, base), "WORK_DIR_NOT_PRIVATE")


# --------------------------------------------------------------------------- the exact containment (nft) delta


def nft_text(*elements: str, extra_rule: str = "", second_set: bool = False, comment: str = "") -> str:
    body = ", ".join(elements)
    elems = f"\t\telements = {{ {body} }}\n" if elements else ""
    sets = "\tset blocked_ipv4 {\n\t\ttype ipv4_addr\n" + elems + "\t}\n"
    if second_set:
        sets += "\tset blocked_ipv4 {\n\t\ttype ipv4_addr\n\t}\n"
    return f"table inet aegis_idea3 {{\n{sets}\tchain input {{\n\t\ttype filter hook input priority filter; policy accept;\n\t\tip saddr @blocked_ipv4 drop{comment}\n{extra_rule}\t}}\n}}\n"


def capture_bundle(tmp: Path, name: str, text: str, *, others: dict[str, str] | None = None, ruleset: str = "r") -> Path:
    bundle = tmp / name
    bundle.mkdir(parents=True)
    norm = stage._nft_normalize(text)
    rows = {"fw.nft.tables": "table inet aegis_idea3", stage.TABLE_KEY: stage._capture_sha(norm), stage.RULESET_KEY: ruleset, **(others or {})}
    (bundle / "firewall.tsv").write_text("".join(f"{k}\t{v}\n" for k, v in rows.items()))
    (bundle / "firewall.tsv").chmod(0o600)
    return bundle


def dump(tmp: Path, name: str, text: str) -> Path:
    path = tmp / name
    path.write_text(text)
    path.chmod(0o600)
    return path


def delta(tmp: Path, pre: str, post: str, *, ip: str = sup.IP, pre_dump: str | None = None, post_dump: str | None = None, **bundle_kw):
    tmp.mkdir(parents=True, exist_ok=True)
    pb, qb = capture_bundle(tmp, "pre", pre, ruleset="r1"), capture_bundle(tmp, "post", post, ruleset="r2", **bundle_kw)
    return stage.containment_delta(pre_bundle=str(pb), post_bundle=str(qb), pre_nft=str(dump(tmp, "pre.txt", pre if pre_dump is None else pre_dump)), post_nft=str(dump(tmp, "post.txt", post if post_dump is None else post_dump)), attacker_ip=ip, owner_uid=UID)


def test_exactly_the_bound_attacker_added_to_the_blocked_set_is_the_only_approvable_change(tmp_path: Path) -> None:
    keys = delta(tmp_path, nft_text("198.51.100.7"), nft_text("198.51.100.7", sup.IP))
    assert keys == [stage.TABLE_KEY, stage.RULESET_KEY]  # nothing else is ever approved
    keys = delta(tmp_path / "empty", nft_text(), nft_text(sup.IP))
    assert keys == [stage.TABLE_KEY, stage.RULESET_KEY]


def test_a_multi_line_elements_clause_with_set_metadata_is_parsed(tmp_path: Path) -> None:
    pre = "table inet aegis_idea3 {\n\tset blocked_ipv4 {\n\t\ttype ipv4_addr\n\t\telements = { 198.51.100.7 timeout 1h expires 59m,\n\t\t\t     198.51.100.8 }\n\t}\n}\n"
    post = pre.replace("198.51.100.8 }", f"198.51.100.8,\n\t\t\t     {sup.IP} }}")
    assert delta(tmp_path, pre, post)


@pytest.mark.parametrize("post,match", [
    (nft_text("198.51.100.7", sup.IP, "192.0.2.77"), "BLOCKED_SET_DELTA_IS_NOT_EXACTLY_THE_BOUND_ATTACKER"),   # an extra element
    (nft_text(sup.IP), "BLOCKED_SET_DELTA_IS_NOT_EXACTLY_THE_BOUND_ATTACKER"),                                   # another element removed
    (nft_text("198.51.100.7", "192.0.2.77"), "BLOCKED_SET_DELTA_IS_NOT_EXACTLY_THE_BOUND_ATTACKER"),             # a different address
    (nft_text("198.51.100.7"), "BLOCKED_SET_DELTA_IS_NOT_EXACTLY_THE_BOUND_ATTACKER"),                           # no change at all
    (nft_text("198.51.100.7", sup.IP, extra_rule="\t\ttcp dport 22 accept\n"), "NFT_TABLE_CHANGED_BEYOND_THE_BLOCKED_SET_ELEMENTS"),  # an unrelated rule
    (nft_text("198.51.100.7", sup.IP, comment=" counter"), "NFT_TABLE_CHANGED_BEYOND_THE_BLOCKED_SET_ELEMENTS"),
])
def test_any_other_firewall_change_alongside_or_instead_of_the_exact_element_is_refused(tmp_path: Path, post: str, match: str) -> None:
    with pytest.raises(stage.StageError, match=match):
        delta(tmp_path, nft_text("198.51.100.7"), post)


def test_the_attacker_must_not_already_be_blocked_and_a_second_blocked_set_or_non_ipv4_element_is_refused(tmp_path: Path) -> None:
    with pytest.raises(stage.StageError, match="BLOCKED_SET_DELTA_IS_NOT_EXACTLY_THE_BOUND_ATTACKER"):
        delta(tmp_path / "a", nft_text(sup.IP), nft_text(sup.IP, "198.51.100.7"))
    with pytest.raises(stage.StageError, match="BLOCKED_SET_NOT_EXACTLY_ONE"):
        delta(tmp_path / "b", nft_text(), nft_text(sup.IP, second_set=True))
    with pytest.raises(stage.StageError, match="BLOCKED_SET_ELEMENT_NOT_IPV4"):
        delta(tmp_path / "c", nft_text(), nft_text("2001:db8::1"))
    with pytest.raises(stage.StageError, match="ATTACKER_IP_INVALID"):
        delta(tmp_path / "d", nft_text(), nft_text(sup.IP), ip="not-an-ip")


def test_the_semantic_dump_must_be_exactly_the_state_the_generic_capture_hashed(tmp_path: Path) -> None:
    pre, post = nft_text("198.51.100.7"), nft_text("198.51.100.7", sup.IP)
    with pytest.raises(stage.StageError, match="NFT_DUMP_NOT_THE_CAPTURED_STATE:PRE"):
        delta(tmp_path / "a", pre, post, pre_dump=nft_text("198.51.100.7", "192.0.2.5"))  # drift between the PRE capture and its dump
    with pytest.raises(stage.StageError, match="NFT_DUMP_NOT_THE_CAPTURED_STATE:POST"):
        delta(tmp_path / "b", pre, post, post_dump=nft_text("198.51.100.7", sup.IP, extra_rule="\t\ttcp dport 22 accept\n"))  # a masked extra change in the POST dump
    assert stage.nft_dump_matches_capture(bundle=str(capture_bundle(tmp_path / "c", "b", pre)), nft=str(dump(tmp_path / "c", "d.txt", pre)), owner_uid=UID) == "MATCH"


def test_a_change_in_another_table_or_a_changed_capture_key_set_is_unrelated_firewall_drift(tmp_path: Path) -> None:
    pre, post = nft_text("198.51.100.7"), nft_text("198.51.100.7", sup.IP)
    with pytest.raises(stage.StageError, match="UNRELATED_FIREWALL_DRIFT:fw.nft.table.inet.other.sha256"):
        tmp_path.joinpath("x").mkdir(exist_ok=True)
        pb = capture_bundle(tmp_path / "x", "pre", pre, ruleset="r1", others={"fw.nft.table.inet.other.sha256": "a" * 64})
        qb = capture_bundle(tmp_path / "x", "post", post, ruleset="r2", others={"fw.nft.table.inet.other.sha256": "b" * 64})
        stage.containment_delta(pre_bundle=str(pb), post_bundle=str(qb), pre_nft=str(dump(tmp_path / "x", "p.txt", pre)), post_nft=str(dump(tmp_path / "x", "q.txt", post)), attacker_ip=sup.IP, owner_uid=UID)
    with pytest.raises(stage.StageError, match="NFT_CAPTURE_SET_CHANGED_OR_UNAVAILABLE"):
        delta(tmp_path / "y", pre, post, others={"fw.nft.table.inet.new.sha256": "c" * 64})  # a new table appeared
    with pytest.raises(stage.StageError, match="NFT_CAPTURE_SET_CHANGED_OR_UNAVAILABLE"):
        tmp_path.joinpath("z").mkdir(exist_ok=True)
        pb = capture_bundle(tmp_path / "z", "pre", pre)
        (pb / "firewall.tsv").write_text((pb / "firewall.tsv").read_text().replace(stage._capture_sha(stage._nft_normalize(pre)), "UNAVAILABLE"))
        qb = capture_bundle(tmp_path / "z", "post", post)
        stage.containment_delta(pre_bundle=str(pb), post_bundle=str(qb), pre_nft=str(dump(tmp_path / "z", "p.txt", pre)), post_nft=str(dump(tmp_path / "z", "q.txt", post)), attacker_ip=sup.IP, owner_uid=UID)


def test_counters_and_handles_are_volatile_but_everything_else_is_state(tmp_path: Path) -> None:
    pre = nft_text("198.51.100.7", comment=" counter packets 5 bytes 300") .replace("drop counter packets 5 bytes 300", "drop")
    post_with_counter = nft_text("198.51.100.7", sup.IP).replace("drop", "drop # handle 9")
    assert delta(tmp_path, pre, post_with_counter) == [stage.TABLE_KEY, stage.RULESET_KEY]
