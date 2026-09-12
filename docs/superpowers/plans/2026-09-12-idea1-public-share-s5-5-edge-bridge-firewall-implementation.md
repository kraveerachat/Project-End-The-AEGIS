# AEGIS IDEA1 — PUBLIC-SHARE-7 S5.5 Edge-Bridge Firewall Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Production-discovered same-bridge east-west isolation gap in S5.5 by adding a narrowly scoped native nftables `bridge` enforcement plane, while preserving the accepted iptables-nft routed/host protections, S5.4 topology, connector object identity, and all existing no-public-exposure boundaries.

**Architecture:** Keep `s5-5-firewall.sh` as the single lifecycle owner for three enforcement planes: `AEGIS-PS-EGRESS` in `DOCKER-USER`, `AEGIS-PS-INPUT` in `INPUT`, and a native `table bridge aegis_s55_edge` for connector↔Gateway traffic on the dynamically resolved `aegis_public_share_edge` Linux bridge. The bridge plane is stateless and permits only connector `172.31.240.3` → Gateway `172.31.240.2` TCP destination port 8080 plus the exact reverse TCP source-port 8080 flow; all other IPv4 traffic to/from the connector edge address is dropped. Do not load `br_netfilter` or change global bridge sysctls.

**Tech Stack:** Bash, Docker Engine/Compose, iptables-nft, nftables native bridge family, systemd, Node.js `node:test` disposable mocks.

**Spec:** `docs/superpowers/specs/2026-09-12-idea1-public-share-s5-5-edge-bridge-firewall-design.md`

## Global Constraints

- Work only on PR #118 branch `feat/idea1-public-share-s5-5-cloudflared-egress-isolation`; keep the PR Draft and unmerged.
- Current approved written-spec checkpoint is commit `27ec8afbc2e8d9d3d9b7520bd54ba917dba72938`.
- S5.4 topology is immutable: do not change `docker-compose.s5-4.yml`, Drive, Gateway, database, volumes, edge/upstream network addressing, MikroTik, or Twingate.
- Do not change `docker-compose.s5-5.yml`, Cloudflare token contents, connector image pin, endpoint allowlist, public hostname, DNS/TLS, or Public Share UI unless a new verified blocker forces a separate owner approval gate.
- Do not run `modprobe br_netfilter`, do not write `/proc/sys/net/bridge/*`, and do not set `net.bridge.bridge-nf-call-iptables` or `net.bridge.bridge-nf-call-ip6tables`.
- `s5-5-firewall.sh validate` remains read-only and becomes authoritative for all three firewall planes.
- Native bridge apply must use `nft --check -f` before commit and a single `nft -f` batch transaction; no rule-by-rule live mutation.
- Foreign or ambiguous `table bridge aegis_s55_edge` ownership must fail closed; never overwrite or delete it.
- No Production mutation during Tasks 1–5. Production correction resumes only after repository tests and review pass.
- Production starts from the current safe state: connector exists but is stopped (`exited`), S5.5 iptables firewall service remains active/fail-closed, persistence remains disabled, public DNS/TLS remains absent.
- F1 remains incomplete until the corrected isolation matrix, two live reconciliation cycles, and final F1 evidence review all pass.

---

### Task 1: Add RED bridge-firewall contract harness

**Files:**
- Create: `IDEA1-AEGIS_Drive_LC/tests/publicShareS55BridgeFirewallContract.test.js`
- Read: `IDEA1-AEGIS_Drive_LC/tests/publicShareS55FirewallContract.test.js`
- Read: `gateway/public-share/production/s5-5-firewall.sh`

**Interfaces:**
- Consumes: existing test seams `AEGIS_IPTABLES_BIN`, `AEGIS_DOCKER_BIN`, `AEGIS_SYSFS_NET`, `AEGIS_CONNECTOR_CONTAINER`.
- Produces: new seam `AEGIS_NFT_BIN` and disposable mock-nft state contract used by Task 2.

- [ ] **Step 1: Create the disposable mock nft harness and first failing contract tests**

