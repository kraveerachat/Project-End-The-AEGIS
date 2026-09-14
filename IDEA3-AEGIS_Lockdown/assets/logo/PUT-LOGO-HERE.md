# AEGIS logo asset — drop the file in THIS folder

The IDEA3 Python Security Operations Console is dark-surface-only, so it
needs just the light-ink mark from the shared AEGIS brand set (see the
identical convention in `IDEA1-AEGIS_Drive_LC/public/assets/logo/`,
`IDEA2-AEGIS_Monitor/public/assets/logo/`, and
`HUB-AEGIS_Entry/public/assets/logo/`):

```
IDEA3-AEGIS_Lockdown/assets/logo/
  └── aegis-mark-light-ink.png   # white mark, transparent bg → dark surfaces (used here)
```

The app looks for `assets/logo/aegis-mark-light-ink.png` (relative to the
`IDEA3-AEGIS_Lockdown` package root) at startup, via
`aegis_soc.branding.resolve_logo_path()`. Until that file exists, the header
brand block falls back to text-only branding ("AEGIS / IDEA3") — nothing
breaks; the PNG simply takes over once it appears.

To use a different location, set the `AEGIS_LOGO_PATH` environment variable
to an absolute path.

Rules (from the shared AEGIS brand convention): keep the mark square, never
stretch it, never put it on a colored/glowing background, never add a
drop-shadow or bloom.
