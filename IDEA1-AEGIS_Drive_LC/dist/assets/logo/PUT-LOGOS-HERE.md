# AEGIS logo assets — drop the four files in THIS folder

Place the pre-generated files here, with these exact names:

```
IDEA1-AEGIS_Drive_LC/public/assets/logo/
  ├── aegis-mark-dark-ink.png    # near-black mark, transparent bg → light surfaces (default)
  ├── aegis-mark-light-ink.png   # white mark, transparent bg      → dark surfaces / dark mode
  ├── aegis-mark-accent.png      # blue #2563EB mark, transparent  → optional login/boot moment
  └── aegis-logo-source.jpg      # original master (cream on black) — never referenced by the app
```

The app references `/assets/logo/aegis-mark-dark-ink.png` and
`/assets/logo/aegis-mark-light-ink.png` at runtime. Until the PNGs exist, the
`<AegisMark />` component renders a built-in dash-dither SVG placeholder, so
nothing breaks — the PNGs simply take over when they appear.

Rules (from the build brief): keep the mark square, never stretch it, never put
it on a colored/glowing background, never add a drop-shadow or bloom.