Create `publicShareS55BridgeFirewallContract.test.js` with a temp-directory harness analogous to `publicShareS55FirewallContract.test.js`. The mock must record `--check -f`, `-f`, `list table bridge aegis_s55_edge`, and `delete table bridge aegis_s55_edge` operations without touching the host.

Use these canonical constants in the test:

```js
const TABLE = 'aegis_s55_edge'
const FAMILY = 'bridge'
const CHAIN = 'forward'
const OWNER = 'AEGIS-PUBLIC-SHARE-S5.5'
const CONNECTOR = '172.31.240.3'
const GATEWAY = '172.31.240.2'
const CURRENT_MEASURED_BRIDGE = 'br-c76a97580271' // evidence only; source must not pin it
```

The first RED tests must assert the current pre-correction source fails these contracts:

```js
test('apply requires native nft bridge enforcement', () => {
  const h = harness()
  const r = h.run('apply')
  assert.notEqual(r.status, 0)
  assert.match(r.stderr + r.stdout, /nft|bridge|aegis_s55_edge/i)
})

test('source never mutates global bridge netfilter settings', () => {
  const text = effectiveSource()
  assert.doesNotMatch(text, /modprobe\s+br_netfilter/)
  assert.doesNotMatch(text, /bridge-nf-call-iptables/)
  assert.doesNotMatch(text, /\/proc\/sys\/net\/bridge/)
})
```

Add RED expectations for exact forward/reverse HTTP rule intent and terminal source/destination drops. The test may inspect mock batch text rather than depend on nft pretty-print formatting.

- [ ] **Step 2: Run only the new test and prove RED**

Run:

```bash
cd IDEA1-AEGIS_Drive_LC
node --test tests/publicShareS55BridgeFirewallContract.test.js
```

Expected: FAIL because the current `s5-5-firewall.sh` has no `AEGIS_NFT_BIN`, no `bridge aegis_s55_edge`, and no bridge batch apply/validate/remove logic.

Record the failing test names and exact failure reason in the task notes. Do not change production code before this RED run is captured.

- [ ] **Step 3: Add the complete RED matrix before implementation**

Add tests for all of these behaviors:

```text
missing nft binary -> apply fails before any nft commit
nft --check failure -> apply fails before nft -f commit
edge bridge derives from Docker network ID/options, never hard-coded measured suffix
owned table exact family/table/comment/chain/hook/priority/policy
connector -> gateway tcp dport 8080 accept
reverse gateway tcp sport 8080 -> connector accept
other IPv4 source connector drop
other IPv4 destination connector drop
ARP is not denied by terminal rules
extra/broad ACCEPT makes validate fail
wrong port/bridge makes validate fail
foreign same-name table makes apply/remove fail closed
owned table absent during remove is idempotent
connector active makes remove refuse
no br_netfilter/sysctl mutation strings
```

- [ ] **Step 4: Re-run and prove the RED matrix is meaningful**

Run:

```bash
cd IDEA1-AEGIS_Drive_LC
node --test tests/publicShareS55BridgeFirewallContract.test.js
```

Expected: multiple intentional failures attributable to missing bridge enforcement, not harness syntax errors.

- [ ] **Step 5: Commit tests only**

```bash
git add IDEA1-AEGIS_Drive_LC/tests/publicShareS55BridgeFirewallContract.test.js
git commit -m "test(idea1): define S5.5 edge bridge firewall contract"
```

---

### Task 2: Implement native nft bridge apply/validate/remove in the firewall owner

**Files:**
- Modify: `gateway/public-share/production/s5-5-firewall.sh`
- Test: `IDEA1-AEGIS_Drive_LC/tests/publicShareS55BridgeFirewallContract.test.js`
- Test: `IDEA1-AEGIS_Drive_LC/tests/publicShareS55FirewallContract.test.js`

**Interfaces:**
- Consumes: `AEGIS_NFT_BIN` test seam, Docker edge-network inspection, current connector state guard.
- Produces: functions `require_nft_bridge_support`, `bridge_candidate`, `bridge_apply`, `bridge_validate`, `bridge_remove` integrated into existing `apply|validate|remove` modes.

