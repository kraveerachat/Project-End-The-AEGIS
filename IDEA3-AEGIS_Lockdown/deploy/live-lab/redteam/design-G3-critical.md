# Design note: a safe way to produce `ssh_login_after_failures` for the G3 CRITICAL scenario

**Analysis only. No attack was run, and no script in this harness builds or starts anything described below. This
file asks for your approval before anything here is built.**

**Decision (owner review, 2026-10-25): proceed with Option A only.** Option B (Metasploit) is dropped for now and
kept below only as a possible later addition on top of Option A, should a scripted end-to-end run ever be wanted.
Nothing in this file is implemented; Option A still needs your go-ahead on the address it would bind to (named
below) before any script is written.

## The problem

`graduated_response.py`'s only path to CRITICAL is corroboration, and the one corroboration a lab can produce on
demand without the Core's own containment failing is `SSH_LOGIN_AFTER_FAILURES` — a successful SSH login from an
address that already crossed the brute-force rule in the same evidence window (`EVIDENCE_WINDOW_SEC` = 600 s). The
detector only trusts this from a specific, narrow source: a journald record whose `_COMM` is `sshd` and whose
`_UID` is `0` (`graduated_detector.py:59`), matched against `Accepted \S+ for \S+ from (IP) port` — the auth
*method* word (`password`, `publickey`, ...) is not checked, only that sshd itself logged an `Accepted` line for
that address.

A real, password-authenticated `sshd` on the Core's own host is the obvious way to get that line — and the one way
this harness must **not** use: it would mean either exposing a real account's password over the lab network for a
test to "guess" (a real weaker credential on the real machine), or accepting a genuine authenticated session on the
host under test. Option A below instead builds a **separate**, deliberately unusable-by-password `sshd` just for
this one signal.

## Option A — a dedicated `sshd`, its own address, a password-locked account, success only by SSH key

**What it is.** A second `sshd` process (same binary, its own config file and its own host key — never the host's
real one), started the way the containment helper and the graduated detector already are in `setup-graduated.sh`:
a transient `systemd-run` unit with `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp`, `NoNewPrivileges`, and
an `InaccessiblePaths=` list hiding the same secret paths that script already hides. One dedicated, newly created
system account (e.g. `aegis-redteam-sshd`), with:

**Exactly where it lives, and why that address is lab-only (corrects the first draft of this note, which
suggested `10.77.30.2` — checked against `etc/dnsmasq.conf` since writing that draft, `10.77.30.2`-`10.77.30.14`
is the live DHCP pool, so that address could be handed to a real DHCP client and collide with the test target; it
is withdrawn).** The right address is `10.90.90.5` (or `.6`), added to `aegis-att-h` — the **host side** of the
attacker veth, inside the same `10.90.90.0/29` `attacker-ns-up.sh` already carves out and proves isolated. This
needs **no new route anywhere**: the namespace already holds the kernel's own connected-subnet route for
`10.90.90.0/29` (added automatically when its own addresses were assigned, see `attacker-ns-up.sh`), so it can
already reach `10.90.90.5` the moment that address exists on the host side — nothing to add, nothing to open.
It is lab-only for the same three reasons the rest of this harness is: the `/29` overlaps neither
`10.77.30.0/28` nor `192.168.1.0/24`, it is not reachable from the Internet or the home LAN (no route anywhere
points traffic there except through this one veth), and it never touches the AP interface, the DHCP pool, or any
address a real wireless client could also receive.

- `passwd -l` (a locked, unusable password hash — not merely absent) and the daemon-wide `PasswordAuthentication
  no`, so no brute-force guess can ever succeed by password, by construction, not by luck;
- `PubkeyAuthentication yes` and exactly one authorized key (generated for this test, kept outside the Core's
  secrets and repo trees);
- a login shell of `/usr/sbin/nologin` — `sshd` logs its `Accepted publickey for ... from ... port ...` line
  **before** it tries to start a shell, so the account can still "succeed" at login for the detector's purposes
  while never actually getting a shell on the host.

**What it adds to the machine.** One extra system account, one extra `sshd` binary invocation (not an extra
package — `sshd` is already installed), one extra host key file, one transient systemd unit, and one extra
address (`10.90.90.5`) on `aegis-att-h`, an interface that already exists only for this harness and is already
proven isolated.

**How it stays isolated.** Everything above is new and removable: the account, the host key and the unit are
created and torn down the same way `setup-graduated.sh` / `teardown-graduated.sh` create and tear down the
detector account's unit — nothing is reused from, or shared with, the Core's real SSH configuration (`/etc/ssh/`
is already in every `InaccessiblePaths=` list in this repo's lab scripts). The account can never authenticate by
password anywhere, on this `sshd` or the real one (a locked password hash is locked everywhere), and the one key
it accepts opens only a no-shell session.

**How the Core's detector observes it.** `_COMM=sshd` is true for this process exactly as for the real one, because
it is literally the `sshd` binary; `_UID=0` requires the unit to run as **root** (`sshd` needs root to open the
listening socket and switch to the connecting user), so the systemd unit must use `-p User=root` like the
containment helper does, not a rootless/user-namespaced sandbox — a real design trade-off, not a shortcut: it
mirrors why production trusts `_UID=0` `sshd` records at all (a real deployment's `sshd` also runs as root). The
mitigations above (locked password, key-only, no-shell account, full systemd sandboxing, a lab-only address) are
how that root requirement is kept bounded, not a way to avoid it.

## Option B — deferred; kept only as a possible later addition

(Not pursued now, per your review. Kept here only so it is not re-derived from scratch if it ever comes up again.)
Metasploit's `auxiliary/scanner/ssh/ssh_login` could drive Option A's same `sshd` target instead of `hydra` plus a
manual `ssh` login — not a different target, the same one, attacked with a different client. It would add a much
larger footprint on the **attacker** side only (the `metasploit-framework` package, and by default its own
PostgreSQL database for loot/credential storage) and nothing on the defender side beyond Option A. The Core would
observe it no differently: `sshd` writes the same `Accepted publickey for ... from ... port ...` line regardless
of which client connected. The only practical difference would be operational — one scripted tool run instead of
two manual steps — not anything the detector can tell apart.

## What is being built, and where

**Option A only, when you approve the build.** Nothing is implemented yet. When you do:

- the test `sshd`'s unit, config and host key — new files under the usual lab-script tree (mirroring
  `setup-graduated.sh`'s containment-helper unit), torn down the same way;
- one new system account, locked password, key-only, no-shell;
- one new address, `10.90.90.5`, added to `aegis-att-h` — **not** to the AP interface, **not** inside
  `10.77.30.0/28`, and needing no new route in the namespace (see above).

## Open question for you

Option A is the only thing on the table now. Say when you want it built (this design note, this address, and
this isolation are what would be implemented), or raise anything you'd want changed about the address, the
account, or the sandboxing before it is written as a script.
