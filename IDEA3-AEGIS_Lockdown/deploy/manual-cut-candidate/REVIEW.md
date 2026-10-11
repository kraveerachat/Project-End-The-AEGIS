# IDEA3 Manual CUT — Deployment Candidate

STATUS: OFFLINE / NOT AUTHORIZED / NOT DEPLOYED

Existing implementation:
- aegis_soc/local_cut.py
- aegis_soc/cut_client.py
- tools/live_purple_cut_desktop.py

Source-only deployment contract:
- `aegis-idea3-cut.tmpfiles.example` pre-provisions
  `/run/aegis-idea3-cut` as `aegis-idea3:aegis-idea3-cut` mode `0750`.
  The directory is Core-owned and never group/world writable.
- The Core creates `cut.sock` as `aegis-idea3:<dedicated transport gid>` mode
  `0660`. The transport group grants reachability only. The server rejects every
  uid except the one configured non-root operator, before reading request bytes;
  the Desktop rejects a server that is not the Core uid.
- `aegis-idea3-core-cut.dropin.example` loads the required
  `/etc/aegis-idea3/manual-cut.env`, adds only the dedicated transport group, and
  adds only the dedicated runtime directory to the Core write allow-list.
- `manual-cut.env.example` contains paths and numeric identities, never the CUT
  secret. Keep `AEGIS_LOCAL_CUT_ENABLED` and `AEGIS_DESKTOP_CUT_ENABLED` empty
  until every review and authorization below is complete. The Desktop launcher
  must receive its separate opt-in and the same absolute socket path explicitly.
- Provision a fresh Core-owned mode-`0600` credential with
  `aegis_soc.local_cut.write_cut_credential`. The Core verifies it for every CUT
  using the CUT-specific domain; the file, hash, and human secret must not be the
  D4 RESTORE credential, a copy of it, or reused from it.
- An accepted CUT still passes through the existing Supervisor command lock,
  pending-command checks, strict durable pre-dispatch audit, Protocol v1 MQTT
  publisher, and correlated ACK/STATUS evidence. Any missing/invalid identity,
  path, permission, credential, audit write, protocol state, or broker state
  fails closed. ACK/STATUS is protocol evidence and never physical relay proof.
- This contract carries CUT only. The Desktop cannot send RESTORE; Recovery/D4
  and any approved operational break-glass authority remain separate.

Before any Production activation:
1. Independent security and integration review.
2. Written Human Owner authorization.
3. Resolve the exact non-root operator UID and dedicated transport GID; verify
   the operator membership and that no unrelated account is a group member.
4. Provision the fresh, distinct, private Core-verified CUT credential described
   above; verify Core ownership and mode `0600` without exposing its value.
5. Verify the tmpfiles directory, socket owner/group/mode, Core service hardening,
   environment-file ownership, and the exact Desktop launch environment.
6. Approve the exact-main release, controlled deployment, required Core restart,
   rollback, and post-restart read-only checks. None is authorized by these files.
7. Confirm physical tester isolation and the separately authorized recovery
   method before any live CUT.

Never:
- Enable legacy direct MQTT command publishing.
- Reuse D4 RESTORE credentials.
- Treat transport group membership, GUI login, typed confirmation, or GUI PIN as
  CUT authentication.
- Weaken Protected CIDRs.
- Modify Incident #2 or immutable Recovery history.
- Treat a CUT ACK as physical relay proof.

RESTORE remains governed separately by R3 and D4.
These examples do not grant RESTORE authority.