- [ ] **Step 1: Add constants and nft test seam**

Add near the existing tool seams:

```bash
readonly BRIDGE_FAMILY='bridge'
readonly BRIDGE_TABLE='aegis_s55_edge'
readonly BRIDGE_CHAIN='forward'
readonly BRIDGE_OWNER='AEGIS-PUBLIC-SHARE-S5.5'

NFT="${AEGIS_NFT_BIN:-nft}"
```

Do not add any `modprobe` or bridge sysctl handling.

- [ ] **Step 2: Add fail-closed nft preflight**

Implement:

```bash
require_nft_bridge_support() {
  command -v "$NFT" >/dev/null 2>&1 \
    || die 'nft CLI is required for S5.5 edge-bridge isolation'
  "$NFT" list tables >/dev/null 2>&1 \
    || die 'cannot inspect nftables ruleset'
}
```

When a same-name table exists, inspect it before mutation. Treat it as owned only if the rendered table contains the exact ownership marker and expected base-chain identity; otherwise call `die`.

- [ ] **Step 3: Generate one canonical bridge batch**

Implement `bridge_candidate()` to print a complete nft batch using the runtime-resolved edge bridge. The canonical rule semantics are:

```nft
table bridge aegis_s55_edge {
  comment "AEGIS-PUBLIC-SHARE-S5.5"
  chain forward {
    type filter hook forward priority 0; policy accept;

    iifname "<edge-bridge>" oifname "<edge-bridge>" \
      ether type ip ip saddr 172.31.240.3 ip daddr 172.31.240.2 \
      tcp dport 8080 counter accept comment "AEGIS-S55 edge connector-to-gateway-http"

    iifname "<edge-bridge>" oifname "<edge-bridge>" \
      ether type ip ip saddr 172.31.240.2 ip daddr 172.31.240.3 \
      tcp sport 8080 counter accept comment "AEGIS-S55 edge gateway-http-return"

    iifname "<edge-bridge>" ether type ip ip saddr 172.31.240.3 \
      counter drop comment "AEGIS-S55 edge connector-source-deny"

    oifname "<edge-bridge>" ether type ip ip daddr 172.31.240.3 \
      counter drop comment "AEGIS-S55 edge connector-destination-deny"
  }
}
```

If nft syntax on the implementation host requires `ibrname`/`obrname` rather than `iifname`/`oifname` for bridge metadata, use the form accepted by `nft --check`; keep the semantic test contract identical and document the chosen syntax. Never pin veth names.

- [ ] **Step 4: Add candidate no-commit validation and atomic commit**

Implement `bridge_apply()` using a root-owned temporary file created with `mktemp`, `chmod 0600`, and an EXIT/RETURN cleanup trap. Write a batch that deletes the positively owned table if present and recreates it in the same transaction, then:

```bash
"$NFT" --check -f "$candidate" \
  || die 'native bridge candidate failed nft --check'
"$NFT" -f "$candidate" \
  || die 'native bridge firewall transaction failed'
```

The batch must never contain `flush ruleset` or deletes of unrelated tables.

- [ ] **Step 5: Implement semantic bridge validation**

Implement `bridge_validate()` as read-only. Obtain:

```bash
"$NFT" -j list table bridge "$BRIDGE_TABLE"
```

Parse JSON with Node.js, not raw string order, and require:

```text
family == bridge
table == aegis_s55_edge
table comment == AEGIS-PUBLIC-SHARE-S5.5
exactly one chain named forward
chain type == filter
hook == forward
priority == 0
policy == accept
exactly four owned rules in canonical semantic order
resolved edge bridge appears in each rule as designed
no additional accept/drop rule exists in the owned chain
```

The validator must fail if JSON cannot be parsed or if any required field cannot be proven.

- [ ] **Step 6: Implement ownership-safe bridge removal**

After the existing `require_connector_inactive` guard succeeds:

```bash
bridge_remove
```

Behavior:

