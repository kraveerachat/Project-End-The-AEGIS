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


def test_a_slow_tether_is_retried_once_and_failures_name_only_a_secret_free_reason(monkeypatch, capsys):
    import urllib.error

    token, chat_id = "123456:SECRET-token-value", "-1009876543210"
    monkeypatch.setattr(comms.config, "TELEGRAM_BOT_TOKEN", token)
    monkeypatch.setattr(comms.config, "TELEGRAM_CHAT_ID", chat_id)
    monkeypatch.setattr(comms, "TELEGRAM_RETRY_DELAY_SEC", 0)
    attempts = []

    def flaky(text):
        attempts.append(text)
        if len(attempts) == 1:
            raise urllib.error.URLError(TimeoutError(f"timed out for bot{token} chat {chat_id}"))

    monkeypatch.setattr(comms, "_post_telegram", flaky)
    assert comms._deliver("restored") is True
    assert len(attempts) == 2
    out = capsys.readouterr().out
    assert "attempt 1/2, URLError/TimeoutError" in out and "retrying" in out
    assert token not in out and chat_id not in out


def test_a_rejected_message_is_not_retried(monkeypatch, capsys):
    import urllib.error

    attempts = []

    def rejected(text):
        attempts.append(text)
        raise urllib.error.HTTPError("https://api.telegram.org/botSECRET/sendMessage", 400, "Bad Request", None, None)

    monkeypatch.setattr(comms, "_post_telegram", rejected)
    assert comms._deliver("x") is False
    assert len(attempts) == 1
    out = capsys.readouterr().out
    assert "HTTPError status=400" in out and "SECRET" not in out


def test_the_delivery_timeout_leaves_margin_for_a_cellular_tether():
    assert comms.TELEGRAM_TIMEOUT_SEC >= 10 and comms.TELEGRAM_ATTEMPTS == 2
