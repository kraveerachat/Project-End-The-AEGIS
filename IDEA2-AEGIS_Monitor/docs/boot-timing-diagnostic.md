# Bounded authenticated Boot timing diagnostic

Source-only preparation for the same failing Machine C Boot renewal request.
This is not a Live stability fix, clock-safety proof, or deployment approval.
The task is isolated on `codex/idea2-boot-timing-diagnostic`, stacked on PR410
at `2a807216f8f87bdc6a61f3d0ede66dcc8145a1f6`; PR410 is not modified.

## Configuration and resource bounds

`AEGIS_BOOT_TIMING_DIAGNOSTIC` is **off by default** on Monitor and Engine.
Only the exact value `true` enables it. Nothing in this task sets a live
environment variable or restarts a process. Future enabling on both processes
requires separate owner authorization, independent review, and the existing
clock/dependency/deployment gates. No camera or new Boot sampling loop is created.

Each process observes at most 128 Boot attempts during one 300-second window
starting with its first eligible diagnostic request. The window never rearms in
that process. Output is best effort, with no retry, and at most one record per
observed attempt. Numeric durations are monotonic, nonnegative or `null`, rounded
to 0.01 ms and capped at 10,000 ms (a capped value is not an exact measurement).
Loop-delay observation runs at 50 ms only within the bounded diagnostic window;
it is not clock correction. Its sample age is included. `null` means unobserved.

Monitor output runs on one dedicated worker, with at most 128 queued records,
each at most 2,048 UTF-8 bytes. Slow or broken stderr cannot block the application
event loop. The worker closes its input after 300 seconds or 128 records and is
unreferenced so it cannot keep Monitor alive. A blocked OS write may prevent the
worker itself from returning until the OS recovers; it cannot extend the capture
budget or grow the queue. Engine output uses one daemon writer and a bounded
128-entry queue with nonblocking submission and direct bounded stderr writes,
not the application's shared logging handlers. It has a 300-second receive window;
a blocked diagnostic write cannot hold an application logging-handler lock or
block the Boot response. Output may be dropped
on failure, overflow or process exit. No delivery guarantee is claimed.

## Correlation and phases

Monitor generates a fresh random 128-bit lowercase-hex ID for each attempt and
sends `X-Aegis-Boot-Diagnostic-Id`. Engine considers exactly one valid 32-character
ID **after** the unchanged shared-key authentication. Absent, malformed or duplicate
IDs produce no record and do not affect the Boot result. IDs are observation only:
they are not signed claims, authentication, grant authority, replay prevention,
clock samples, session bindings, or physical-source selection. Retries get new IDs.

Records contain only `event`, `role`, `id`, a fixed `outcome`, `elapsedMs`,
`phasesMs`, `loopLagMs` and `loopLagSampleAgeMs`. Never log request/response headers,
URL, nonce, signed proof/grant, key, user/session, Node/camera identity, exception
text, packet payload, or environment. Diagnostic output is a separate JSON line,
without the application's shared logging envelope or a cross-host wall timestamp.

| Process | Cumulative monotonic phase ends | Fixed outcomes |
|---|---|---|
| Monitor | dispatch, headers received, body read, proof validation | accepted, transport_failure, http_rejection, body_failure, proof_rejection |
| Engine | handler entry, authentication, authority-clock observation, signing, ASGI response submission | submitted, request_rejection, handler_failure, response_failure |

Subtract consecutive phase ends for local phase duration. `authority_clock`
includes payload assembly and the existing authority-clock lock/read; it is not
an isolated lock profiler. `response_submission` means ASGI accepted submission,
**not** delivery to Monitor, a browser, or an SSH peer. Failed submission propagates
the original application error. Unauthorized Engine requests emit no correlated
record. Proof rejection deliberately aggregates cryptographic/nonce/clock denial;
the diagnostic does not expose verifier internals or change their decisions.

Correlate records by `(id, role)` from existing authorized logs after a separately
approved observation. If matched Engine processing is small while Monitor elapsed
is large, the remaining time is **transport/unobserved scheduling**, not proven
SSH latency. ASGI entry excludes kernel/server pre-handler scheduling, and the
Monitor headers phase includes transport plus callback scheduling. Loop lag is
supporting evidence, not exact attribution to a particular request. A missing
Engine record could mean transport failure, auth denial, disabled/exhausted
diagnostics, dropped output, or process exit; absence alone proves none of these.

## Unchanged security and remaining gates

The 500 ms abort/probe bound, retry classification/count, signed Boot payload,
nonce/MAC verification, ±900 ms offset interval, DB lease/grant expiry, session
binding, RBAC, generation authority and camera lifecycle are unchanged. Diagnostic
measurements are separate from the injected authority clocks. Logging errors do
not change request success, failure, retryability or returned authority fields.
Observation consumes some CPU, so opt-in overhead must still be considered in a
future live timing analysis; there is no claim of zero instrumentation overhead.

Independent review and PR410 -> PR348 -> PR344 dependency acceptance remain open.
Production DB/Monitor <=500 ms and DB/Engine relative divergence <=100 ms through
the remaining lease are still NOT_PROVEN as continuous bounds. No new sample,
source test, or diagnostic output closes that gate. No live diagnostic observation,
camera acceptance, merge or deployment has been performed.

Future rollback is disabling the flag under separate authorization; source
rollback is reverting only this diagnostic task. Neither changes a security
threshold or requires altering SSH, Windows Time, clock discipline or PR410.