```text
table absent -> success
owned exact table -> delete table bridge aegis_s55_edge
same-name table without exact ownership -> fail closed
```

Do not make `bridge_remove` stop a container.

- [ ] **Step 7: Integrate order into existing modes**

Canonical command behavior:

```text
apply:
  require_nft_backend
  require_host_chains
  require_nft_bridge_support
  resolve edge bridge
  build/check bridge candidate
  reconcile iptables chains
  bridge_apply

validate:
  require_nft_backend
  require_host_chains
  require_nft_bridge_support
  validate iptables
  bridge_validate

remove:
  require_connector_inactive
  bridge_remove
  remove task-owned iptables anchors/chains
```

The actual remove order may delete iptables before bridge only if the connector has already been positively proven inactive; document the chosen deterministic order and test it.

- [ ] **Step 8: Run bridge-focused GREEN tests**

```bash
cd IDEA1-AEGIS_Drive_LC
node --test tests/publicShareS55BridgeFirewallContract.test.js
```

Expected: PASS, 0 failures.

- [ ] **Step 9: Run existing firewall regression suite**

```bash
cd IDEA1-AEGIS_Drive_LC
node --test tests/publicShareS55FirewallContract.test.js
```

Expected: all existing firewall tests still PASS. If harnesses now require mock nft, extend the existing harness to supply `AEGIS_NFT_BIN`; do not weaken any existing assertions.

- [ ] **Step 10: Commit firewall implementation**

```bash
git add \
  gateway/public-share/production/s5-5-firewall.sh \
  IDEA1-AEGIS_Drive_LC/tests/publicShareS55BridgeFirewallContract.test.js \
  IDEA1-AEGIS_Drive_LC/tests/publicShareS55FirewallContract.test.js
git commit -m "fix(idea1): enforce S5.5 same-bridge isolation"
```

---

### Task 3: Add IPv6 fail-closed runtime invariant and lifecycle integration

**Files:**
- Modify: `gateway/public-share/production/s5-5-runtime-check.sh`
- Modify: `IDEA1-AEGIS_Drive_LC/tests/publicShareS55RuntimeContract.test.js`
- Modify: `gateway/public-share/production/rollback-s5-5.sh`
- Modify: `gateway/public-share/production/systemd/aegis-public-share-s5-5-firewall.service`

**Interfaces:**
- Consumes: Docker network inspect metadata `EnableIPv6`, `s5-5-firewall.sh validate`.
- Produces: pre-start/drift refusal when edge-network IPv6 state is not explicitly false; rollback documentation/assertions recognize bridge table removal through firewall owner.

- [ ] **Step 1: Write failing runtime tests first**

Add tests to `publicShareS55RuntimeContract.test.js` that construct edge-network fixtures with:

```js
EnableIPv6: false // accepted
EnableIPv6: true  // rejected
// missing EnableIPv6 -> rejected because invariant cannot be proven
```

Expected contract: `--pre-start` and drift validation must fail for `true` or missing.

- [ ] **Step 2: Run the focused runtime tests and prove RED**

```bash
cd IDEA1-AEGIS_Drive_LC
node --test tests/publicShareS55RuntimeContract.test.js
```

Expected: new IPv6 cases FAIL against the current runtime checker.

- [ ] **Step 3: Extend network metadata extraction**

In `s5-5-runtime-check.sh`, extend `network_field()` with:

```js
: field === "enableipv6" ? String(net?.EnableIPv6 === true)
```

Because missing and explicit false would otherwise collapse to the same string, also expose presence explicitly, for example:

```js
: field === "has-enableipv6" ? String(Object.prototype.hasOwnProperty.call(net ?? {}, "EnableIPv6"))
```

Then require for `aegis_public_share_edge`:

```bash
[ "$(network_field "$json" has-enableipv6)" = 'true' ] \
  || { fail "${EDGE_NETWORK} must explicitly report EnableIPv6"; status=1; }
[ "$(network_field "$json" enableipv6)" = 'false' ] \
  || { fail "${EDGE_NETWORK} must keep EnableIPv6=false"; status=1; }
```

