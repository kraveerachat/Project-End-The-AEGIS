# Product

## Register

product

## Users

- **Standard users (Thai-first)** on an on-premise Edge network segment: they log in to reach AEGIS Drive (secure file storage). Context: a workstation inside a facility; the hub is a threshold they pass through, not a place they linger.
- **Administrators**: same entry, plus CCTV Operator View and AEGIS Monitoring. They treat the hub as a command terminal.
- **Graders / code reviewers (read Thai)**: this is a security-course project. They will read the source for access-control correctness — anti-enumeration, default-deny, no client-side privilege assertion, no information disclosure through the DOM.

## Product Purpose

AEGIS Hub is the single entry gate for the AEGIS cyber-physical security platform. It authenticates the user, receives the **server-decided** role, and launches exactly the modules that role is entitled to — nothing else exists in the output. Success = the experience feels like powering on a very expensive machine, while the code underneath demonstrates textbook least-privilege architecture.

## Brand Personality

Crisp · precise · confident — "Precision Light" (see /DESIGN.md). A premium analytics-dashboard feel: light gray canvas, pure white cards, near-black ink, one blue. The interface never mentions security; it simply behaves like something secure.

## Anti-references

- Glow, bloom, glassmorphism, backdrop-blur, dark aurora gradients, particle fields, orbs — the previous direction; removed deliberately.
- Generic SaaS dashboards (cream themes, gradient CTAs, hero-metric templates).
- Consumer-playful onboarding voice, emoji, exclamation marks.
- Any UI that surfaces security mechanics to the user (role pickers, "admin only" teasers, verbose auth errors).

## Design Principles

1. **One texture, one meaning.** The diagonal hatch is the AEGIS signature: SOLID = the system can see this; HATCHED = it cannot (pending gates, ciphertext, projections, denied cells).
2. **Restraint.** Most of the interface is grayscale; color appears only where it carries meaning — an active state, a status, a key series.
3. **Precision.** Crisp edges, perfect alignment, tabular numerals, paper-on-paper shadows that are almost imperceptible.
4. **Security invisible in UI, explicit in code.** Uniform auth errors, default-deny module resolution, no DOM trace of unauthorized capability — each with a Thai comment explaining why.
5. **Motion is state.** Fast and functional (120–400 ms, one easing curve); the login cascade gates on the server's answer. Fully usable with `prefers-reduced-motion`.

## Accessibility & Inclusion

- WCAG AA contrast throughout. Functional text never uses the sub-AA muted gray token (`--ink-3` is captions only).
- Full keyboard operation: real labels, focus-visible rings (accent blue, 2 px offset), Enter/Space on hub cards, Escape closes overlays.
- `prefers-reduced-motion`: all transitions collapse to 1 ms; every animated state also reads statically via color/icon/label.
- Thai-first i18n (default `th`, TH/EN toggle); Thai body copy at line-height ≥ 1.7 so tone marks never clip.
