# Patch proposal: `setup-graduated.sh --with-attacker-veth` (NOT APPLIED)

## Finding

`setup-graduated.sh` (revision 3, as currently checked out) does **not** support an `--with-attacker-veth` flag or
anything equivalent. Its one logging rule is created with a fixed single interface:

```
# setup-graduated.sh, current line ~299
nft -f - <<EOF
add rule inet $LIVE_TABLE input position $H_BLOCK iifname { "$AP_IF" } ip saddr != $ESP_IP tcp flags & (syn | ack) == syn ct state new $LOG_LIMIT log prefix "AEGIS_NEWCONN " comment "$LOG_RULE_COMMENT"
EOF
```

`$AP_IF` is hard-coded to `wlp0s20f3` (line ~67). A new-connection SYN from `aegis-att-h` (the attacker namespace's
host-side veth, see `attacker-ns-up.sh`) therefore never matches this rule and is **never logged**, so the
production detector's port-scan and SYN-flood rules (which read only `AEGIS_NEWCONN` journal lines) cannot see
attacker-namespace traffic at all. The containment helper's block (`table inet aegis_idea3`) is interface-independent
and the SSH brute-force / login rules read `_COMM=sshd` journal records directly (also interface-independent), so
**G2a (SSH brute force) and the SSH-login half of G3 work today without any change.** Only the scan (G1) and the
SYN-flood (G2b) scenarios need this.

## Proposed change (unified diff, for review — do not apply without re-running the revision-3.1 preflight checks)

```diff
--- a/setup-graduated.sh
+++ b/setup-graduated.sh
@@
+# Lab-only: add one more interface to the new-connection log rule so a traffic generator reachable only from that
+# interface (never a production path) is scored exactly like AP traffic. Off by default; never changes anything
+# else. The interface must already exist and must not be $AP_IF.
+ATTACKER_VETH=""
+if [[ ${1:-} == --with-attacker-veth=* ]]; then
+  ATTACKER_VETH="${1#--with-attacker-veth=}"
+  [[ -n $ATTACKER_VETH && $ATTACKER_VETH != "$AP_IF" ]] || die "--with-attacker-veth needs a non-empty interface name that is not $AP_IF"
+  ip link show "$ATTACKER_VETH" >/dev/null 2>&1 || die "--with-attacker-veth=$ATTACKER_VETH: no such interface (bring up the attacker namespace first)"
+fi
@@ -297,7 +306,11 @@ setstate ST_LOGRULE
 nft -f - <<EOF
-add rule inet $LIVE_TABLE input position $H_BLOCK iifname { "$AP_IF" } ip saddr != $ESP_IP tcp flags & (syn | ack) == syn ct state new $LOG_LIMIT log prefix "AEGIS_NEWCONN " comment "$LOG_RULE_COMMENT"
+add rule inet $LIVE_TABLE input position $H_BLOCK iifname { "$AP_IF"$([[ -n $ATTACKER_VETH ]] && echo ", \"$ATTACKER_VETH\"") } ip saddr != $ESP_IP tcp flags & (syn | ack) == syn ct state new $LOG_LIMIT log prefix "AEGIS_NEWCONN " comment "$LOG_RULE_COMMENT"
 EOF
+if [[ -n $ATTACKER_VETH ]]; then
+  echo "   log rule also watches $ATTACKER_VETH (lab attacker namespace only)"
+fi
```

Two lines in the final summary (`echo "== result"` block) would also want `$ATTACKER_VETH` echoed, for an honest
record of what was actually watched.

## What this does and does not change

- **Adds:** one more `iifname` member on the *existing* log-only rule. The rule still has no verdict (`log` only,
  same rate limit, same position before the containment table's drop). No new rule, no new table, no change to
  priorities, no change to what the containment block does.
- **Never touches:** `core.env`, the Core restart logic, the containment helper, the detector account, the
  `MUST_BE_HIDDEN` sandbox list, or anything outside the one rule shown above.
- **Still refuses** exactly as before if the interface does not exist, so a stale or mistyped flag fails safely
  (and rolls back via the existing EXIT trap) instead of silently doing nothing.
- **Still lab-only and reversible:** `teardown-graduated.sh` already removes the log rule by its comment
  (`aegis-live-graduated-log`), regardless of how many interfaces are in its `iifname` set, so no change is needed
  there.

## Until this (or something like it) is applied

- Run `attacker-ns-up.sh` to bring up the namespace.
- Run `setup-graduated.sh` exactly as it is today (no flag).
- G1 (port scan) and G2b (SYN flood) from inside the namespace will **not** be detected or scored, because their
  SYNs never reach the log rule. This is a true negative of the harness, not of the Core: a real wireless scanner
  on the AP interface is still scored correctly.
- G2a (SSH brute force, and the login half of a later G3 test) are unaffected and will be detected correctly today,
  because they are read from `_COMM=sshd` journal records, not from this rule.

## Owner review needed before this patch is applied

1. Confirm `$ATTACKER_VETH` should be allowed at all on a script whose header says "lab-only, narrow design" —
   i.e., that adding an attacker-controlled interface to the Core's own log rule, even log-only and even gated
   behind an explicit flag, is an acceptable testing accommodation.
2. Decide whether the flag should also assert the interface carries only the `10.90.90.0/30` addressing from
   `attacker-ns-up.sh` (an extra guard against pointing it at something else by mistake).
3. Re-run revision-3.1's preflight checks and the isolation `sandbox_report` after applying, since the diff touches
   the `setup-graduated.sh` the sandbox/priority checks run against.