Do not infer safety from an empty observed container IPv6 address.

- [ ] **Step 4: Update rollback and firewall-service contract text**

Keep rollback executable ordering unchanged. Update comments/assertions so step 4 explicitly states that `s5-5-firewall.sh remove` removes both task-owned iptables state and the positively owned `bridge aegis_s55_edge` table.

Update firewall unit description/comments only; keep:

```ini
ExecStart=/opt/aegis/runtime/public-share/s5-5-firewall.sh apply
ExecStartPost=/opt/aegis/runtime/public-share/s5-5-firewall.sh validate
ExecStop=/opt/aegis/runtime/public-share/s5-5-firewall.sh remove
```

No new systemd unit is allowed.

- [ ] **Step 5: Run runtime + firewall suites**

```bash
cd IDEA1-AEGIS_Drive_LC
node --test \
  tests/publicShareS55RuntimeContract.test.js \
  tests/publicShareS55FirewallContract.test.js \
  tests/publicShareS55BridgeFirewallContract.test.js
```

Expected: 0 failures.

- [ ] **Step 6: Commit runtime/lifecycle integration**

```bash
git add \
  gateway/public-share/production/s5-5-runtime-check.sh \
  gateway/public-share/production/rollback-s5-5.sh \
  gateway/public-share/production/systemd/aegis-public-share-s5-5-firewall.service \
  IDEA1-AEGIS_Drive_LC/tests/publicShareS55RuntimeContract.test.js
git commit -m "fix(idea1): fail closed on S5.5 edge network bypasses"
```

---

### Task 4: Update runbook and correction evidence contract

**Files:**
- Modify: `gateway/public-share/production/README.md`
- Modify: `docs/superpowers/specs/2026-09-12-idea1-public-share-s5-5-edge-bridge-firewall-design.md` (status only: written spec owner-approved)

**Interfaces:**
- Consumes: corrected firewall/runtime behavior from Tasks 2–3.
- Produces: exact operator procedure for stopped deployment, F1E matrix, failure handling, and rollback.

- [ ] **Step 1: Reconcile the design status**

Change only the status wording from written-spec-pending-review to owner-approved written spec / implementation in progress. Preserve all approved design content.

- [ ] **Step 2: Add the Production-discovered root cause to README**

Document verbatim operational facts:

```text
br_netfilter not loaded
bridge-nf-call-iptables unavailable
same-bridge Gateway:22 returned ECONNREFUSED
AEGIS-PS-EGRESS connector-edge DROP counter did not increment
connector safety-stop returned it to exited/running=false
```

Explain that routed egress remains enforced by iptables-nft and same-bridge east-west is now enforced by native nft bridge family.

- [ ] **Step 3: Document corrected first-start order**

The runbook must specify:

```text
connector stopped
install exact reviewed corrected artifacts
nft candidate check + firewall apply
full three-plane validate
runtime --pre-start
start same connector object via systemd
readiness + DNS
isolation matrix with responsible-plane counters
2x live reconcile
F1 final evidence review
```

Explicitly forbid `modprobe br_netfilter`, bridge sysctl mutation, public DNS/TLS, `compose down`, and connector recreation.

- [ ] **Step 4: Document bridge counter evidence**

For same-bridge negative probes, the acceptance rule must say that endpoint refusal/timeout alone is insufficient; the native bridge DROP counter must increase.

- [ ] **Step 5: Commit documentation**

```bash
git add \
  gateway/public-share/production/README.md \
  docs/superpowers/specs/2026-09-12-idea1-public-share-s5-5-edge-bridge-firewall-design.md
git commit -m "docs(idea1): document S5.5 edge bridge correction"
```

---

### Task 5: Repository verification and review checkpoint

**Files:**
- Verify all files changed by Tasks 1–4.
- Do not mutate Production.

**Interfaces:**
- Consumes: repository implementation.
- Produces: reviewed exact source commit/blob set eligible for controlled Production redeployment.

- [ ] **Step 1: Syntax checks**

