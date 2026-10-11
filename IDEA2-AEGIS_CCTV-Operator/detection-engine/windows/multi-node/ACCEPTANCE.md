# AEGIS IDEA2 — Multi-Node Live Acceptance Evidence

This checklist is the final live-hardware gate for each additional Windows
Detection Node. Preparing this file does not authorize Production mutation.

## Per-target prerequisites

Before collecting live evidence:

- MN-P1 target read-only preflight reviewed;
- MN-P2 target-local provisioning completed;
- target has its own unique Node ID;
- target has its own Agent identity;
- target has its own SSH identity;
- server-side registration and reverse-forward allocation were separately
  approved and completed;
- account alias policy is exactly:
  - `operator -> CAM-01`
  - `operator2 -> CAM-02`;
- one server-generated physical camera is bound to the target Node;
- target is rebooted before final acceptance.

## Local snapshot sequence

Run `collect_acceptance_snapshot.ps1` on the target at each phase:

```powershell
.\collect_acceptance_snapshot.ps1 -NodeLabel <NODE> -Phase pre_viewer
.\collect_acceptance_snapshot.ps1 -NodeLabel <NODE> -Phase operator_live
.\collect_acceptance_snapshot.ps1 -NodeLabel <NODE> -Phase post_operator_release
.\collect_acceptance_snapshot.ps1 -NodeLabel <NODE> -Phase operator2_live
.\collect_acceptance_snapshot.ps1 -NodeLabel <NODE> -Phase post_operator2_release
.\collect_acceptance_snapshot.ps1 -NodeLabel <NODE> -Phase post_reboot
```

The collector contacts only `127.0.0.1:8077/health`, reads local lifecycle
metadata, and writes a sanitized JSON evidence file. It does not open the
camera, read `.env`, read private keys, mutate Twingate, or contact Production.

Verify the local lifecycle bundle:

```powershell
py.exe -3.14 .\verify_acceptance_bundle.py .\mn-p3-evidence\*.json
```

Expected local-only result:

```text
MN_P3_LOCAL_LIFECYCLE=PASS
ACCOUNT_ALIAS_ROUTING=NOT_PROVEN_BY_LOCAL_BUNDLE
CROSS_NODE_ISOLATION=NOT_PROVEN_BY_LOCAL_BUNDLE
EVENT_ALIAS_ATTRIBUTION=NOT_PROVEN_BY_LOCAL_BUNDLE
PRODUCTION_ACCEPTANCE=NOT_PROVEN_BY_LOCAL_BUNDLE
```

## Manual/Monitor evidence that local snapshots cannot prove

For **each target Node**, record evidence for both accounts.

| Claim | operator / CAM-01 | operator2 / CAM-02 |
|---|---|---|
| Browser association resolves intended Node | PENDING | PENDING |
| Physical camera shown is target-local camera | PENDING | PENDING |
| Other Node physical camera is not selected | PENDING | PENDING |
| Live camera demand becomes active | PENDING | PENDING |
| `Live -> Archive -> Diagnostics -> Settings -> Live` keeps intended stream lifecycle | PENDING | PENDING |
| Logout/final viewer release returns Engine idle | PENDING | PENDING |
| Unauthorized/unassociated browser cannot obtain target physical authority | PENDING | PENDING |
| Detection logical attribution matches approved event-alias policy | PENDING | PENDING |
| Clip logical attribution matches approved event-alias policy | PENDING | PENDING |
| Alert logical attribution matches approved event-alias policy | PENDING | PENDING |

Do not mark the last three attribution rows PASS merely because Live routing
shows CAM-01/CAM-02. Current Engine `AEGIS_CAMERA_ID` remains one static
event-time logical alias per process until that boundary is explicitly changed
or accepted.

## Cross-node matrix

The same account must preserve the target machine's physical camera:

| Account | Node A | Node B | Node C |
|---|---|---|---|
| operator / CAM-01 | Physical A | Physical B | Physical C |
| operator2 / CAM-02 | Physical A | Physical B | Physical C |

Required final evidence:

```text
TARGET_PREFLIGHT=PASS
UNIQUE_NODE_ID=PASS
UNIQUE_AGENT_IDENTITY=PASS
UNIQUE_SSH_IDENTITY=PASS
ONE_PHYSICAL_CAMERA_PER_NODE=PASS
OPERATOR_CAM01_TARGET_CAMERA=PASS
OPERATOR2_CAM02_TARGET_CAMERA=PASS
CROSS_NODE_CAMERA_ISOLATION=PASS
NAVIGATION_CONTINUITY=PASS
FINAL_VIEWER_RELEASE=PASS
REBOOT_LIFECYCLE=PASS
ACCOUNT_ALIAS_EVENT_ATTRIBUTION=PASS
```

`ACCOUNT_ALIAS_EVENT_ATTRIBUTION=PASS` requires explicit evidence for the
approved detection/clip/alert policy and cannot be inferred from Live routing.
