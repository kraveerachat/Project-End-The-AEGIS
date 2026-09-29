"""aegisctl block-ip / unblock-ip / blocked-ips use only the helper socket client."""

from __future__ import annotations

import json

import pytest

from aegis_soc import cli
from aegis_soc.ip_containment import ContainmentUnavailable


class FakeClient:
    def __init__(self, response=None, error=None):
        self.requests = []
        self.response = response
        self.error = error

    def request(self, body):
        self.requests.append(body)
        if self.error is not None:
            raise self.error
        return self.response


def _run(argv, client):
    args = cli.build_parser().parse_args(argv)
    return args.handler(args, client=client)


def test_block_ip_sends_block_request(capsys):
    client = FakeClient({"ok": True, "changed": True, "operation": "block", "ip": "203.0.113.10",
                         "reason_code": "BLOCKED"})
    assert _run(["block-ip", "203.0.113.10"], client) == 0
    assert client.requests == [{"op": "block", "ip": "203.0.113.10"}]
    assert json.loads(capsys.readouterr().out)["reason_code"] == "BLOCKED"


def test_unblock_ip_sends_unblock_request_and_noop_succeeds(capsys):
    client = FakeClient({"ok": True, "changed": False, "operation": "unblock", "ip": "203.0.113.10",
                         "reason_code": "NOT_BLOCKED"})
    assert _run(["unblock-ip", "203.0.113.10"], client) == 0
    assert client.requests == [{"op": "unblock", "ip": "203.0.113.10"}]
    assert json.loads(capsys.readouterr().out)["changed"] is False


def test_blocked_ips_lists_current_set(capsys):
    client = FakeClient({"ok": True, "changed": False, "operation": "list", "ip": None,
                         "reason_code": "LISTED", "blocked": ["203.0.113.10"]})
    assert _run(["blocked-ips"], client) == 0
    assert client.requests == [{"op": "list"}]
    assert json.loads(capsys.readouterr().out)["blocked"] == ["203.0.113.10"]


def test_helper_rejection_returns_refused_exit_code(capsys):
    client = FakeClient({"ok": False, "changed": False, "operation": "block", "ip": None,
                         "reason_code": "PROTECTED_ADDRESS"})
    assert _run(["block-ip", "192.0.2.1"], client) == 2
    assert "PROTECTED_ADDRESS" in capsys.readouterr().out


def test_helper_unavailable_fails_clearly(capsys):
    client = FakeClient(error=ContainmentUnavailable("containment helper unavailable: FileNotFoundError"))
    assert _run(["unblock-ip", "203.0.113.10"], client) == 1
    assert "unavailable" in capsys.readouterr().err


@pytest.mark.parametrize("command", ["block-ip", "unblock-ip"])
def test_ip_argument_is_required(command):
    with pytest.raises(SystemExit):
        cli.build_parser().parse_args([command])