```bash
bash -n gateway/public-share/production/s5-5-firewall.sh
bash -n gateway/public-share/production/s5-5-runtime-check.sh
bash -n gateway/public-share/production/rollback-s5-5.sh
```

Expected: exit 0.

- [ ] **Step 2: Run focused S5.5 suites**

```bash
cd IDEA1-AEGIS_Drive_LC
node --test \
  tests/publicShareS55BridgeFirewallContract.test.js \
  tests/publicShareS55FirewallContract.test.js \
  tests/publicShareS55RuntimeContract.test.js \
  tests/publicShareSecurityRegression.test.js \
  tests/publicShareCloudflareEndpoints.test.js \
  tests/publicShareCloudflaredPin.test.js
```

Expected: 0 failures.

- [ ] **Step 3: Run S5.4/Gateway regressions**

```bash
cd IDEA1-AEGIS_Drive_LC
node --test \
  tests/publicShareS54RuntimeContract.test.js \
  tests/publicShareGatewayStructure.test.js
```

Expected: 0 failures.

- [ ] **Step 4: Run full IDEA1 suite and compare to known baseline**

```bash
cd IDEA1-AEGIS_Drive_LC
npm test
```

Acceptance: no new failures beyond the existing nine known baseline failures already recorded in PR #118. Record total/pass/fail counts from this fresh run; do not reuse historical counts.

- [ ] **Step 5: Repository policy/whitespace verification**

From repository root:

```bash
node --test tests/collaborationPolicy.test.mjs
node scripts/validate-vault.mjs
git diff --check
git diff origin/main...HEAD -- gateway/public-share/production/docker-compose.s5-4.yml
```

Expected: collaboration tests pass; vault has no new errors; whitespace clean; S5.4 overlay diff empty.

- [ ] **Step 6: Security negative scan for forbidden global bridge mutations**

```bash
git grep -nE 'modprobe[[:space:]]+br_netfilter|bridge-nf-call-iptables|/proc/sys/net/bridge' \
  -- gateway/public-share/production IDEA1-AEGIS_Drive_LC/tests
```

Any executable production occurrence is a blocker. Documentation/tests may mention forbidden strings only as assertions or explanatory text.

- [ ] **Step 7: Review exact diff and freeze Production candidate**

```bash
git status --short
git log -5 --oneline
git diff origin/main...HEAD -- \
  gateway/public-share/production/s5-5-firewall.sh \
  gateway/public-share/production/s5-5-runtime-check.sh \
  gateway/public-share/production/rollback-s5-5.sh \
  gateway/public-share/production/systemd/aegis-public-share-s5-5-firewall.service \
  IDEA1-AEGIS_Drive_LC/tests/publicShareS55BridgeFirewallContract.test.js \
  IDEA1-AEGIS_Drive_LC/tests/publicShareS55FirewallContract.test.js \
  IDEA1-AEGIS_Drive_LC/tests/publicShareS55RuntimeContract.test.js
```

Record HEAD SHA and Git blob SHAs for every Production artifact that will be installed. Keep PR #118 Draft.

- [ ] **Step 8: Commit any verification-only documentation correction, otherwise do not create a meaningless commit**

If no files changed during verification, leave HEAD unchanged. If a factual README/spec correction was required, commit only that correction and rerun the affected verification command.

---

### Task 6: Controlled Production redeploy with connector stopped

**Files:**
- Production install targets under `/opt/aegis/runtime/public-share/` only.
- Source must be exact reviewed Task 5 HEAD.

**Interfaces:**
- Consumes: frozen repository commit/blob set.
- Produces: corrected three-plane firewall installed and validated while connector remains stopped.

- [ ] **Step 1: Reconfirm safe Production starting state**

Required evidence before source installation:

```text
connector Status=exited Running=false Restarting=false Paused=false Dead=false
firewall service active
connector service inactive
firewall/connector/drift units disabled
public hostname unresolved
```

If connector is running, stop and investigate; do not deploy over an active connector.

