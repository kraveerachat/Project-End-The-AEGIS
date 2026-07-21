# AEGIS Entry — Routing-Only Hub

Single visual entry point for **AEGIS** (Autonomous Edge-Guard Infrastructure System):
Welcome screen → module index → hand-off to the selected app's **own** sign-in.

> ## Architecture decision (2026-07-20)
>
> The HUB is a **traffic router, not an identity provider**:
>
> - **No user table, no session, no authorization decision here** — by design.
> - The hardened auth stack that used to live in this repo's `server/` (timing-safe
>   bcrypt, session regeneration, per-account + per-IP lockout with exponential
>   backoff, default-deny RBAC menus) was **moved** into the two apps, each with a
>   fully separate identity store:
>   - `../IDEA1-AEGIS_Drive_LC/server/` — roles `Admin` / `DataLake-User`, DB `aegis_drive`
>   - `../IDEA2-AEGIS_Monitor/server/`  — roles `SOC-Responder` / `CCTV-Operator`,
>     DB `aegis_monitor` (owns `camera_assignment`)
> - **No SSO.** No app trusts a cookie issued by any other app. A session minted
>   here would recreate the coupling the architecture deliberately removed.
>
> In production the HUB is static files behind NGINX (port 443 → 8001 / 8002 routing —
> Phase 4). The bundled `server/index.js` is a dev/demo static server with `/healthz`
> and strict security headers only.

## Run

```bash
npm install
npm run dev          # http://localhost:5173 (frontend only — no API exists)
npm run build        # production build → dist/
npm start            # routing-only static server on :8000 (+ /healthz)
```

## Runtime config — no rebuild to repoint modules

`public/config.json` maps module ids to target URLs. Edit it on the deploy box
(e.g. point to `http://192.168.10.11` / `.12` on VLAN 10) — the bundle carries no
hardcoded IPs.

## Security posture of a "dumb" entry

Even a static page carries its policy (Thai comments in `server/index.js`):
strict CSP (no `unsafe-inline`/`unsafe-eval`), `X-Frame-Options: DENY`,
`nosniff`, `Referrer-Policy: no-referrer`, HSTS, and a `Permissions-Policy`
that declares camera/mic/geolocation off. The module index is a public menu —
knowing a module's name is not a secret; everything behind it sits after that
app's own login + server-side RBAC.

## Notes

- `prefers-reduced-motion`: every loop stops; the app is fully usable with motion off.
- i18n: Thai default, TH/EN/ZH toggle; all copy flows through `src/lib/strings.js`.
