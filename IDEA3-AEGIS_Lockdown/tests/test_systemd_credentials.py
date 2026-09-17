"""T9 systemd credential delivery contracts."""

from __future__ import annotations

import pytest


def test_t9_reads_single_line_credential_from_credentials_directory(tmp_path):
    from aegis_soc.systemd_credentials import read_text_credential

    root = tmp_path / "credentials"
    root.mkdir(mode=0o700)

    credential = root / "mqtt-core.pass"
    credential.write_text("test-only-password\n", encoding="utf-8")
    credential.chmod(0o400)

    value = read_text_credential(
        "mqtt-core.pass",
        environ={"CREDENTIALS_DIRECTORY": str(root)},
    )

    assert value == "test-only-password"



def test_t9_refuses_missing_credentials_directory():
    from aegis_soc.systemd_credentials import read_text_credential

    with pytest.raises(ValueError, match="CREDENTIALS_DIRECTORY"):
        read_text_credential("mqtt-core.pass", environ={})


def test_t9_refuses_missing_credential_file(tmp_path):
    from aegis_soc.systemd_credentials import read_text_credential

    root = tmp_path / "credentials"
    root.mkdir(mode=0o700)

    with pytest.raises(ValueError, match="missing|unreadable"):
        read_text_credential(
            "mqtt-core.pass",
            environ={"CREDENTIALS_DIRECTORY": str(root)},
        )


def test_t9_refuses_empty_credential(tmp_path):
    from aegis_soc.systemd_credentials import read_text_credential

    root = tmp_path / "credentials"
    root.mkdir(mode=0o700)

    credential = root / "mqtt-core.pass"
    credential.write_text("\n", encoding="utf-8")
    credential.chmod(0o400)

    with pytest.raises(ValueError, match="empty"):
        read_text_credential(
            "mqtt-core.pass",
            environ={"CREDENTIALS_DIRECTORY": str(root)},
        )


def test_t9_refuses_symlink_credential(tmp_path):
    from aegis_soc.systemd_credentials import read_text_credential

    root = tmp_path / "credentials"
    root.mkdir(mode=0o700)

    target = tmp_path / "secret"
    target.write_text("test-only-password\n", encoding="utf-8")
    target.chmod(0o400)
    (root / "mqtt-core.pass").symlink_to(target)

    with pytest.raises(ValueError, match="symlink"):
        read_text_credential(
            "mqtt-core.pass",
            environ={"CREDENTIALS_DIRECTORY": str(root)},
        )


def test_t9_refuses_credential_readable_by_group_or_other(tmp_path):
    from aegis_soc.systemd_credentials import read_text_credential

    root = tmp_path / "credentials"
    root.mkdir(mode=0o700)

    credential = root / "mqtt-core.pass"
    credential.write_text("test-only-password\n", encoding="utf-8")
    credential.chmod(0o644)

    with pytest.raises(ValueError, match="permission|mode"):
        read_text_credential(
            "mqtt-core.pass",
            environ={"CREDENTIALS_DIRECTORY": str(root)},
        )


def test_t9_resolves_private_regular_credential_path(tmp_path):
    from aegis_soc.systemd_credentials import credential_path

    root = tmp_path / "credentials"
    root.mkdir(mode=0o700)

    credential = root / "k_c2d"
    credential.write_text("1" * 64 + "\n", encoding="ascii")
    credential.chmod(0o400)

    assert credential_path(
        "k_c2d",
        environ={"CREDENTIALS_DIRECTORY": str(root)},
    ) == credential


def test_t9_credential_path_refuses_symlink(tmp_path):
    from aegis_soc.systemd_credentials import credential_path

    root = tmp_path / "credentials"
    root.mkdir(mode=0o700)

    target = tmp_path / "real-key"
    target.write_text("1" * 64 + "\n", encoding="ascii")
    target.chmod(0o400)
    (root / "k_c2d").symlink_to(target)

    with pytest.raises(ValueError, match="symlink"):
        credential_path(
            "k_c2d",
            environ={"CREDENTIALS_DIRECTORY": str(root)},
        )


def test_t9_credential_path_refuses_group_or_other_access(tmp_path):
    from aegis_soc.systemd_credentials import credential_path

    root = tmp_path / "credentials"
    root.mkdir(mode=0o700)

    credential = root / "k_c2d"
    credential.write_text("1" * 64 + "\n", encoding="ascii")
    credential.chmod(0o644)

    with pytest.raises(ValueError, match="permission|mode"):
        credential_path(
            "k_c2d",
            environ={"CREDENTIALS_DIRECTORY": str(root)},
        )