- [ ] **Step 2: Fetch exact reviewed branch commit as root without checking out Production working tree**

Use the established root-owned-repo pattern:

```bash
sudo git -C /opt/aegis/Project-End-The-AEGIS fetch origin \
  refs/heads/feat/idea1-public-share-s5-5-cloudflared-egress-isolation:refs/remotes/origin/feat/idea1-public-share-s5-5-cloudflared-egress-isolation
```

Compare fetched ref to the frozen Task 5 HEAD. Abort on mismatch.

- [ ] **Step 3: Extract reviewed artifacts and verify blobs before install**

Extract with `sudo git show <HEAD>:<path>` to temporary files, `bash -n` scripts, hash with `git hash-object`, and compare against recorded Task 5 blobs.

Install only:

```text
s5-5-firewall.sh
s5-5-runtime-check.sh
rollback-s5-5.sh (only if changed)
aegis-public-share-s5-5-firewall.service (only if changed)
```

Do not touch token contents or Compose overlays.

- [ ] **Step 4: daemon-reload only if the systemd unit file changed**

```bash
sudo systemctl daemon-reload
```

Do not enable any unit.

- [ ] **Step 5: Validate network metadata including explicit EnableIPv6=false before firewall mutation**

Use Docker inspect/network inspect and the corrected runtime checker in a non-starting path. If Production Docker omits the `EnableIPv6` field rather than explicitly returning false, stop here and treat it as a verified implementation blocker; do not weaken the invariant without a new owner design decision.

- [ ] **Step 6: Apply and validate corrected firewall while connector remains stopped**

```bash
sudo /opt/aegis/runtime/public-share/s5-5-firewall.sh apply
sudo /opt/aegis/runtime/public-share/s5-5-firewall.sh validate
sudo /opt/aegis/runtime/public-share/s5-5-runtime-check.sh --pre-start
```

Verify native table identity/counters with:

```bash
sudo nft list table bridge aegis_s55_edge
```

and prove connector is still `exited/running=false`.

- [ ] **Step 7: Stop for checkpoint review**

Do not start connector until the stopped-state three-plane evidence is reviewed and accepted in chat.

---

### Task 7: Resume connector runtime and rerun corrected F1E isolation matrix

**Files:**
- No repository mutation expected.
- Production runtime only, already within S5.5-F correction scope after Task 6 checkpoint approval.

**Interfaces:**
- Consumes: corrected validated firewall and stopped same connector object.
- Produces: positive/negative isolation evidence proving the root cause is closed.

- [ ] **Step 1: Start the same connector object through systemd**

```bash
sudo systemctl start aegis-public-share-connector.service
```

Capture ID/Created before and after; they must match. Confirm readiness and exactly two accepted network attachments.

- [ ] **Step 2: Re-prove Cloudflare readiness and DNS path**

Require:

```text
cloudflared ready = PASS
configured resolver measured
DNS UDP query = PASS
DNS TCP query = PASS
DNS_EXCEPTION_ADDED=NO
```

Do not add port 53 firewall exceptions.

- [ ] **Step 3: Positive probes**

Prove:

```text
connector edge -> Gateway 172.31.240.2:8080 = PASS
connector egress -> reviewed Cloudflare /32 TCP/7844 = PASS
```

Record responsible ACCEPT counters where practical.

- [ ] **Step 4: Same-bridge negative probes with native bridge counters**

For Gateway:22 and at least one additional unauthorized Gateway port:

1. read the native bridge terminal source-DROP counter;
2. send the probe from connector netns;
3. read the counter again;
4. require `after > before`.

Endpoint `ECONNREFUSED`, timeout, or route failure without counter increase is NOT sufficient.

- [ ] **Step 5: Routed/host negative probes**

Re-prove with the responsible iptables DROP counter:

```text
Drive 172.31.241.3:8001 blocked
PostgreSQL 172.31.241.3:5432 blocked
reviewed Cloudflare endpoint TCP/443 blocked
1.1.1.1:443 blocked
host SSH 192.168.10.10:22 blocked
host docker bridge 172.18.0.1:18077 blocked
Cloudflare UDP/7844 terminal drop counter increases
```

