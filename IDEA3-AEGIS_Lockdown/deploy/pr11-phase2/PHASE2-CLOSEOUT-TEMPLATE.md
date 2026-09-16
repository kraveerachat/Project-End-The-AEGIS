# AEGIS IDEA3 PR11 Phase 2 — runtime closeout evidence template

> Fill this in **only** from evidence that actually exists, at the moment it is
> observed. Every field below is intentionally empty. Leave a field empty, or
> write `NOT RUN` / `BLOCKED` / `NOT PROVEN`, rather than predicting a result.
> A `PASS` here is a claim that someone can re-derive from the recorded command
> output. Copy this file per execution window; never edit a merged receipt.

## Window identity

```text
WINDOW_DATE_UTC            =
OPERATOR                   =
KLA_PRESENT_FOR_K7_ROLLBACK=
AUTHORIZATION_PHRASE_GIVEN =
MAIN_SHA_AT_EXECUTION      =
K1_PR144_MERGE_SHA         =
BRANCH                     =
SCRIPT_SHA256_BASELINE     =
SCRIPT_SHA256_EXECUTE      =
SCRIPT_SHA256_VERIFY       =
SCRIPT_SHA256_ROLLBACK     =
```

## Pre-mutation gates (all must be PASS before the first mutating command)

```text
FINAL_PREFLIGHT_LOCAL      =
FINAL_PREFLIGHT_SERVER     =
BASELINE_RESULT            =
BASELINE_EVIDENCE_DIR      =
K1_LIVE_ARTIFACT_SHA       =
K1_MERGED_ARTIFACT_SHA     =
K3_EXECUTION_WINDOW        =
K3_RECHECK_AT_EXECUTION    =
K4_COLLISION_RECHECK       =
K7_RUNNING_HUB_CONFIG_HASH =
K7_BASE_RENDER_HASH        =
K7_PHASE2A_RENDER_HASH     =
OVERLAY_SHA256_PLACED      =
WEB_CONTEXT_SHA256         =
NODE_IMAGE_DIGEST_VERIFIED =
SECRET_FILES_CONTRACT      =
```

## Phase 2A execution

```text
S1_OVERLAY_PLACED          =
S2_MODEL_RENDER            =
S2_SERVICE_SET             =
S3_IMAGE_BUILT             =
S3_IMAGE_ID                =
S4_IDEA3_WEB_HEALTHY       =
S4_NETWORK_MODEL           =
S4_NO_PUBLISHED_PORT       =
S4_READINESS               =
S5_DRIFT_CHECKPOINT        =
S5_CONNECTOR_UNCHANGED     =
S5_FIREWALL_VALIDATE       =
S6_NGINX_T_ISOLATED        =
S7_SNAPSHOT_PATH           =
S7_ARTIFACT_INSTALLED_SHA  =
S8_HUB_RECREATED           =
S8_HUB_HEALTHY             =
S8_HUB_NETWORKS            =
S8_HUB_IMAGE_UNCHANGED     =
S8_HUB_CONFIG_HASH_AFTER   =
```

## Browser route verification (TLS validated, never -k)

```text
SECURITY_REDIRECT_301      =
SECURITY_ROOT_200          =
SECURITY_NOT_HUB_FALLBACK  =
SECURITY_READINESS         =
MACHINE_PATH_404_BROWSER   =
SESSION_COOKIE_CONTRACT    =
EDGE_SECURITY_HEADERS      =
DRIVE_HEALTHZ              =
MONITOR_HEALTHZ            =
MONITOR_INTERNAL_404       =
HUB_HEALTHZ                =
PUBLIC_SHARE_BASELINE      =
```

## Preservation (compared against the baseline capture)

```text
DRIVE_UNCHANGED            =
MONITOR_UNCHANGED          =
POSTGRES_UNCHANGED         =
PUBLIC_SHARE_GATEWAY_UNCHANGED =
PUBLIC_SHARE_CONNECTOR_UNCHANGED =
TWINGATE_UNCHANGED         =
COMPOSE_FILE_HASHES_UNCHANGED =
VERIFY_PHASE2A_RESULT      =
```

## K8 / K9 / K10 (live evidence only)

```text
CORE_HOST_IDENTITY         =
CORE_WIRED_VLAN20_ADDRESS  =
CORE_ROUTE_TO_HUB          =
CORE_HTTPS_443             =
K8                         =
K9_DNS_RESOLUTION          =
K9_SERVER_CERT_SAN         =
K9_SNI_ISOLATION           =
K9                         =
K10_CLIENT_CA              =
K10_CRL_VALIDITY           =
K10_CORE_CERT              =
K10                        =
```

## Phase 2B (only after K8/K9/K10 exist)

```text
P2B_OVERLAY_PLACED_SHA     =
P2B_WEB_RECREATED          =
P2B_IR2_INSTALLED          =
P2B_NGINX_T                =
P2B_RELOAD                 =
T1_VALID_CERT              =
T2_NO_CERT                 =
T3_WRONG_CA                =
T4_REVOKED                 =
T5_EXPIRED                 =
T6_HEADER_SPOOF            =
T7_BROWSER_SNI_404         =
S1_NON_HUB_PEER_REJECTED   =
PHASE2B                    =
```

## Outcome

```text
ROLLBACK_USED              =
ROLLBACK_STAGE             =
ROLLBACK_VERIFY_RESULT     =
PHASE2A                    =
PHASE2B                    =
PHASE2_RUNTIME_COMPLETE    =
K12                        = NOT_PROVEN
PHASE3_RUNTIME_COMPLETE    = NO
PHASE4_RUNTIME_COMPLETE    = NO
D4_LIVE_VERIFIED           = NO
PR11_COMPLETE              = NO
RECEIPT_PATH               =
RECEIPT_COUNT              =
PR_NUMBER                  =
PR_STATE                   =
GUARDRAIL                  =
KNOWN_LIMITATIONS          =
```
