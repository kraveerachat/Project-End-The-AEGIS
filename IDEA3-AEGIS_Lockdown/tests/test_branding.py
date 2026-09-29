"""Focused tests for aegis_soc.branding -- pure logo path resolution.

The official aegis-mark-light-ink.png / aegis-mark-dark-ink.png assets
(byte-identical to the copies already used by IDEA1/IDEA2/HUB) now ship at
IDEA3-AEGIS_Lockdown/assets/logo/. Most cases here still use an isolated
tmp_path so they exercise the override/discovery logic in full, including
the graceful-missing-asset path, without depending on the real files;
test_official_logo_asset_ships_in_this_repository below is the one test
that intentionally checks the real, current repository state.
"""
import os

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


def test_resolve_logo_path_selects_the_dark_ink_mark_for_light_theme(tmp_path):
    logo_dir = tmp_path / "assets" / "logo"
    logo_dir.mkdir(parents=True)
    logo_file = logo_dir / "aegis-mark-dark-ink.png"
    logo_file.write_bytes(b"light theme mark")

    resolved = branding.resolve_logo_path(env={}, base_dir=tmp_path, theme="light")

    assert resolved == str(logo_file.resolve())


def test_resolve_logo_path_selects_the_light_ink_mark_for_dark_theme(tmp_path):
    logo_dir = tmp_path / "assets" / "logo"
    logo_dir.mkdir(parents=True)
    logo_file = logo_dir / "aegis-mark-light-ink.png"
    logo_file.write_bytes(b"dark theme mark")

    resolved = branding.resolve_logo_path(env={}, base_dir=tmp_path, theme="dark")

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


def test_official_logo_asset_ships_in_this_repository():
    """Documents the actual current state honestly: the official
    aegis-mark-light-ink.png (byte-identical to the copies already used by
    IDEA1/IDEA2/HUB) now ships at IDEA3's default logo path, so resolution
    against the real IDEA3 package root succeeds."""
    resolved = branding.resolve_logo_path(env={})
    assert resolved is not None
    assert resolved.endswith("aegis-mark-light-ink.png")
    assert os.path.isfile(resolved)


def test_both_official_theme_logo_assets_ship_in_this_repository():
    dark_surface = branding.resolve_logo_path(env={}, theme="dark")
    light_surface = branding.resolve_logo_path(env={}, theme="light")

    assert dark_surface.endswith("aegis-mark-light-ink.png")
    assert light_surface.endswith("aegis-mark-dark-ink.png")
    assert os.path.isfile(dark_surface)
    assert os.path.isfile(light_surface)
