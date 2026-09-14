"""Desktop login authentication and in-memory session contracts."""

from aegis_soc import auth, config


def test_admin_credentials_require_the_configured_id_and_existing_pin_verifier():
    env = {"AEGIS_ADMIN_ID": "soc-admin"}

    assert auth.verify_admin_credentials("soc-admin", "4321", env=env) is True
    assert auth.verify_admin_credentials("SOC-ADMIN", "4321", env=env) is False
    assert auth.verify_admin_credentials("soc-admin", "0000", env=env) is False
    assert config.verify_pin("4321") is True


def test_blank_admin_id_or_pin_is_rejected_without_raising():
    env = {"AEGIS_ADMIN_ID": "soc-admin"}

    assert auth.verify_admin_credentials("", "4321", env=env) is False
    assert auth.verify_admin_credentials("soc-admin", "", env=env) is False
    assert auth.verify_admin_credentials(None, "4321", env=env) is False
    assert auth.verify_admin_credentials("soc-admin", None, env=env) is False


def test_default_admin_identifier_is_available_for_local_lab_use():
    assert auth.configured_admin_id(env={}) == "admin"


def test_session_login_and_logout_retain_no_pin_or_password():
    session = auth.DesktopSession()

    assert session.authenticated is False
    session.login("soc-admin")

    assert session.authenticated is True
    assert session.admin_id == "soc-admin"
    assert session.authenticated_at is not None
    assert "pin" not in session.__dict__
    assert "password" not in session.__dict__
    assert "4321" not in repr(session)

    session.logout()
    assert session.authenticated is False
    assert session.admin_id is None
    assert session.authenticated_at is None
