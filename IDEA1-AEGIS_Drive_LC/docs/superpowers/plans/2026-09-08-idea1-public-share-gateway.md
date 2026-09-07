# PUBLIC-SHARE-3 Dedicated Gateway Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a locally testable, dedicated, share-only nginx gateway whose only upstream capability is `GET|POST /s/:token`, while keeping Production, the existing gateways, PUBLIC-SHARE-2, and the UI unchanged.

**Architecture:** A new `gateway/public-share/` source surface builds a non-root nginx container and an isolated Compose harness. The harness has exactly two static members on `aegis_public_share`: the gateway at `172.31.254.2` and a purpose-built recorder standing in for Drive at `172.31.254.3`. This non-overlapping test-only `/29` is used because the local machine already owns `172.19.0.0/16`; no existing network is modified. Structural tests parse nginx and Compose source; opt-in runtime tests exercise real containers and prove default denial, header authorship, body and method limits, rate limiting, token-safe logs, health isolation, and network isolation.

**Tech Stack:** nginx Alpine container, Docker Compose, Node.js `node:test`, built-in `fetch`/HTTP modules, React/Vite repository verification, Obsidian collaboration validators.

**Approved specification:** `C:\Users\User\Downloads\AEGIS_IDEA1_PUBLIC_SHARE_PR3_Dedicated_Gateway_Codex_Prompt.md` and `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md`. Owner gates G1, G2, and G3 are approved; G4, G5, and G6 remain open.

---

### Task 1: Pin the security contract with failing tests

**Files:**
- Create: `IDEA1-AEGIS_Drive_LC/tests/publicShareGatewayStructure.test.js`
- Create: `IDEA1-AEGIS_Drive_LC/tests/publicShareGatewayRuntime.test.js`

- [ ] Write brace-aware structural assertions for the dedicated config, exact two-member network, stateless/credential-free gateway, one allowlisted proxy location, default deny, methods, headers, body limit, streaming, timeouts, logging, and local health.
- [ ] Write an opt-in Docker runtime suite against an unpublished recorder for positive/negative routes, upstream counts, header forgery, Host poisoning, oversized bodies, deterministic 429, log redaction, health, and unrelated-service DNS isolation.
- [ ] Run the structure test before source exists and record the expected RED failure.

### Task 2: Implement the isolated gateway and recorder

**Files:**
- Create: `gateway/public-share/Dockerfile`
- Create: `gateway/public-share/nginx.conf.template`
- Create: `gateway/public-share/docker-compose.yml`
- Create: `gateway/public-share/.dockerignore`
- Create: `gateway/public-share/README.md`
- Create: `gateway/public-share/test-recorder/Dockerfile`
- Create: `gateway/public-share/test-recorder/server.mjs`

- [ ] Build a non-root, read-only nginx image with only the public-share config and an internal loopback self-health listener.
- [ ] Implement the anchored case-insensitive share route, GET/POST-only proxying, configured Host rejection/authorship, forwarding-header overwrite/clear, 16 KiB body limit, response streaming, explicit timeouts, edge IP rate limit, and URI-free logs.
- [ ] Define the localhost-only isolated Compose harness and exact `/29` two-member network; publish no recorder port and mount no data/credentials.
- [ ] Implement the stateful test recorder with request metadata/count available only inside the Docker network/container.
- [ ] Run structural tests to GREEN and validate rendered Compose plus `nginx -t`.

### Task 3: Prove runtime behavior without touching existing Docker state

**Files:**
- Modify only if test evidence requires: the two new gateway test files and new `gateway/public-share/**` files.

- [ ] Start only the uniquely named PUBLIC-SHARE-3 Compose project on a localhost-only test port.
- [ ] Run the opt-in runtime matrix and capture exact statuses, upstream deltas, sanitized headers, rate-limit behavior, and token-log sentinel result.
- [ ] Inspect the real network membership, gateway attachments, recorder port publishing, mounts, environment, user/capabilities/read-only settings, and image contents.
- [ ] Remove only the task's throwaway containers/network; confirm pre-existing Docker objects remain unchanged.

### Task 4: Run regressions, build, and governance checks

**Files:**
- Do not modify PUBLIC-SHARE-2 source or UI unless a proved defect requires an owner stop.

- [ ] Run focused gateway structure/runtime tests and existing public-share/trusted-proxy tests.
- [ ] Run full `npm test`; record the known pre-existing `AUTOLOCK-5` honestly and confirm PUBLIC-SHARE-3 adds no failures.
- [ ] Run `npm run build`, restore generated `dist/`, and run vault validation, secret scan, source-status checks, and `git diff --check`.

### Task 5: Align canonical knowledge and create one receipt

**Files:**
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md`
- Create: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/YYYY-MM-DD_HHMMSS_kla_idea1-public-share-gateway.md`

- [ ] Record G3 approved, gateway source locally implemented/tested, and all Production/ingress/UI/external-acceptance states still NO.
- [ ] List every exact `gateway/public-share/**` path as a cross-scope infrastructure surface with downstream behavior and rollback.
- [ ] Record exact verification commands/results and limitations in exactly one immutable receipt.
- [ ] Build a complete Draft PR body with matching policy metadata and shared-path declarations; validate collaboration policy locally.

### Task 6: Finalize branch for review

**Files:**
- Stage only the exact paths enumerated by this plan and the timestamped receipt.

- [ ] Re-fetch `origin/main`; if it moved, merge it (no rebase), reconcile, and rerun affected verification.
- [ ] Request code review, address only verified in-scope findings, and repeat the completion verification gate.
- [ ] Commit as `feat(idea1): add dedicated public share gateway`.
- [ ] Push `feat/idea1-public-share-gateway` without force and open a Draft PR to `main`.
- [ ] Stop before merge or any Production/ingress action and return the full section-38 review packet.
