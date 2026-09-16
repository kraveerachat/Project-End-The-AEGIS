# Post-PR144 execution handoff — AEGIS IDEA3 PR11 Phase 2

What to do, in order, once **PR #144 (K1 reconciliation) is merged by a human**.
Nothing here has been executed. `PRODUCTION_MUTATION_AUTHORIZED=NO` until the
owner types the exact phrase in the executing session.

## 0. State at handoff

```text
MAIN_AT_HANDOFF        = 721b797860063729b7c3c280161dcb908d0ff7f5
K1                     = PR #144 Ready, awaiting human review/merge (merged since: e4183fef)
K3                     = CLEAR (merged IDEA1 PR #141 closeout; recheck at execution)
K4                     = PASS (recheck live before the network is created)
K7                     = PASS_OWNER_ACCEPTED
K8 / K9 / K10          = BLOCKED
PHASE2B_OVERLAY        = repository form prepared on feat/idea3-pr11-phase2b-dispatch-overlay
LIVE_ARTIFACT_ON_HOST  = 16cee162…3722 (unchanged; Phase 2A installs the reconciled file over it)
```

## 1. After PR #144 merges (no Production change yet)

```bash
git fetch origin && git switch main && git pull --ff-only
cd IDEA3-AEGIS_Lockdown/deploy/pr11-phase2
MODE=local bash p2-final-preflight.sh          # every line must read PASS
```

The local preflight proves the reconciled artifact is on `main`, the Phase 2B
block is present but not included, the contract test is on `main`, the overlay
hash is unchanged, and no open IDEA1 PR declares runtime work.

Then take the **reconciled** artifact and its hash from `main` — this is what
Phase 2A installs:

```bash
git show origin/main:HUB-AEGIS_Entry/nginx.conf > ~/hub-nginx-candidate.conf
sha256sum ~/hub-nginx-candidate.conf           # expect 7ca8769e2abeb22a6e8af3d8a01b5d15bfe2abfb5c470ae7bf10d530a39e5ce2
git archive --format=tar 505dcdfb IDEA3-AEGIS_Lockdown/web | gzip -n > ~/idea3-web-context.tar.gz
```

Archive the **pinned source commit `505dcdfb`**, never `origin/main`. The
context hash must equal the value pinned in `p2-lib.sh` (`1710d0ee…`). PR #145
added `web/tests/server/phase2bOverlayContract.test.js`, so an `origin/main`
archive now hashes to `c8d93cda…` and `p2a-execute.sh` S0 would refuse it. That
file is under `web/tests/`, which `.dockerignore` excludes; the non-test `web/`
tree at `c89eeeca` is identical to `505dcdfb`, so the pinned image input is
unchanged. If non-test `web/` content changes, the image tag in both overlays
must be updated first — the script refuses the mismatch rather than building
something unreviewed.

## 2. Owner inputs still required

| Input | Owner | Note |
|---|---|---|
| The exact authorization phrase | Music | typed in the executing session, not carried over |
| `node:22-alpine` digest | Music | re-verify at build time; it was `sha256:c610fcdf…` on 2026-09-15 |
| `/opt/aegis/runtime/idea3/secrets/{session-secret,admin-password-hash}` | Music | `1000:1000`, `0400`; see README §3 |
| Kla present for the window | Kla | K7 rollback owner |

## 3. Phase 2A window

```bash
sudo EVID_DIR=~/idea3-p2a-evidence/pre bash p2a-baseline.sh        # must end BASELINE=PASS
MODE=server sudo bash p2-final-preflight.sh                        # must end PASS
sudo AEGIS_...=... DRY_RUN=1 bash p2a-execute.sh                   # rehearsal, changes nothing
sudo AUTHORIZE_IDEA3_PR11_PHASE2_RUNTIME_PRODUCTION_MUTATION=YES \
     K3_EXECUTION_WINDOW=CLEAR BASELINE_DIR=~/idea3-p2a-evidence/pre \
     OVERLAY_SRC=<repo>/IDEA3-AEGIS_Lockdown/deploy/docker-compose.pr11-phase2.yml \
     WEB_CONTEXT_TGZ=~/idea3-web-context.tar.gz \
     NODE_IMAGE_DIGEST=sha256:<verified> \
     K1_NGINX_CANDIDATE=~/hub-nginx-candidate.conf \
     K1_NGINX_CANDIDATE_SHA256=<sha from step 1> \
     bash p2a-execute.sh
sudo BASELINE_DIR=~/idea3-p2a-evidence/pre bash p2a-verify.sh      # must end VERIFY_PHASE2A=PASS
```

Then the browser checks from a trusted workstation (README §2). Record
everything in a copy of `PHASE2-CLOSEOUT-TEMPLATE.md`.

After Phase 2A, rerun the server preflight with the phase it is in:
`sudo PHASE=post2a MODE=server bash p2-final-preflight.sh` (then `pre2b` before
the Phase 2B window and `post2b` after it). Each phase pins its own NGINX
artifact, HUB config-hash, and placed overlay.

On any rollback trigger (README §4):

```bash
sudo CONFIRM_ROLLBACK=YES BASELINE_DIR=… [RUN_DIR=…] bash p2a-rollback.sh --stage web|full
sudo MODE=rollback BASELINE_DIR=… bash p2a-verify.sh
```

## 4. K8, then K9 and K10

1. **K8** needs the owner to name the Core host and put its wired link on
   VLAN 20. Then, on that host:
   `CORE_DECLARED=<hostname> WIRED_IF=<iface> bash p2-k8-core-evidence.sh`.
   A workstation over Twingate is not Core evidence.
2. **K9** is Kla's DNS entry plus a separate server certificate whose SAN carries
   `idea3-core.aegis.internal` (README §7). Validate a candidate before anyone
   installs it: `MODE=file CERT=<path> bash p2-k9-name-and-cert.sh`.
3. **K10** is the dedicated client CA, its CRL, and a Core certificate signed
   from a CSR generated on the Core (README §8). `MODE=contract bash
   p2-k10-client-pki.sh` prints the exact artifact split; `MODE=csr` runs on the
   Core; `MODE=verify` checks what Kla returns. The CA private key never leaves
   Kla, and no substitute CA is ever created.

## 5. Phase 2B window

The Phase 2B overlay form is merged (PR #145, `c89eeeca`,
`docker-compose.pr11-phase2b.yml`, SHA-256 `0be5e5b4…`). Place that file at the
same Production path, recreate only `idea3-web`, install IR-2, `nginx -t`, `nginx -s reload`, and
run `p2b-tests-core.sh` on the Core and `p2b-tests-server.sh` on the server.
The HUB is not recreated for Phase 2B.

## 6. Closeout

Fill `PHASE2-CLOSEOUT-TEMPLATE.md` from real output, update `idea3-status.md`,
add exactly one Music receipt, run the vault, policy, secret, binary and diff
checks, open a Draft PR, self-audit, mark Ready only when truthful, get a fresh
guardrail PASS, request `kraveerachat`, and never merge.

`PHASE2_RUNTIME_COMPLETE=YES` may be recorded only when K1, K3, K4, K7, K8, K9,
K10, Phase 2A and Phase 2B are all actually proven. K12 stays `NOT_PROVEN`, and
Phase 3, Phase 4, `D4_LIVE_VERIFIED` and `PR11_COMPLETE` stay `NO`.
