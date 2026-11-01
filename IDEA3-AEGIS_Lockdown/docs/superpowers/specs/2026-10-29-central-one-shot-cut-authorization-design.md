# Central One-Shot CUT Authorization Design

## Intent

Make the Core command service the only component able to admit a physical
`CUT_UPLINK`. Reuse the Core-local CUT socket's peer credential, protected CUT
secret, bounded reason, and exact typed confirmation. A caller-controlled
origin, flag, environment value, or server claim is never authorization.

## Goals

- Bind each approval to a request identifier, optional incident identifier,
  target device, `CUT_UPLINK`, verified operator identity, expiry, and one-shot
  lifecycle.
- Enforce approval consumption in `AegisCommandController.issue()` before both
  Protocol v1 and legacy-lab publication.
- Persist authorization, consumption, and publication outcome in SQLite. The
  consume decision and its audit event are one `BEGIN IMMEDIATE` transaction.
- Treat consumption as the point after which an approval is never reusable,
  including publish failure, unknown outcome, process crash, or restart.
- Keep RESTORE policy and RESTORE-in-flight ordering unchanged.

## Non-goals

- No production deployment, broker connection, hardware actuation, network
  change, Server Dispatch approval integration, or autonomous CUT enablement.
- No redesign of RESTORE, Protocol v1, dispatch, detector, Telegram, or the UI.
- No bearer token that survives a Core restart.

## Approach

Use a small SQLite-backed `CutAuthorizationStore` on the existing Core audit DB
path. A Core-owned issuer creates a frozen in-memory grant only after the local
CUT gate authenticates the configured peer UID, CUT secret, typed confirmation,
and request fields. The grant carries a process-local MAC, so a guessed database
ID or copied row is not a usable capability. `AegisCommandController` validates
the MAC and exact bindings, then transactionally changes `AUTHORIZED` to
`CONSUMED` while appending an immutable lifecycle event. It records a terminal
publication outcome afterward; failure to record that outcome leaves the grant
consumed with an unknown result.

An unused grant is invalid after restart because the runtime MAC key changes;
startup also durably invalidates open rows. A failed or uncertain publish never
restores `AUTHORIZED`. Dry-run CUT remains simulation-only and does not consume
or require a physical approval. RESTORE admission remains independent.

Alternatives rejected: caller-signed/bearer tokens broaden the mint/consume
surface; origin/Boolean gates are forgeable; putting the check only in Local CUT
leaves direct Controller and legacy-lab paths open; Server Dispatch claims are
not an action-bound operator approval and therefore remain fail-closed.

## Safety constraints

All tests use temporary SQLite databases, fake MQTT clients, and synthetic
Protocol v1 keys. No test may resolve production credentials or contact a real
broker/device. The five protected `tools/purple_ui_source/aegis_soc/*` files are
out of scope.
