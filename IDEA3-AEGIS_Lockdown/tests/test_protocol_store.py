"""Durable Protocol v1 Core store: sequence, commands, and replay rows (design §4.7, §7)."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from aegis_soc.paths import RuntimePaths, load_dotenv
from aegis_soc.protocol_store import SEQUENCE_CEILING, ProtocolStore, ProtocolStoreError

DEVICE = "test-device-01"
OTHER = "test-device-02"
T = 1_789_434_000
ENV_EXAMPLE = Path(__file__).resolve().parents[1] / "deploy" / "aegis-idea3-core.env.example"


class Clock:
    def __init__(self, now=T):
        self.now = now

    def __call__(self):
        return self.now


@pytest.fixture
def path(tmp_path):
    return tmp_path / "data" / "core-protocol.sqlite3"


@pytest.fixture
def store(path):
    instance = ProtocolStore(path, wall_clock=Clock())
    yield instance
    instance.close()


def _published(store, action="CUT_UPLINK"):
    reserved = store.reserve_command(DEVICE, action, T, T + 30)
    assert store.mark_published(reserved.msg_id) is True
    return reserved


def test_sequence_is_strictly_increasing_and_survives_reopen(path):
    first = ProtocolStore(path, wall_clock=Clock())
    one = first.reserve_command(DEVICE, "CUT_UPLINK", T, T + 30)
    two = first.reserve_command(DEVICE, "RESTORE_UPLINK", T, T + 30)
    first.close()
    second = ProtocolStore(path, wall_clock=Clock())
    three = second.reserve_command(DEVICE, "CUT_UPLINK", T, T + 30)
    other = second.reserve_command(OTHER, "CUT_UPLINK", T, T + 30)
    second.close()
    assert [one.seq, two.seq, three.seq] == [1, 2, 3]
    assert other.seq == 1
    assert len({one.msg_id, two.msg_id, three.msg_id, other.msg_id}) == 4
    assert all(len(item.msg_id) == 32 for item in (one, two, three))


def test_an_unpublished_reservation_burns_its_sequence(store):
    burned = store.reserve_command(DEVICE, "CUT_UPLINK", T, T + 30)
    assert store.mark_not_published(burned.msg_id) is True
    assert store.command(burned.msg_id)["state"] == "NOT_PUBLISHED"
    assert store.reserve_command(DEVICE, "CUT_UPLINK", T, T + 30).seq == burned.seq + 1


def test_the_allocator_fails_closed_at_the_signed_63_bit_ceiling(store, path):
    assert SEQUENCE_CEILING == 2**63 - 1
    with sqlite3.connect(path) as raw:
        raw.execute(
            "INSERT OR REPLACE INTO protocol_sequence (device_id, last_allocated_seq) VALUES (?, ?)",
            (DEVICE, SEQUENCE_CEILING),
        )
    with pytest.raises(ProtocolStoreError):
        store.reserve_command(DEVICE, "CUT_UPLINK", T, T + 30)
    with sqlite3.connect(path) as raw:
        assert raw.execute("SELECT COUNT(*) FROM protocol_commands").fetchone()[0] == 0


@pytest.mark.parametrize(("device", "action"), [(DEVICE, "REBOOT"), ("Bad_Device", "CUT_UPLINK")])
def test_reserve_refuses_unknown_actions_and_devices(store, device, action):
    with pytest.raises(ValueError):
        store.reserve_command(device, action, T, T + 30)


def test_seen_message_ids_are_durable_per_device(path):
    first = ProtocolStore(path, wall_clock=Clock())
    assert first.record_seen(DEVICE, "a" * 32, "STATUS") is True
    assert first.record_seen(DEVICE, "a" * 32, "STATUS") is False
    first.close()
    second = ProtocolStore(path, wall_clock=Clock())
    assert second.record_seen(DEVICE, "a" * 32, "ACK") is False
    assert second.record_seen(OTHER, "a" * 32, "STATUS") is True
    second.close()


def test_prune_removes_only_rows_older_than_the_retention(path):
    clock = Clock()
    store = ProtocolStore(path, wall_clock=clock)
    store.record_seen(DEVICE, "a" * 32, "STATUS")
    clock.now = T + 500
    store.record_seen(DEVICE, "b" * 32, "STATUS")
    clock.now = T + 601
    assert store.prune_seen(older_than_sec=600) == 1
    assert store.record_seen(DEVICE, "b" * 32, "STATUS") is False
    assert store.record_seen(DEVICE, "a" * 32, "STATUS") is True
    store.close()


def test_consume_ack_is_one_shot_and_requires_the_open_command_and_sequence(store):
    unpublished = store.reserve_command(DEVICE, "CUT_UPLINK", T, T + 30)
    assert store.consume_ack(DEVICE, unpublished.msg_id, unpublished.seq, "ACCEPTED", "1" * 32) is False
    command = _published(store)
    assert store.consume_ack(DEVICE, command.msg_id, command.seq + 1, "ACCEPTED", "2" * 32) is False
    assert store.consume_ack(OTHER, command.msg_id, command.seq, "ACCEPTED", "2" * 32) is False
    assert store.consume_ack(DEVICE, "f" * 32, command.seq, "ACCEPTED", "2" * 32) is False
    assert store.consume_ack(DEVICE, command.msg_id, command.seq, "ACCEPTED", "3" * 32) is True
    assert store.consume_ack(DEVICE, command.msg_id, command.seq, "ACCEPTED", "4" * 32) is False
    row = store.command(command.msg_id)
    assert (row["state"], row["ack_result"], row["ack_msg_id"]) == ("ACK_CONSUMED", "ACCEPTED", "3" * 32)


def test_status_correlates_once_for_an_open_command_before_or_after_its_ack(store):
    before_ack = _published(store)
    assert store.correlate_status(DEVICE, before_ack.msg_id, before_ack.seq + 1) is False
    assert store.correlate_status(DEVICE, before_ack.msg_id, before_ack.seq) is True
    assert store.correlate_status(DEVICE, before_ack.msg_id, before_ack.seq) is False
    after_ack = _published(store)
    assert store.consume_ack(DEVICE, after_ack.msg_id, after_ack.seq, "ACCEPTED", "5" * 32) is True
    assert store.correlate_status(DEVICE, after_ack.msg_id, after_ack.seq) is True


def test_restart_closes_open_commands_keeps_evidence_and_ignores_late_evidence(path):
    first = ProtocolStore(path, wall_clock=Clock())
    reserved = first.reserve_command(DEVICE, "CUT_UPLINK", T, T + 30)
    published = _published(first)
    acknowledged = _published(first)
    first.consume_ack(DEVICE, acknowledged.msg_id, acknowledged.seq, "ACCEPTED", "6" * 32)
    first.close()
    second = ProtocolStore(path, wall_clock=Clock())
    closed = second.close_open_commands_after_restart()
    assert sorted(closed) == sorted([reserved.msg_id, published.msg_id, acknowledged.msg_id])
    assert second.consume_ack(DEVICE, published.msg_id, published.seq, "ACCEPTED", "7" * 32) is False
    assert second.correlate_status(DEVICE, published.msg_id, published.seq) is False
    assert second.command(acknowledged.msg_id)["ack_msg_id"] == "6" * 32
    assert {second.command(item.msg_id)["state"] for item in (reserved, published, acknowledged)} == {"CLOSED"}
    assert second.reserve_command(DEVICE, "CUT_UPLINK", T, T + 30).seq == 4
    second.close()


def test_resync_moves_forward_only_for_the_open_correlated_command(store):
    first = _published(store)
    assert store.resync_forward(DEVICE, device_hwm=7, cmd_msg_id="e" * 32, cmd_seq=first.seq) is False
    assert store.resync_forward(DEVICE, device_hwm=7, cmd_msg_id=first.msg_id, cmd_seq=first.seq + 1) is False
    assert store.resync_forward(OTHER, device_hwm=7, cmd_msg_id=first.msg_id, cmd_seq=first.seq) is False
    assert store.resync_forward(DEVICE, device_hwm=7, cmd_msg_id=first.msg_id, cmd_seq=first.seq) is True
    assert store.resync_forward(DEVICE, device_hwm=7, cmd_msg_id=first.msg_id, cmd_seq=first.seq) is False
    second = _published(store)
    assert second.seq == 8
    assert store.resync_forward(DEVICE, device_hwm=3, cmd_msg_id=second.msg_id, cmd_seq=second.seq) is False
    assert store.reserve_command(DEVICE, "CUT_UPLINK", T, T + 30).seq == 9


def test_resync_never_uses_closed_or_unpublished_commands(store):
    unpublished = store.reserve_command(DEVICE, "CUT_UPLINK", T, T + 30)
    assert store.resync_forward(DEVICE, device_hwm=50, cmd_msg_id=unpublished.msg_id, cmd_seq=unpublished.seq) is False
    closed = _published(store)
    store.close_open_commands_after_restart()
    assert store.resync_forward(DEVICE, device_hwm=50, cmd_msg_id=closed.msg_id, cmd_seq=closed.seq) is False
    assert store.reserve_command(DEVICE, "CUT_UPLINK", T, T + 30).seq == 3


def test_resync_to_the_uint64_maximum_leaves_the_allocator_fail_closed(store):
    command = _published(store)
    assert store.resync_forward(DEVICE, device_hwm=2**64 - 1, cmd_msg_id=command.msg_id, cmd_seq=command.seq) is True
    with pytest.raises(ProtocolStoreError):
        store.reserve_command(DEVICE, "CUT_UPLINK", T, T + 30)


def test_store_is_durable_wal_with_full_synchronous_commits(store):
    assert store.pragma("journal_mode") == "wal"
    assert store.pragma("synchronous") == 2  # FULL


def test_store_refuses_a_relative_path():
    with pytest.raises(ValueError):
        ProtocolStore(Path("relative/core-protocol.sqlite3"))


def test_protocol_db_is_durable_data_never_runtime():
    values: dict[str, str] = {}
    load_dotenv(ENV_EXAMPLE, values)
    paths = RuntimePaths.from_environment(env=values, platform="linux")
    assert paths.protocol_db == Path("/var/lib/aegis-idea3/data/core-protocol.sqlite3")
    assert paths.protocol_db.parent == paths.dispatch_db.parent
    assert not paths.protocol_db.is_relative_to(paths.runtime_dir)
    assert not paths.protocol_db.is_relative_to(Path("/run"))
