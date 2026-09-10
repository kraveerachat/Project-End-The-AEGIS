"""Outbound Telegram delivery boundary tests."""

import pytest

from aegis_soc import comms


class _DeferredThread:
    def __init__(self, *, target, daemon):
        self.target = target
        self.daemon = daemon
        self.started = False

    def start(self):
        self.started = True


@pytest.mark.parametrize(
    ("token", "chat_id"),
    [("", ""), ("", "test-chat"), ("test-token", "")],
)
def test_missing_telegram_configuration_opens_no_network_request(
    monkeypatch,
    token,
    chat_id,
):
    threads = []
    network_calls = []
    monkeypatch.setattr(comms.config, "TELEGRAM_BOT_TOKEN", token)
    monkeypatch.setattr(comms.config, "TELEGRAM_CHAT_ID", chat_id)
    monkeypatch.setattr(
        comms.threading,
        "Thread",
        lambda **kwargs: threads.append(_DeferredThread(**kwargs)),
    )
    monkeypatch.setattr(comms, "_post_telegram", network_calls.append)

    comms.send_webhook_alert("LOCKDOWN", "verified")

    assert threads == []
    assert network_calls == []


@pytest.mark.parametrize(
    ("state", "expected_heading"),
    [
        ("LOCKDOWN", "UPLINK LOCKDOWN TRIGGERED"),
        ("NORMAL", "UPLINK RESTORED"),
    ],
)
def test_webhook_delivery_is_deferred_to_a_daemon_thread(
    monkeypatch,
    state,
    expected_heading,
):
    threads = []
    network_calls = []
    monkeypatch.setattr(comms.config, "TELEGRAM_BOT_TOKEN", "test-token")
    monkeypatch.setattr(comms.config, "TELEGRAM_CHAT_ID", "test-chat")
    monkeypatch.setattr(
        comms.threading,
        "Thread",
        lambda **kwargs: threads.append(_DeferredThread(**kwargs)) or threads[-1],
    )
    monkeypatch.setattr(comms, "_post_telegram", network_calls.append)

    comms.send_webhook_alert(state, "verified")

    assert len(threads) == 1
    assert threads[0].daemon is True
    assert threads[0].started is True
    assert network_calls == []

    threads[0].target()

    assert len(network_calls) == 1
    assert expected_heading in network_calls[0]


def test_webhook_network_failure_is_fail_soft_and_secret_safe(monkeypatch, capsys):
    token = "super-secret-bot-token"
    chat_id = "super-secret-chat-id"
    bot_url = f"https://api.telegram.org/bot{token}/sendMessage"
    monkeypatch.setattr(comms.config, "TELEGRAM_BOT_TOKEN", token)
    monkeypatch.setattr(comms.config, "TELEGRAM_CHAT_ID", chat_id)

    class _ImmediateThread(_DeferredThread):
        def start(self):
            self.started = True
            self.target()

    monkeypatch.setattr(comms.threading, "Thread", _ImmediateThread)

    def fail_network(_text):
        raise OSError(f"failed URL {bot_url} for chat {chat_id}")

    monkeypatch.setattr(comms, "_post_telegram", fail_network)

    comms.send_webhook_alert("NORMAL", "restored")

    output = capsys.readouterr()
    combined = output.out + output.err
    assert "Telegram notification delivery failed" in combined
    assert token not in combined
    assert chat_id not in combined
    assert bot_url not in combined
