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


# ── live failure A (2026-09-29): systemd LoadCredential= materialized admin.pin as 0440 ────────────────────────────
#
# Journal proved: `ValueError: credential admin.pin has unsafe permission mode`, even though the file was delivered
# by systemd's own LoadCredential= mechanism. Modern systemd may materialize a loaded credential as 0440 (owner +
# group readable) with a POSIX ACL restricting the extra grant to the exact service account, rather than always
# preserving the source file's 0600. Blanket-rejecting any group bit is correct for an arbitrary caller-supplied
# file, but wrong for a file systemd itself placed under the real, root-owned, per-unit `/run/credentials/<unit>/`
# tree -- a path an unprivileged caller cannot populate. `_SYSTEMD_MANAGED_CREDENTIALS_ROOT` is monkeypatched here
# to a tmp_path-based prefix so these tests never need real root/systemd; production code checks the real
# `/run/credentials` constant, which only PID 1 can ever populate.


def test_t9_accepts_0440_credential_only_under_a_genuine_systemd_credentials_directory(tmp_path, monkeypatch):
    from aegis_soc import systemd_credentials as sc

    fake_root = tmp_path / "run-credentials"
    unit_dir = fake_root / "aegis-idea3-core.service"
    unit_dir.mkdir(parents=True)
    monkeypatch.setattr(sc, "_SYSTEMD_MANAGED_CREDENTIALS_ROOT", fake_root)

    credential = unit_dir / "admin.pin"
    credential.write_text("4321\n", encoding="ascii")
    credential.chmod(0o440)

    assert sc.read_text_credential(
        "admin.pin",
        environ={"CREDENTIALS_DIRECTORY": str(unit_dir)},
    ) == "4321"


def test_t9_rejects_0440_credential_outside_the_genuine_systemd_credentials_directory(tmp_path, monkeypatch):
    """The exact live-failure mode 0440 must still be REJECTED when CREDENTIALS_DIRECTORY does not resolve under
    the real systemd-managed root -- an arbitrary directory a caller (or an attacker) merely NAMED to look right
    must never be trusted. _SYSTEMD_MANAGED_CREDENTIALS_ROOT is patched to a DIFFERENT tmp path than the one used,
    so the directory under test is provably outside it."""
    from aegis_soc import systemd_credentials as sc

    monkeypatch.setattr(sc, "_SYSTEMD_MANAGED_CREDENTIALS_ROOT", tmp_path / "run-credentials")

    root = tmp_path / "not-systemd-managed" / "aegis-idea3-core.service"
    root.mkdir(parents=True)
    credential = root / "admin.pin"
    credential.write_text("4321\n", encoding="ascii")
    credential.chmod(0o440)

    with pytest.raises(ValueError, match="permission|mode"):
        sc.read_text_credential("admin.pin", environ={"CREDENTIALS_DIRECTORY": str(root)})


def test_t9_still_rejects_0644_even_under_a_genuine_systemd_credentials_directory(tmp_path, monkeypatch):
    """Requirement 2: ordinary group+other-readable modes remain rejected unconditionally -- the 0440 exception
    must never widen into a general "inside this directory, anything goes" carve-out."""
    from aegis_soc import systemd_credentials as sc

    fake_root = tmp_path / "run-credentials"
    unit_dir = fake_root / "aegis-idea3-core.service"
    unit_dir.mkdir(parents=True)
    monkeypatch.setattr(sc, "_SYSTEMD_MANAGED_CREDENTIALS_ROOT", fake_root)

    credential = unit_dir / "admin.pin"
    credential.write_text("4321\n", encoding="ascii")
    credential.chmod(0o644)

    with pytest.raises(ValueError, match="permission|mode"):
        sc.read_text_credential("admin.pin", environ={"CREDENTIALS_DIRECTORY": str(unit_dir)})


def test_t9_0400_and_0600_still_accepted_unconditionally(tmp_path):
    """Requirement 3: the pre-existing owner-only contract is completely untouched by the new exception, with or
    without a genuine systemd directory."""
    from aegis_soc import systemd_credentials as sc

    root = tmp_path / "credentials"
    root.mkdir(mode=0o700)
    for mode in (0o400, 0o600):
        credential = root / f"admin-{mode:o}.pin"
        credential.write_text("4321\n", encoding="ascii")
        credential.chmod(mode)
        assert sc.read_text_credential(f"admin-{mode:o}.pin", environ={"CREDENTIALS_DIRECTORY": str(root)}) == "4321"


def test_t9_genuine_systemd_directory_symlink_is_still_rejected(tmp_path, monkeypatch):
    """The 0440 exception must not weaken the existing symlink/non-regular-file rejection even when the directory
    name matches the genuine systemd root."""
    from aegis_soc import systemd_credentials as sc

    fake_root = tmp_path / "run-credentials"
    unit_dir = fake_root / "aegis-idea3-core.service"
    unit_dir.mkdir(parents=True)
    monkeypatch.setattr(sc, "_SYSTEMD_MANAGED_CREDENTIALS_ROOT", fake_root)

    target = tmp_path / "real-admin-pin"
    target.write_text("4321\n", encoding="ascii")
    target.chmod(0o440)
    (unit_dir / "admin.pin").symlink_to(target)

    with pytest.raises(ValueError, match="symlink"):
        sc.read_text_credential("admin.pin", environ={"CREDENTIALS_DIRECTORY": str(unit_dir)})


def test_t9_credential_path_directly_accepts_the_live_failure_shape(tmp_path, monkeypatch):
    """credential_path() (used by k_c2d/k_d2c/mqtt-core.pass too, not just admin.pin via read_text_credential) must
    accept the same narrow 0440 contract."""
    from aegis_soc import systemd_credentials as sc

    fake_root = tmp_path / "run-credentials"
    unit_dir = fake_root / "aegis-idea3-core.service"
    unit_dir.mkdir(parents=True)
    monkeypatch.setattr(sc, "_SYSTEMD_MANAGED_CREDENTIALS_ROOT", fake_root)

    credential = unit_dir / "k_c2d"
    credential.write_text("1" * 64 + "\n", encoding="ascii")
    credential.chmod(0o440)

    assert sc.credential_path("k_c2d", environ={"CREDENTIALS_DIRECTORY": str(unit_dir)}) == credential
