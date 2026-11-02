"""IDEA3 graduated response policy: pure-function tests (no Core, no socket, no device).

The security property under test: detector evidence alone can at most reach HIGH, which only recommends a CUT to a human.
AUTO_CUT needs corroboration that a forged log line cannot supply, and it fires at most once per lockdown episode.
"""

from __future__ import annotations

import pytest

from aegis_soc import graduated_response as gr

IP = "203.0.113.7"
IP2 = "203.0.113.8"
IP3 = "203.0.113.9"


@pytest.fixture
def clock():
    return [1000.0]


@pytest.fixture
def engine(clock):
    return gr.GraduatedResponse(clock=lambda: clock[0])


def test_one_detector_rule_is_medium_and_asks_for_a_software_block(engine):
    decision = engine.observe(IP, gr.PORT_SCAN)
    assert (decision.level, decision.action, decision.score) == (gr.MEDIUM, gr.SOFTWARE_BLOCK, 30)
    assert decision.previous_level == gr.LOW and decision.escalated
    assert decision.mitre == ("T1046",)


def test_repeating_the_same_rule_never_climbs_by_itself(engine, clock):
    first = engine.observe(IP, gr.SSH_BRUTE_FORCE)
    for _ in range(20):
        clock[0] += 1
        again = engine.observe(IP, gr.SSH_BRUTE_FORCE)
    assert first.level == again.level == gr.MEDIUM
    assert again.action == gr.NONE and again.score == 40


def test_two_vectors_from_one_address_are_high_and_only_recommend_a_cut(engine, clock):
    engine.observe(IP, gr.PORT_SCAN)
    clock[0] += 10
    decision = engine.observe(IP, gr.SSH_BRUTE_FORCE)
    assert decision.level == gr.HIGH and decision.action == gr.RECOMMEND_CUT
    assert decision.score == 30 + 40 + gr.MULTI_VECTOR_BONUS
    assert not decision.corroborated


def test_detector_evidence_alone_never_reaches_critical_or_auto_cut(engine, clock):
    """Every detector kind, many times, from one address: capped at HIGH without corroboration."""
    decisions = []
    for kind in (gr.PORT_SCAN, gr.SSH_BRUTE_FORCE, gr.SYN_FLOOD, gr.GENERIC):
        for _ in range(5):
            clock[0] += 1
            decisions.append(engine.observe(IP, kind))
    assert max(d.score for d in decisions) >= gr.CRITICAL_SCORE
    assert {d.level for d in decisions} <= {gr.MEDIUM, gr.HIGH}
    assert gr.AUTO_CUT not in {d.action for d in decisions}
    assert not engine.auto_cut_latched


def test_a_single_forged_login_line_without_brute_force_is_not_a_compromise_signal(engine):
    decision = engine.observe(IP, gr.SSH_LOGIN_AFTER_FAILURES)
    assert decision.level == gr.LOW and decision.action == gr.NONE
    assert not decision.corroborated
    assert "ssh_login_after_failures+0_uncorroborated" in decision.reasons


def test_login_after_brute_force_is_critical_and_cuts_once(engine, clock):
    engine.observe(IP, gr.SSH_BRUTE_FORCE)
    clock[0] += 3
    decision = engine.observe(IP, gr.SSH_LOGIN_AFTER_FAILURES)
    assert (decision.level, decision.action, decision.corroborated) == (gr.CRITICAL, gr.AUTO_CUT, True)
    assert "T1078" in decision.mitre and "T1110" in decision.mitre
    assert engine.auto_cut_latched


def test_a_failed_core_block_corroborates_and_escalates(engine, clock):
    engine.observe(IP, gr.PORT_SCAN)
    clock[0] += 1
    engine.observe(IP, gr.SSH_BRUTE_FORCE)  # HIGH, 90
    decision = engine.containment_result(IP, confirmed=False)
    assert decision is not None
    assert (decision.level, decision.action) == (gr.CRITICAL, gr.AUTO_CUT)
    assert "containment_failed+60" in decision.reasons


def test_a_confirmed_block_followed_by_more_evidence_is_a_bypass(engine, clock):
    engine.observe(IP, gr.SYN_FLOOD)  # MEDIUM 50
    assert engine.containment_result(IP, confirmed=True) is None
    clock[0] += gr.POST_BLOCK_GRACE_SEC + 1
    decision = engine.observe(IP, gr.SYN_FLOOD)
    assert decision.corroborated and "post_containment_activity+60" in decision.reasons
    assert decision.score == 110 and (decision.level, decision.action) == (gr.CRITICAL, gr.AUTO_CUT)


