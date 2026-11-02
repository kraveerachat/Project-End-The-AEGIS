"""th/en/zh wording of the control Desktop's CUT and RESTORE dialogs, captions, buttons and result lines (display only)."""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

from tools import live_purple_control_desktop as desktop
from tools import live_purple_control_strings as strings

THAI, HAN = re.compile("[฀-๿]"), re.compile("[一-鿿]")
ROOT = Path(__file__).resolve().parents[1]


def test_every_fixed_string_has_three_languages_with_the_same_placeholders():
    for key, entry in strings.CONTROL_STRINGS.items():
        assert set(entry) == {"en", "th", "zh"}, key
        assert sorted(re.findall(r"\{(\w+)\}", entry["en"])) == sorted(re.findall(r"\{(\w+)\}", entry["th"])) \
            == sorted(re.findall(r"\{(\w+)\}", entry["zh"])), key


def test_english_wording_is_exactly_what_the_dialogs_said_before():
    assert strings.text("dialog.cut_reason", "en") == "Reason for this CUT (12-240 characters):"
    assert strings.text("dialog.restore_reason", "en") == "Reason for this RESTORE (12-240 characters):"
    assert strings.text("dialog.cut_secret", "en") == "CUT secret (verified by the Core; never stored):"
    assert strings.text("dialog.restore_secret", "en") == "RESTORE secret (verified by the Core; never stored):"
    assert strings.text("dialog.confirm", "en", word="RESTORE UPLINK") == "Type RESTORE UPLINK to confirm your intent:"
    assert strings.text("dialog.cut_title", "en") == "Manual CUT" and strings.text("dialog.restore_title", "en") == "RESTORE"
    assert strings.text("control.caption", "en") == "OPERATOR CONTROLS — CORE-AUTHENTICATED"
    assert strings.text("control.caption_note", "en") == "CUT and RESTORE — each verified by the Core"
    assert strings.text("control.cut_button", "en") == desktop.cut_desktop.CUT_BUTTON_TEXT
    assert strings.text("control.restore_button", "en") == desktop.RESTORE_BUTTON_TEXT
    assert strings.text("control.restore_disabled", "en") == desktop.RESTORE_DISABLED_TEXT


@pytest.mark.parametrize("language,script", [("th", THAI), ("zh", HAN)])
def test_thai_and_chinese_are_real_translations_and_keep_the_confirmation_word(language, script):
    command_words_only = {"dialog.restore_title"}   # "RESTORE" is a command word and is never translated
    for key in strings.CONTROL_STRINGS:
        if key not in command_words_only:
            assert script.search(strings.text(key, language, word="RESTORE UPLINK")), key
    assert "RESTORE UPLINK" in strings.text("dialog.confirm", language, word="RESTORE UPLINK")
    assert strings.text("control.cut_button", language).count("CUT") == 1