- [ ] **Step 6: Re-prove no public/listener/persistence drift**

Require:

```text
HOST_7844_LISTENER=NO
HOST_20241_LISTENER=NO
PUBLIC_HOSTNAME_RESOLVES=NO
PUBLIC_DNS_TLS=NOT_CONFIGURED
SYSTEMD_ENABLED=NO
DRIFT_TIMER_STARTED=NO
br_netfilter remains not loaded
bridge sysctls remain absent/unmodified
Drive and Gateway remain running/unrecreated
```

- [ ] **Step 7: Two live firewall reconciliation cycles**

While cloudflared readiness is healthy, run twice:

```bash
sudo /opt/aegis/runtime/public-share/s5-5-firewall.sh apply
sudo /opt/aegis/runtime/public-share/s5-5-firewall.sh validate
```

After each cycle require readiness still passes, connector ID/Created unchanged, iptables staging chains absent, one owned `bridge aegis_s55_edge` only, and exact policy validation passes.

- [ ] **Step 8: Stop for F1 final acceptance review**

Do not enable services and do not start S5.5-G. Assemble the canonical F1 evidence block and review it in chat.

---

### Task 8: F1 repository/status reconciliation after runtime acceptance

**Files:**
- Modify only after F1 is formally accepted:
  - `gateway/public-share/production/README.md`
  - `docs/superpowers/plans/2026-09-11-idea1-public-share-s5-5-implementation.md`
  - `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md`
  - `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md`
  - `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-moc.md`
  - PR #118 body/status text

**Interfaces:**
- Consumes: accepted F1 evidence.
- Produces: truthful checkpoint for the next separately gated S5.5-G phase; no final receipt yet.

- [ ] **Step 1: Record F1 as CLOSED/PASS only after evidence review**

Include the Production-discovered false assumptions and corrections:

```text
original iptables-only same-bridge assumption disproven
br_netfilter deliberately left untouched
native nft bridge correction accepted
DNS path measured via 127.0.0.11 without DNS exception
full isolation matrix accepted
2x live reconciliation accepted
```

- [ ] **Step 2: Preserve open gates**

Keep explicit:

```text
S5.5-G = NOT STARTED / requires owner approval
S5.5-H = NOT STARTED
G5 = OPEN
public DNS/TLS = NOT CONFIGURED
Public Share UI = OFF
final immutable S5.5 receipt = NOT CREATED
```

- [ ] **Step 3: Run documentation verification**

```bash
node scripts/validate-vault.mjs
node --test tests/collaborationPolicy.test.mjs
git diff --check
```

- [ ] **Step 4: Commit reconciliation and keep PR Draft**

Use a documentation-only commit. Do not mark Ready, merge, or create the final receipt.

---

## Execution Boundary After This Plan

After Task 8, the remaining S5.5 work is deliberately separate:

1. **S5.5-G — Restart / persistence / rollback acceptance**: owner approval required before enabling units, Docker/host restart tests, drift-watchdog acceptance, or full rollback exercise.
2. **S5.5-H — Final documentation / closeout**: only after G passes; reconcile canonical notes and create exactly one immutable S5.5 receipt.
3. **G5 / public DNS/TLS / Public Share UI**: remain later gates. Nothing in this correction authorizes a public hostname route or UI activation.

## Plan Self-Review Checklist

- Spec coverage: architecture, ownership, atomic batch, validation, removal, IPv6 fail-closed, TDD, Production acceptance, and rollback are each mapped to explicit tasks.
- No implementation step loads `br_netfilter` or writes global bridge sysctls.
- No task changes S5.4 topology or connector Compose topology.
- TDD begins with a RED test-only commit before production firewall code.
- Production begins only after repository verification and with connector stopped.
- Same-bridge negative acceptance requires native bridge counter evidence, not endpoint behavior alone.
- F1 does not enable persistence; S5.5-G remains separately owner-gated.
- No final receipt is created before S5.5-H.