def test_lines_already_in_flight_when_the_block_landed_are_not_a_bypass(engine, clock):
    engine.observe(IP, gr.SYN_FLOOD)
    engine.containment_result(IP, confirmed=True)
    clock[0] += gr.POST_BLOCK_GRACE_SEC - 1
    decision = engine.observe(IP, gr.SYN_FLOOD)
    assert not decision.corroborated and decision.level == gr.MEDIUM


def test_auto_cut_fires_once_per_episode_across_addresses(engine, clock):
    for address in (IP, IP2):
        engine.observe(address, gr.SSH_BRUTE_FORCE)
        clock[0] += 1
    first = engine.observe(IP, gr.SSH_LOGIN_AFTER_FAILURES)
    second = engine.observe(IP2, gr.SSH_LOGIN_AFTER_FAILURES)
    assert first.action == gr.AUTO_CUT
    assert second.level == gr.CRITICAL and second.action == gr.NONE
    engine.reset_episode()
    clock[0] += gr.DISTRIBUTED_WINDOW_SEC + 1  # keep IP3 out of the distributed-source rule
    third = engine.observe(IP3, gr.SSH_BRUTE_FORCE)
    clock[0] += 1
    assert engine.observe(IP3, gr.SSH_LOGIN_AFTER_FAILURES).action == gr.AUTO_CUT
    assert third.action == gr.SOFTWARE_BLOCK


def test_three_sources_at_medium_inside_the_window_are_a_distributed_attack(engine, clock):
    assert engine.observe(IP, gr.PORT_SCAN).level == gr.MEDIUM
    clock[0] += 5
    assert engine.observe(IP2, gr.PORT_SCAN).level == gr.MEDIUM
    clock[0] += 5
    decision = engine.observe(IP3, gr.PORT_SCAN)
    assert decision.level == gr.HIGH and decision.action == gr.RECOMMEND_CUT
    assert not decision.corroborated  # distributed alone still only recommends


def test_sources_outside_the_distributed_window_do_not_count(engine, clock):
    engine.observe(IP, gr.PORT_SCAN)
    clock[0] += gr.DISTRIBUTED_WINDOW_SEC + 1
    engine.observe(IP2, gr.PORT_SCAN)
    clock[0] += 1
    assert engine.observe(IP3, gr.PORT_SCAN).level == gr.MEDIUM


def test_old_evidence_expires_but_the_level_does_not_drop_within_the_episode(engine, clock):
    engine.observe(IP, gr.PORT_SCAN)
    engine.observe(IP, gr.SSH_BRUTE_FORCE)  # HIGH
    clock[0] += gr.EVIDENCE_WINDOW_SEC + 1
    decision = engine.observe(IP, gr.PORT_SCAN)
    assert decision.score == 30 and decision.level == gr.HIGH and decision.action == gr.NONE


def test_old_brute_force_does_not_corroborate_a_much_later_login(engine, clock):
    engine.observe(IP, gr.SSH_BRUTE_FORCE)
    clock[0] += gr.EVIDENCE_WINDOW_SEC + 1
    decision = engine.observe(IP, gr.SSH_LOGIN_AFTER_FAILURES)
    assert not decision.corroborated and decision.action == gr.NONE


@pytest.mark.parametrize("kind", sorted(gr.CORE_KINDS) + ["", "CUT_UPLINK", "restore"])
def test_core_only_or_unknown_kinds_are_refused_from_the_detector_path(engine, kind):
    with pytest.raises(ValueError):
        engine.observe(IP, kind)


@pytest.mark.parametrize("address", ["not-an-ip", "2001:db8::1", "999.1.1.1"])
def test_non_ipv4_addresses_are_refused(engine, address):
    with pytest.raises(ValueError):
        engine.observe(address, gr.PORT_SCAN)


def test_containment_result_for_an_unknown_address_does_nothing(engine):
    assert engine.containment_result(IP, confirmed=False) is None


def test_tracking_tables_are_bounded(engine, clock, monkeypatch):
    monkeypatch.setattr(gr, "MAX_TRACKED", 5)
    for i in range(20):
        clock[0] += 200  # beyond the distributed window, so no escalation side effects
        engine.observe(f"198.51.100.{i}", gr.PORT_SCAN)
    assert len(engine._tracks) == 5
    for _ in range(100):
        engine.observe(IP, gr.SYN_FLOOD)
    assert len(engine._tracks[IP].evidence) <= gr.MAX_EVIDENCE_PER_ADDRESS


def test_the_policy_module_has_no_io_or_command_primitives():
    import ast
    import inspect

    tree = ast.parse(inspect.getsource(gr))
    imported = {alias.name.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
    imported |= {(node.module or "").split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}
    assert imported <= {"__future__", "ipaddress", "collections", "dataclasses", "threading"}
    called = {node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", "")
              for node in ast.walk(tree) if isinstance(node, ast.Call)}
    assert not called & {"issue_command", "publish", "publish_command", "open", "block", "log_event", "send_alert"}
