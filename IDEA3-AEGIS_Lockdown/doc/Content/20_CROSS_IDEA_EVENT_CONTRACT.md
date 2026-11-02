# 20 — Cross-IDEA Event Contract (DRAFT for discussion)

> **DRAFT — for discussion with the IDEA1 and IDEA2 owners. Nothing here is implemented, agreed or deployed. No code accompanies it.**
> Every number below is a proposal. Sections marked "Decision" need an owner's answer before any implementation starts.

## 1. Where this starts from

**What exists today** (`web/server/domain/integrationEvents.js`, the IDEA3 Security Center):

| Item | Today |
|---|---|
| Sources | `IDEA1`, `IDEA2`; the event's `source` must equal the configured source of the feed it came from |
| Event type | one value: `ACCESS_DENIED` |
| Fields | `source`, `event_id` (≤128 chars of `[A-Za-z0-9._:-]`), `event_type`, `severity` (`INFO`, `WARNING`, `HIGH`, `CRITICAL`, `UNKNOWN`), `occurred_at` (ISO time with offset), `resource` (≤160 chars), `subject` (optional), `confidence` (0–100), `evidence`, `correlation_key` |
| Privacy | `subject` is forced to `null` after validation; `evidence` keeps only an allowlist (today only `result`); unknown evidence keys are dropped |
| Freshness | age of `occurred_at` is classified FRESH, STALE or FUTURE; `containment_eligible` only when FRESH and severity is not UNKNOWN |
| Duplicates | key `source:event_id`; identical content is counted once (`dedup_count`); the same id with different content is an `EVENT_ID_CONFLICT` and the event is withheld |
| Transport | the Security Center **pulls** read-only JSON from IDEA1 and IDEA2; it never sends them anything |
| Use | display and correlation only. The Web has no path to CUT or RESTORE |

**What the Core already does** (`16_GRADUATED_RESPONSE.md`): the Core, not any sender, decides the level from evidence. Each evidence kind counts once per address per
600 s; scores are generic 30, port scan 30, SSH brute force 40, SYN flood 50, multi-vector bonus 20, distributed sources 30, containment failed 60, activity after a
confirmed block 60, SSH login after brute force 100. Levels: MEDIUM at 30, HIGH at 60, CRITICAL at 100 **and** corroboration a detector line cannot supply. HIGH only
recommends a CUT to the operator; CRITICAL allows one automatic CUT per lockdown episode; RESTORE is never automatic.

## 2. Principles (not up for negotiation in this draft)

1. **A sender reports what it observed, never an action or a level.** The proposed `severity` field is a hint that IDEA3 ignores for scoring.
2. **IDEA3 decides.** The score and the level are computed on the IDEA3 side from a fixed table (section 4); a sender cannot raise either by claiming it.
3. **No automatic RESTORE, ever.** RESTORE stays an operator action with the RESTORE secret at the Core.
4. **Fail secure and honest:** missing, stale, invalid or unauthenticated input is "no evidence", shown as such. It never lowers a level and never counts as proof of safety.
5. **Privacy by construction:** see section 8.

## 3. Common event envelope (proposed additions are marked +)

Existing fields keep their meaning. New or tightened fields:

