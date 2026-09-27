"""Display-independent contracts used by the Tkinter Admin Login view."""

from aegis_soc.auth import DesktopSession
from aegis_soc.login_view import LoginFlow


def test_success_authenticates_the_desktop_session_and_notifies_the_shell():
    session = DesktopSession()
    authenticated = []
    flow = LoginFlow(
        session,
        on_authenticated=lambda: authenticated.append(session.admin_id),
        credential_verifier=lambda admin_id, pin: admin_id == "admin" and pin == "4321",
    )

    result = flow.submit("admin", "4321")

    assert result.accepted is True
    assert result.message_key is None
    assert result.clear_pin is True
    assert session.authenticated is True
    assert session.admin_id == "admin"
    assert authenticated == ["admin"]


def test_wrong_id_and_wrong_pin_have_the_same_generic_failure():
    session = DesktopSession()
    flow = LoginFlow(
        session,
        on_authenticated=lambda: None,
        credential_verifier=lambda admin_id, pin: admin_id == "admin" and pin == "4321",
    )

    wrong_id = flow.submit("unknown", "4321")
    wrong_pin = flow.submit("admin", "0000")

    assert wrong_id == wrong_pin
    assert wrong_id.accepted is False
    assert wrong_id.message_key == "login.failure"
    assert wrong_id.clear_pin is True
    assert session.authenticated is False


def test_blank_input_fails_generically_and_never_authenticates():
    session = DesktopSession()
    flow = LoginFlow(session, on_authenticated=lambda: None)

    result = flow.submit("", "")

    assert result.accepted is False
    assert result.message_key == "login.failure"
    assert result.clear_pin is True
    assert session.authenticated is False


def test_login_flow_retains_no_pin_after_an_attempt():
    session = DesktopSession()
    flow = LoginFlow(
        session,
        on_authenticated=lambda: None,
        credential_verifier=lambda _admin_id, _pin: False,
    )

    flow.submit("admin", "sensitive-pin")

    assert "sensitive-pin" not in repr(flow)
    assert all("pin" not in key.lower() for key in flow.__dict__)