def _client_texts():
    """Every fixed English sentence the CUT and RESTORE clients can show, read from their source (View(...) texts and the code tables)."""
    found = set()
    for name in ("cut_client.py", "restore_client.py"):
        tree = ast.parse((ROOT / "aegis_soc" / name).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and getattr(node.func, "id", "") == "View" and len(node.args) >= 2:
                if isinstance(node.args[1], ast.Constant) and isinstance(node.args[1].value, str):
                    found.add(node.args[1].value)
            if isinstance(node, ast.Assign) and any(getattr(target, "id", "") == "_CODES" for target in node.targets):
                for value in node.value.values:
                    if isinstance(value.elts[2], ast.Constant):
                        found.add(value.elts[2].value)
    return found


def test_every_fixed_client_sentence_has_a_thai_and_a_chinese_translation():
    texts = _client_texts()
    assert len(texts) > 40
    missing = []
    for english in sorted(texts):
        th, zh = strings.flow_text(english, "th"), strings.flow_text(english, "zh")
        if not (THAI.search(th) and HAN.search(zh)):
            missing.append(english)
    assert not missing, missing


def test_translations_keep_the_codes_and_command_words_that_must_not_change():
    for english, entry in strings.FLOW_TEXTS.items():
        for word in ("CUT", "RESTORE", "LOCKDOWN", "NORMAL", "ACK", "STATUS"):
            if re.search(rf"\b{word}\b", english):
                assert word in entry["th"] and word in entry["zh"], (english, word)


def test_english_unknown_and_non_string_texts_come_back_unchanged():
    assert strings.flow_text("A sentence nobody translated.", "th") == "A sentence nobody translated."
    assert strings.flow_text("The Core does not accept this operator account.", "en") == "The Core does not accept this operator account."
    assert strings.flow_text(None, "zh") is None and strings.flow_text("", "th") == ""


@pytest.mark.parametrize("english,expect_th,expect_zh", [
    ("The device REJECTED the CUT (REJECTED_BUSY). The network was NOT cut by this command.", "REJECTED_BUSY", "REJECTED_BUSY"),
    ("The device REJECTED the RESTORE (REJECTED_X). The network was NOT restored by this command.", "REJECTED_X", "REJECTED_X"),
    ("No device ACK/STATUS within 20 s. The outcome is unknown; the RESTORE was NOT retried.", "20", "20"),
    ("No device ACK/STATUS within 20 s. The outcome is unknown; the CUT was NOT retried. Physical state is NOT proven.", "20", "20"),
    ("The Core answered SOME_CODE. Verify with Core evidence.", "SOME_CODE", "SOME_CODE"),
    ("Unrecognized ACK evidence (WEIRD). Do not assume the CUT happened.", "WEIRD", "WEIRD"),
    ("The reason must be 12-240 printable characters. Nothing was sent.", "12-240", "12-240"),
    ("the Core RESTORE channel is unavailable. Nothing was sent.", "RESTORE", "RESTORE"),
])
def test_sentences_with_a_variable_part_keep_the_variable_part(english, expect_th, expect_zh):
    th, zh = strings.flow_text(english, "th"), strings.flow_text(english, "zh")
    assert THAI.search(th) and HAN.search(zh)
    assert expect_th in th and expect_zh in zh and "{" not in th + zh


def test_notices_keep_the_state_code_and_translate_the_sentence():
    title, body = strings.notice("Manual CUT", "REFUSED_AUTH\n\nAuthentication failed. Nothing was sent.", "th")
    assert title != "Manual CUT" and THAI.search(title) and body.startswith("REFUSED_AUTH\n\n") and THAI.search(body)
    assert strings.notice("RESTORE", "NOT_SENT\n\nx", "zh") == ("RESTORE", "NOT_SENT\n\nx")
    assert strings.notice("Manual CUT", "Confirmation did not match. Nothing was sent.", "zh")[1].startswith("确认内容不匹配")
    english = ("Manual CUT", "PUBLISHED\n\nCUT published by the Core. Waiting for device ACK. Physical state is NOT proven.")
    assert strings.notice(*english, "en") == english


def test_the_real_prompts_ask_in_the_selected_language_and_keep_the_confirmation_words(monkeypatch):
    asked = []
    monkeypatch.setattr(desktop.simpledialog, "askstring", lambda title, prompt, **kw: asked.append((title, prompt, kw)) or "x")
    shown = []
    monkeypatch.setattr(desktop.messagebox, "showwarning", lambda title, text: shown.append((title, text)))
    prompts = desktop.ControlPrompts()
    for language in ("en", "th", "zh"):
        prompts.language = lambda language=language: language
        asked.clear()
        prompts.ask_reason(); prompts.ask_confirmation(); prompts.ask_secret()
        prompts.ask_restore_reason(); prompts.ask_restore_confirmation(); prompts.ask_restore_secret()
        assert len(asked) == 6
        assert desktop.cut_desktop.client.CONFIRMATION in asked[1][1] and desktop.restore_client.CONFIRMATION in asked[4][1]
        assert asked[2][2] == {"show": "*"} and asked[5][2] == {"show": "*"}      # secrets stay masked
        if language == "en":
            assert asked[0][:2] == ("Manual CUT", "Reason for this CUT (12-240 characters):")
            assert asked[3][:2] == ("RESTORE", "Reason for this RESTORE (12-240 characters):")
        else:
            assert (THAI if language == "th" else HAN).search(asked[0][1])
        prompts.notify("Manual CUT", "REFUSED_AUTH\n\nAuthentication failed. Nothing was sent.")
    assert shown[0][1].endswith("Authentication failed. Nothing was sent.") and shown[0][0] == "Manual CUT"
    assert THAI.search(shown[1][1]) and HAN.search(shown[2][1]) and shown[1][1].startswith("REFUSED_AUTH")