| Field | Rule |
|---|---|
| `schema_version` + | integer, `1` for this contract |
| `source` | `IDEA1` or `IDEA2`; must equal the source bound to the sender's certificate (section 5) |
| `event_id` | unique per source; never reused |
| `event_type` | one of the closed enum in section 4 (the enum grows only by a reviewed change) |
| `occurred_at` | ISO time of the observation, not of sending |
| `zone` + | optional bounded id (≤64 chars, `[a-z0-9-]`) from a **central zone list** shared by all three IDEAs, for example `server-room-1`; never free text |
| `source_ip` + | optional IPv4 of the *actor* (never of a legitimate user's device unless the event type says so); IPv6 and host names are refused |
| `count`, `window_s` + | optional bounded integers (count 1–100000, window 1–86400) for burst events |
| `confidence` | 0–100, how sure the sensor is; only used to drop low-confidence physical events (section 4) |
| `subject` | stays `null` after validation; **no person is named** |
| `correlation_key` | optional bounded id; never derived from a person |
| `evidence` | per event type, an allowlist of bounded enum/number keys (section 4); everything else is dropped |

## 4. Proposed event types, scores and caps

"Level cap" is the highest level a single source can reach from that event type alone. Scores are inputs to the same ladder as doc 16 (MEDIUM 30, HIGH 60, CRITICAL 100) and
each (source, type, actor) counts once per window, so repeating an event never raises the score by volume. MITRE ATT&CK ids are proposals for the owners to confirm; a physical
event with no Enterprise technique is marked "none" rather than forced onto one.

### IDEA1 (drive / file access)

| `event_type` | Fields (besides the common ones) | Score | Level cap | MITRE (proposed) |
|---|---|---|---|---|
| `ACCESS_DENIED` (exists) | `resource`, `evidence.result` | 10 | LOW | none |
| `LOGIN_FAILURE_BURST` | `source_ip`, `count`, `window_s`, `evidence.distinct_accounts` (a count) | 40 | HIGH | T1110 |
| `LOGIN_SUCCESS_AFTER_FAILURES` | `source_ip`, `count`, `window_s` | 60 | HIGH | T1078 |
| `MASS_DOWNLOAD` | `count`, `window_s`, `evidence.volume_bucket` (`SMALL`, `MEDIUM`, `LARGE`), optional `source_ip` | 40 | HIGH | T1530 (confirm with IDEA1) |
| `MASS_DELETION` | `count`, `window_s`, optional `source_ip` | 50 | HIGH | T1485 |

### IDEA2 (cameras / detection, metadata only)

| `event_type` | Fields (besides the common ones) | Score | Level cap | MITRE (proposed) |
|---|---|---|---|---|
| `UNKNOWN_PERSON_IN_ZONE` | `zone` (required), `confidence` (≥70 to count), `evidence.dwell_bucket` (`SHORT`, `MEDIUM`, `LONG`), `evidence.camera_ref` (opaque id) | 50 | HIGH | none (physical presence) |
| `TAILGATING` | `zone` (required), `confidence` (≥70 to count) | 40 | HIGH | none (physical) |
| `CAMERA_OBSTRUCTED` | `zone` (required), `evidence.camera_ref` | 40 | HIGH | T1562 (impair defenses; confirm) |
| `CAMERA_OFFLINE` | `zone` (required), `evidence.camera_ref`, `evidence.duration_bucket` | 15 | MEDIUM | none (availability, often benign) |

Examples (synthetic; documentation addresses only):

```json
{"schema_version":1,"source":"IDEA1","event_id":"idea1:2026-10-24:000417","event_type":"LOGIN_FAILURE_BURST",
 "severity":"WARNING","occurred_at":"2026-10-24T10:00:12+07:00","resource":"drive-login","subject":null,
 "source_ip":"203.0.113.7","count":14,"window_s":60,"confidence":90,"evidence":{"distinct_accounts":3}}
```
```json
{"schema_version":1,"source":"IDEA2","event_id":"idea2:2026-10-24:000052","event_type":"UNKNOWN_PERSON_IN_ZONE",
 "severity":"HIGH","occurred_at":"2026-10-24T10:00:40+07:00","resource":"camera-zone","subject":null,
 "zone":"server-room-1","confidence":88,"evidence":{"dwell_bucket":"MEDIUM","camera_ref":"cam-sr1-a"}}
```

## 5. Sender authentication (reuse the machine mTLS identity pattern)

The Security Center's machine routes already authenticate the Core this way (`web/server/security/machineIdentity.js`): the HUB's machine SNI block verifies the client
certificate and overwrites two headers; the Web trusts them only from the pinned HUB address; the verify header must be exactly `SUCCESS`; the subject must hold exactly
one CN equal to the expected subject; a request with a browser cookie or an `Origin` header is refused; a refusal writes nothing.

Proposed reuse:

- **One client certificate per sender**, from the same machine CA, with its own CN (for example `idea1-events` and `idea2-events`), never shared between IDEAs and never a browser or admin identity.
- **A separate, default-off route group** for events (its own enable flag), not the dispatch route and not the Core status route. A route group that is not enabled does not exist (404), as today.
- **Source binding:** the expected CN fixes the `source`. A body whose `source` differs from the identity's source is refused (an IDEA1 certificate cannot speak as IDEA2).
- **Direction:** the sender pushes; IDEA3 answers only accepted or a refusal code. IDEA3 never returns a command, a level or anything a sender could act on.
- **Revocation:** a certificate is revoked at the HUB; IDEA3 keeps no sender secret of its own.

No new cryptography is proposed: mTLS plus identity binding is the existing, reviewed pattern.

## 6. Freshness, replay protection and rate limits

| Control | Proposal |
|---|---|
| Freshness | the event's `occurred_at` must be no more than 5 s in the future (the existing skew) and no older than the freshness window (default 120 s, as `containment_eligible` uses today); older events are stored as history only and never score |
| Envelope ordering | each push carries `sentAtMs`; it must be strictly greater than the last accepted one from that sender (as the Core status push); a replayed or reordered envelope is refused |
| Duplicate ids | `source:event_id` is unique; the same id with the same content is counted once, with different content is a conflict and is withheld (existing behaviour) |
| Bounded memory | at most N recent ids per sender are remembered (proposal: 10 000 or 24 h); an id older than that is judged by freshness alone |
| Size | at most 8 KiB per push and at most 20 events per push; larger is refused |
| Rate | per sender, proposal 60 events per minute sustained with a burst of 120; beyond it the push is refused with a retry hint. Rate never raises a score: each (source, type, actor) counts once per window |
| Unauthenticated | refused before parsing; never logged with its body |

## 7. How levels combine, and the single-source rule

1. **One source alone is capped at HIGH.** Whatever the scores add up to, if the contributing evidence comes from one independent source, the level is at most HIGH, which
   only recommends a CUT to the operator and never acts.
2. **CRITICAL needs corroboration from two independent sources.** Independent means different systems with different sensor classes and different certificates: IDEA1 (identity and
   data access), IDEA2 (physical), IDEA3 (network, observed by the Core and its detector). The two must concern the same place or actor inside a 120 s window: the same `zone`
   (IDEA3's network evidence is tied to a zone by configuration, not by anything a sender sends) or the same `source_ip`. The total score must also reach the CRITICAL threshold (100).
3. **Decision (important):** may an automatic CUT of the IDEA3 uplink follow from two sources neither of which is IDEA3's own evidence (for example IDEA1 plus IDEA2)? **Proposal: no.**
   At least one corroborating source must be evidence the Core itself observed. A pair without it is capped at HIGH (recommend to the operator). This way a compromise of IDEA1 and IDEA2 together
   cannot cut the network.
4. The existing Core-side corroboration kinds (failed block, activity after a confirmed block, login after brute force) keep working as they do today.
5. All other rules of doc 16 stay: one automatic CUT per lockdown episode, only when armed, RESTORE never automatic, Telegram is notification only.

Worked examples (inside one 120 s window; scores from section 4 and doc 16):

| Evidence | Sources | Score | Level |
|---|---|---|---|
| IDEA2 `UNKNOWN_PERSON_IN_ZONE` alone | 1 | 50 | MEDIUM |
| IDEA2 `UNKNOWN_PERSON_IN_ZONE` + `TAILGATING` (same zone) | 1 | 90 | HIGH (capped; recommend CUT) |
| IDEA1 `LOGIN_FAILURE_BURST` + `LOGIN_SUCCESS_AFTER_FAILURES`, same IP | 1 | 100 | HIGH (single-source cap) |
| IDEA2 unknown person in `server-room-1` + IDEA3 SSH brute force and port scan from that room's network | 2 (IDEA3 is one) | 50 + 40 + 30 + 20 = 140 | CRITICAL, one automatic CUT |
| IDEA1 login burst from IP X + IDEA3 port scan from IP X | 2 (IDEA3 is one) | 40 + 30 = 70 | HIGH (below 100) |
| IDEA1 `MASS_DELETION` + IDEA2 `UNKNOWN_PERSON_IN_ZONE`, no IDEA3 evidence | 2 (none is IDEA3) | 100 | HIGH (decision 3) |
| IDEA2 `CAMERA_OFFLINE` alone | 1 | 15 | LOW (audit) |

## 8. Privacy

- **No image, video frame, thumbnail, embedding, face template or biometric value ever crosses the boundary**, in any field, in `evidence`, or in a reference.
- **No name or user id.** `subject` is `null`; account counts are numbers; `camera_ref` is an opaque id that carries no person.
- The only personal-data-like value is an actor's IPv4 in `source_ip`, allowed only on event types that need it; it is bounded in retention and never joined with a person.
- Unknown fields are dropped, never stored; a sender that sends a forbidden field (for example `image` or `face`) is counted and the event is refused.
- Retention on the IDEA3 side is bounded (proposal: events 24 h in memory, scores recomputed from the window, decisions in the existing Core audit).

## 9. Open decisions

1. **Where scoring runs.** Today the Security Center only displays. Scoring that can lead to a CUT belongs to the Core (doc 16: the Core decides), which has no network-facing ingress. Options:
   (A) display and correlation only, no scoring from IDEA1/IDEA2 (safest, no new channel); (B) the Web computes an advisory level for the operator, still no command path;
   (C) a new authenticated Core ingress for events (needs its own threat model and review before any code). Proposal: A, then B, then C only after review.
2. Decision 3 in section 7 (is IDEA3's own evidence required for an automatic CUT?).
3. The central zone list, who owns it, and how IDEA3's network is tied to a zone.
4. The exact score table, caps, rate limits and retention numbers (all are proposals).
5. MITRE mapping confirmations (T1530, T1485, T1562) and whether physical events carry no technique.
6. Whether IDEA1 may send `source_ip` of legitimate users on `MASS_DOWNLOAD` (privacy review).
7. Push versus the existing pull for these events; whether the existing pull adapters stay for status.

## 10. Not in scope

Implementation, firmware, the Desktop, the Core protocol, a new transport for commands (there is none), RESTORE in any form, and any change to IDEA1 or IDEA2 code.
