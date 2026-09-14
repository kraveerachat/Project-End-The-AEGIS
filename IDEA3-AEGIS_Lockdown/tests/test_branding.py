"""Focused tests for aegis_soc.branding -- pure logo path resolution.

No logo asset ships with this repository (only PUT-LOGOS-HERE.md
placeholders exist for the other AEGIS surfaces, and IDEA3 previously had
no logo folder at all), so these tests exercise the graceful-missing-asset
path plus the override/discovery logic, without needing tkinter or a real
image file for most cases.
"""
from aegis_soc import branding


def test_resolve_logo_path_returns_none_when_nothing_exists(tmp_path):
    assert branding.resolve_logo_path(env={}, base_dir=tmp_path) is None


def test_resolve_logo_path_finds_the_default_asset_when_present(tmp_path):
    logo_dir = tmp_path / "assets" / "logo"
    logo_dir.mkdir(parents=True)
    logo_file = logo_dir / "aegis-mark-light-ink.png"
    logo_file.write_bytes(b"not a real png, just needs to exist")

    resolved = branding.resolve_logo_path(env={}, base_dir=tmp_path)
    assert resolved == str(logo_file.resolve())


def test_resolve_logo_path_prefers_env_override(tmp_path):
    override_file = tmp_path / "custom-logo.png"
    override_file.write_bytes(b"custom")
    default_dir = tmp_path / "assets" / "logo"
    default_dir.mkdir(parents=True)
    (default_dir / "aegis-mark-light-ink.png").write_bytes(b"default")

    resolved = branding.resolve_logo_path(env={"AEGIS_LOGO_PATH": str(override_file)}, base_dir=tmp_path)
    assert resolved == str(override_file.resolve())


def test_resolve_logo_path_env_override_missing_file_returns_none(tmp_path):
    missing = tmp_path / "does-not-exist.png"
    resolved = branding.resolve_logo_path(env={"AEGIS_LOGO_PATH": str(missing)}, base_dir=tmp_path)
    assert resolved is None


def test_resolve_logo_path_ignores_blank_env_value(tmp_path):
    logo_dir = tmp_path / "assets" / "logo"
    logo_dir.mkdir(parents=True)
    logo_file = logo_dir / "aegis-mark-light-ink.png"
    logo_file.write_bytes(b"present")

    resolved = branding.resolve_logo_path(env={"AEGIS_LOGO_PATH": "   "}, base_dir=tmp_path)
    assert resolved == str(logo_file.resolve())


def test_default_logo_relative_path_matches_shared_aegis_mark_convention():
    # Matches IDEA1/IDEA2/HUB's existing aegis-mark-light-ink.png convention
    # documented in their PUT-LOGOS-HERE.md placeholders, so a single shared
    # asset works across the whole product.
    assert branding.DEFAULT_LOGO_RELATIVE_PATH.endswith("aegis-mark-light-ink.png")


def test_no_real_logo_asset_ships_in_this_repository():
    """Documents the actual current state honestly: resolving against the
    real IDEA3 package root finds nothing, because no logo file has been
    provided (only this task's new PUT-LOGO-HERE.md placeholder exists)."""
    assert branding.resolve_logo_path(env={}) is None
