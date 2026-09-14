"""Dark/light desktop palette behavior."""

from aegis_soc import theme


def _luminance(hex_color):
    channels = [int(hex_color[index : index + 2], 16) / 255 for index in (1, 3, 5)]
    linear = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def _contrast(first, second):
    high, low = sorted((_luminance(first), _luminance(second)), reverse=True)
    return (high + 0.05) / (low + 0.05)


def test_dark_and_light_palettes_have_distinct_surfaces_and_theme_names():
    dark = theme.get_palette("dark")
    light = theme.get_palette("light")

    assert dark.name == "dark"
    assert light.name == "light"
    assert dark.background != light.background
    assert dark.panel != light.panel
    assert dark.text != light.text


def test_both_palettes_keep_body_text_at_wcag_aa_contrast():
    for name in ("dark", "light"):
        palette = theme.get_palette(name)
        assert _contrast(palette.text, palette.panel) >= 4.5
        assert _contrast(palette.muted, palette.panel) >= 4.5
        assert _contrast(palette.text, palette.background) >= 4.5


def test_unknown_palette_name_fails_safely_to_dark():
    assert theme.get_palette("neon") == theme.get_palette("dark")


def test_semantic_colors_are_available_in_both_palettes():
    for name in ("dark", "light"):
        palette = theme.get_palette(name)
        assert palette.status_colors["healthy"] == palette.success_highlight
        assert palette.status_colors["critical"] == palette.danger_highlight
        assert palette.status_colors["unknown"] == palette.unknown
