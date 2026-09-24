"""L3 live failure 2026-09-24: `rfkill --output SOFT 1` is a usage error on util-linux 2.42 (an ID is only valid after
a command such as `list`), stderr was discarded, the empty state fell through to `rfkill_pre_state=0`, the radio was
never unblocked, and the regulatory gate then failed. These tests run the L3 rfkill logic against a fake `rfkill` that
implements the util-linux command grammar, plus a fake sysfs tree. No real rfkill, no real /sys writes.
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
HELPER = DEPLOY / "p4-l3-rfkill.sh"
APPLY = DEPLOY / "stages" / "L3" / "apply.sh"
ROLLBACK = DEPLOY / "stages" / "L3" / "rollback.sh"

FAKE_RFKILL = r'''#!/usr/bin/env bash
# util-linux 2.42 grammar: rfkill [options] command [identifier ...]; no command => usage error, exit 1.
cols=""; args=()
while [ $# -gt 0 ]; do
  case "$1" in
    -n|--noheadings) shift ;;
    -o|--output) cols=$2; shift 2 ;;
    --output=*) cols=${1#--output=}; shift ;;
    *) args+=("$1"); shift ;;
  esac
done
cmd=${args[0]:-}; ident=${args[1]:-}
case "$cmd" in
  list|block|unblock) ;;
  *) echo "Try 'rfkill --help' for more information." >&2; exit 1 ;;
esac
[ -n "${FAKE_LIST_FAIL:-}" ] && [ "$cmd" = list ] && exit 1
matches() { [ -z "$ident" ] || [ "$ident" = all ] || [ "$1" = "$ident" ] || [ "$2" = "$ident" ]; }
case "$cmd" in
  list)
    while read -r id type soft hard; do
      matches "$id" "$type" || continue
      out=(); for c in ${cols//,/ }; do case $c in ID) out+=("$id");; TYPE) out+=("$type");; SOFT) out+=("$soft");; HARD) out+=("$hard");; esac; done
      echo "${out[*]}"
      if [ -n "${FAKE_DUP_ROWS:-}" ]; then echo "${out[*]}"; fi
    done < "$FAKE_STATE"; exit 0 ;;
  block|unblock)
    echo "$cmd $ident" >> "$FAKE_LOG"
    [ -n "${FAKE_FAIL_CHANGE:-}" ] && exit 1
    [ -n "${FAKE_NOOP:-}" ] && exit 0
    new=blocked; [ "$cmd" = unblock ] && new=unblocked
    tmp=$(mktemp); while read -r id type soft hard; do matches "$id" "$type" && soft=$new; echo "$id $type $soft $hard"; done < "$FAKE_STATE" > "$tmp"; mv "$tmp" "$FAKE_STATE"; exit 0 ;;
esac
'''


@pytest.fixture()
def rig(tmp_path: Path):
    bindir = tmp_path / "bin"; bindir.mkdir()
    fake = bindir / "rfkill"; fake.write_text(FAKE_RFKILL); fake.chmod(0o755)
    state = tmp_path / "state"; log = tmp_path / "calls.log"; log.write_text("")
    state.write_text("0 bluetooth blocked unblocked\n1 wlan blocked unblocked\n")
    sysfs = tmp_path / "sys"
    (sysfs / "class/net/wlp0s20f3/phy80211/rfkill1").mkdir(parents=True)
    (sysfs / "class/net/wlp0s20f3/phy80211/rfkill1/index").write_text("1\n")
    work = tmp_path / "work"; work.mkdir()
    env = {**os.environ, "PATH": f"{bindir}:{os.environ['PATH']}", "FAKE_STATE": str(state), "FAKE_LOG": str(log)}
    for k in ("FAKE_LIST_FAIL", "FAKE_DUP_ROWS", "FAKE_FAIL_CHANGE", "FAKE_NOOP"):
        env.pop(k, None)
    return {"tmp": tmp_path, "state": state, "log": log, "sysfs": sysfs, "work": work, "env": env}


def bash(rig, snippet: str, **extra_env: str) -> subprocess.CompletedProcess[str]:
    env = {**rig["env"], **extra_env}
    return subprocess.run(["bash", "-c", f'. "{HELPER}"; {snippet}'], text=True, capture_output=True, env=env)


def prepare(rig, id_env: str = "", **extra):
    return bash(rig, f'l3_rfkill_prepare wlp0s20f3 "{rig["work"]}" "{id_env}" "{rig["sysfs"]}" || {{ echo "REASON=$L3_RFKILL_REASON"; exit 1; }}', **extra)


def calls(rig) -> list[str]:
    return [l for l in rig["log"].read_text().splitlines() if l]


def soft_of(rig, ident: str) -> str:
    return next(l.split()[2] for l in rig["state"].read_text().splitlines() if l.split()[0] == ident)


# ---- documents the live mechanism: the OLD inline logic against a util-linux-faithful rfkill ----
OLD_SNIPPET = '''
rfkill_id=1
hard_state=$(rfkill --noheadings --output HARD "$rfkill_id" 2>/dev/null | tr -d ' ')
[ "$hard_state" != "blocked" ] && [ "$hard_state" != "1" ] || { echo HARD_BLOCKED; exit 1; }
soft_state=$(rfkill --noheadings --output SOFT "$rfkill_id" 2>/dev/null | tr -d ' ')
if [ "$soft_state" = "blocked" ] || [ "$soft_state" = "1" ]; then echo pre=1; rfkill unblock "$rfkill_id"; else echo pre=0; fi
'''


def test_live_mechanism_old_logic_records_pre_state_zero_and_never_unblocks(rig):
    r = subprocess.run(["bash", "-c", OLD_SNIPPET], text=True, capture_output=True, env=rig["env"])
    assert r.stdout.strip() == "pre=0"          # radio IS soft-blocked, yet classified unblocked
    assert calls(rig) == [] and soft_of(rig, "1") == "blocked"


def test_old_hard_state_query_fails_open_when_it_cannot_be_read(rig):
    rig["state"].write_text("0 bluetooth blocked unblocked\n1 wlan blocked blocked\n")   # HARD blocked radio
    r = subprocess.run(["bash", "-c", OLD_SNIPPET], text=True, capture_output=True, env=rig["env"])
    assert "HARD_BLOCKED" not in r.stdout        # the old guard could not see a hard block either


# ---- fixed behaviour ----
def test_helper_exists():
    assert HELPER.is_file()


def test_blocked_target_records_pre_state_1_and_unblocks_exactly_id_1(rig):
    r = prepare(rig)
    assert r.returncode == 0, r.stdout + r.stderr
    assert (rig["work"] / "rfkill_id").read_text().strip() == "1"
    assert (rig["work"] / "rfkill_pre_state").read_text().strip() == "1"
    assert calls(rig) == ["unblock 1"]
    assert soft_of(rig, "1") == "unblocked" and soft_of(rig, "0") == "blocked"   # bluetooth untouched


def test_unblocked_target_records_pre_state_0_and_does_nothing(rig):
    rig["state"].write_text("0 bluetooth blocked unblocked\n1 wlan unblocked unblocked\n")
    r = prepare(rig)
    assert r.returncode == 0
    assert (rig["work"] / "rfkill_pre_state").read_text().strip() == "0" and calls(rig) == []


def test_never_uses_global_or_type_identifiers(rig):
    prepare(rig)
    for line in calls(rig):
        assert line.split()[1].isdigit(), line


def test_hard_blocked_fails_before_any_mutation(rig):
    rig["state"].write_text("0 bluetooth blocked unblocked\n1 wlan blocked blocked\n")
    r = prepare(rig)
    assert r.returncode != 0 and "RFKILL_HARD_BLOCKED" in r.stdout
    assert calls(rig) == [] and not (rig["work"] / "rfkill_pre_state").exists()


def test_hard_blocked_even_when_soft_unblocked_fails(rig):
    rig["state"].write_text("0 bluetooth blocked unblocked\n1 wlan unblocked blocked\n")
    assert "RFKILL_HARD_BLOCKED" in prepare(rig).stdout


def test_missing_sysfs_binding_fails_closed_no_fallback_to_first_wlan(rig):
    import shutil
    shutil.rmtree(rig["sysfs"] / "class/net/wlp0s20f3/phy80211")
    r = prepare(rig)
    assert r.returncode != 0 and "RFKILL_ID_NOT_FOUND" in r.stdout and calls(rig) == []


def test_two_rfkill_entries_under_the_interface_are_ambiguous(rig):
    d = rig["sysfs"] / "class/net/wlp0s20f3/phy80211/rfkill7"; d.mkdir(); (d / "index").write_text("7\n")
    r = prepare(rig)
    assert r.returncode != 0 and "RFKILL_ID_AMBIGUOUS" in r.stdout and calls(rig) == []


def test_env_id_must_match_the_sysfs_bound_id(rig):
    r = prepare(rig, id_env="0")
    assert r.returncode != 0 and "RFKILL_ID_MISMATCH" in r.stdout and calls(rig) == []
    assert prepare(rig, id_env="1").returncode == 0


def test_non_numeric_id_rejected(rig):
    (rig["sysfs"] / "class/net/wlp0s20f3/phy80211/rfkill1/index").write_text("wlan\n")
    assert "RFKILL_ID_NOT_FOUND" in prepare(rig).stdout


@pytest.mark.parametrize("extra,reason", [({"FAKE_LIST_FAIL": "1"}, "RFKILL_STATE_UNREADABLE"), ({"FAKE_DUP_ROWS": "1"}, "RFKILL_STATE_AMBIGUOUS")])
def test_unreadable_or_ambiguous_state_fails_closed(rig, extra, reason):
    r = prepare(rig, **extra)
    assert r.returncode != 0 and reason in r.stdout and calls(rig) == []


def test_wrong_type_or_garbage_values_rejected(rig):
    rig["state"].write_text("0 bluetooth blocked unblocked\n1 bluetooth blocked unblocked\n")
    assert "RFKILL_STATE_INVALID" in prepare(rig).stdout
    rig["state"].write_text("0 bluetooth blocked unblocked\n1 wlan maybe unblocked\n")
    assert "RFKILL_STATE_INVALID" in prepare(rig).stdout


def test_unblock_command_failure_reported(rig):
    r = prepare(rig, FAKE_FAIL_CHANGE="1")
    assert r.returncode != 0 and "RFKILL_UNBLOCK_FAILED" in r.stdout
    assert (rig["work"] / "rfkill_pre_state").read_text().strip() == "1"   # recorded BEFORE the mutation


def test_unblock_that_does_not_take_effect_is_detected(rig):
    r = prepare(rig, FAKE_NOOP="1")
    assert r.returncode != 0 and "RFKILL_UNBLOCK_NOT_EFFECTIVE" in r.stdout


def restore(rig, pre: str | None, ident: str = "1", **extra):
    if pre is not None:
        (rig["work"] / "rfkill_pre_state").write_text(pre + "\n")
    (rig["work"] / "rfkill_id").write_text(ident + "\n")
    return bash(rig, f'l3_rfkill_restore "{rig["work"]}" || {{ echo "REASON=$L3_RFKILL_REASON"; exit 1; }}', **extra)


def test_restore_blocks_exact_id_only_when_pre_state_was_blocked(rig):
    rig["state"].write_text("0 bluetooth blocked unblocked\n1 wlan unblocked unblocked\n")
    assert restore(rig, "1").returncode == 0
    assert calls(rig) == ["block 1"] and soft_of(rig, "1") == "blocked"


def test_restore_does_nothing_when_pre_state_was_unblocked_or_missing(rig):
    rig["state"].write_text("0 bluetooth blocked unblocked\n1 wlan unblocked unblocked\n")
    assert restore(rig, "0").returncode == 0 and calls(rig) == []
    (rig["work"] / "rfkill_pre_state").unlink()
    assert restore(rig, None).returncode == 0 and calls(rig) == []


def test_restore_rejects_non_numeric_id_and_reports_failure(rig):
    r = restore(rig, "1", ident="wifi")
    assert r.returncode != 0 and "RFKILL_ID_INVALID" in r.stdout and calls(rig) == []
    r = restore(rig, "1", FAKE_FAIL_CHANGE="1")
    assert r.returncode != 0 and "RFKILL_BLOCK_RESTORE_FAILED" in r.stdout


def test_restore_not_effective_detected(rig):
    rig["state"].write_text("0 bluetooth blocked unblocked\n1 wlan unblocked unblocked\n")
    r = restore(rig, "1", FAKE_NOOP="1")
    assert r.returncode != 0 and "RFKILL_RESTORE_NOT_EFFECTIVE" in r.stdout


# ---- wiring ----
def code(path: Path) -> str:
    return "\n".join(l for l in path.read_text().splitlines() if not l.lstrip().startswith("#"))


def test_apply_and_rollback_use_the_helper_and_not_the_broken_queries():
    a, r = code(APPLY), code(ROLLBACK)
    assert "p4-l3-rfkill.sh" in a and "l3_rfkill_prepare" in a
    assert "p4-l3-rfkill.sh" in r and "l3_rfkill_restore" in r
    for text in (a, r):
        assert "--output SOFT" not in text and "--output HARD" not in text
        assert 'rfkill unblock "$rfkill_id"' not in text and 'rfkill block "$rfkill_id"' not in text
    assert 'awk \'$2 == "wlan"' not in a          # no "first wlan rfkill" fallback


def test_helper_has_no_global_unblock_and_reads_state_with_list_command():
    h = code(HELPER)
    assert "list" in h and "unblock all" not in h and "unblock wifi" not in h and "unblock wlan" not in h
    assert "iw reg" not in h


def test_regulatory_gate_still_follows_the_unblock_and_precedes_profile_install():
    a = code(APPLY)
    assert a.index("l3_rfkill_prepare") < a.index("REGULATORY_DOMAIN_MISMATCH") < a.index("install -D") < a.index("nmcli connection up")
