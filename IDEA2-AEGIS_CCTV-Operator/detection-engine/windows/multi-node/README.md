# AEGIS IDEA2 — Windows Target-Node Provisioning Runbook

This runbook prepares an additional Windows Detection Node so the existing
accounts keep the same logical aliases while the physical camera remains
machine-local:

- `operator -> CAM-01`
- `operator2 -> CAM-02`

The aliases are reusable per Node. Each machine must instead have its own Node
identity, server-generated physical-camera identity, Agent identity, SSH
identity, reverse-forward allocation, and selected local camera source.

## Safety boundary

This document does not authorize Production mutation. The target machine may
perform local installation and generate its own private identities only after
its read-only preflight is reviewed. Any server-side Node registration, alias
reconciliation, ingest-auth change, SSH authorization, reverse-listener
allocation, or Production deployment is a separate owner-approved action.

Twingate configuration changes are out of scope.

Never copy from another machine:

- Agent DPAPI identity;
- SSH private key;
- Node ID;
- physical-camera ID;
- private `.env`;
- `known_hosts` without independently verifying the server fingerprint;
- reverse-forward port allocation.

Do not hardcode Machine A/C names or physical-camera IDs in reusable source.

## Phase P0 — target read-only preflight

Run on the target Windows machine from the reviewed source tree:

```powershell
& .\windows\preflight_target_node.ps1
```

Required before continuing:

- supported 64-bit Windows;
- OpenSSH client present;
- camera device metadata discovered or an explicit reviewed external camera plan;
- ports `8077`, `8078`, and `18002` do not have an unexplained existing owner;
- any existing AEGIS Engine, Agent, tunnel task, or HKCU Run owner is reviewed;
- no Production contact, camera open, config write, or private-key read occurred.

A fresh target normally has no AEGIS runtime and no listeners on those ports.
An already provisioned target must be handled as repair, not as a new Node.

**STOP** if the preflight is not reviewed.

## Phase P1 — prepare target-local, non-repository configuration

Create target-local working directory, for example:

```text
C:\AEGIS-Local\
```

`identity-agent.env.example` may be copied to a target-local file and filled
only with deployment-reviewed values.

`engine.env.example` is a target-specific override checklist, **not** a
standalone installable Engine configuration. At provisioning time start from
the current canonical `detection-engine/.env.example`, copy that file outside
Git, and apply only the reviewed target-specific overrides from this directory.

Do not commit completed `.env` files.

The Engine configuration must use the current approved source/deployment
defaults at installation time. This multi-node runbook intentionally does not
freeze recording/NAS values from another PR or another machine.

`AEGIS_CAMERA_ID` remains one static event-time logical alias per Engine process
for detection, clip, and alert payloads. It is not the physical-camera identity
and it is not dynamically selected from `operator -> CAM-01` or
`operator2 -> CAM-02`. Live account alias authority is server-resolved
separately. Do not infer dual-account event attribution from Live routing.
Actual deployment remains blocked until event attribution for both aliases is
explicitly reviewed and accepted, or the Engine/Monitor source is changed.

Camera source is machine-local. Discover it on the target itself:

```powershell
py.exe -3.14 .\setup_camera.py --list
```

That command opens candidate camera devices to verify frames but does not write
configuration. Run it only after the read-only preflight gate has been accepted.

Select/write the source only during the separately approved provisioning step.

## Phase P2 — target-local unique identities

On the target machine only:

1. Generate a unique tunnel SSH identity. Do not copy another node's key.
2. Independently verify the server SSH host-key fingerprint before creating the
   target-local `known_hosts`.
3. Prepare the Agent configuration with a unique approved Node ID, key version,
   interactive Engine-user SID, allowed browser origin, Monitor base
   URL/audience, and stable physical stream URL.
4. Install the dedicated Identity Agent using the repository installer.
5. Run its DPAPI CurrentUser preflight under the service identity.
6. Provision the Agent identity on that target. Export/publicize only the public
   key/fingerprint; the private Agent identity stays DPAPI-protected on target.

The target's Engine and Agent private identities are not evidence that the
server has registered the Node.

**STOP BEFORE SERVER REGISTRATION.**

## Phase P3 — separately authorized server-side registration

This phase is a Production/registry mutation and is never implied by the local
runbook.

After owner approval, the server administrator must:

1. verify the Node does not already exist unexpectedly;
2. register exactly one Node using the target Agent public key;
3. let the server generate exactly one physical-camera identity;
4. reconcile account aliases for that exact Node:

```text
operator  -> CAM-01
operator2 -> CAM-02
```

5. verify account switching changes only the logical alias and does not create
   or move physical-camera authority;
6. set the exact reviewed ingest-auth mode only after Agent proof is valid;
7. allocate/authorize one unique reverse-forward port for that target.

Do not register a second physical camera for `operator2`.

## Phase P4 — Engine/tunnel installation

Use the existing `windows/install_autostart.ps1` lifecycle with target-specific:

- external Engine configuration;
- verified target SSH identity;
- verified `known_hosts`;
- tunnel `user@host`;
- Monitor target host;
- explicit non-loopback server stream bind address;
- server-approved unique reverse port;
- reviewed Python 3.12 x64 interpreter where required by the installed Agent.

The installation must preserve the architecture:

```text
Windows boot
  -> SYSTEM: AEGIS Detection Tunnel

User login
  -> HKCU Run: AEGIS Detection Engine

Windows service
  -> NT SERVICE\AEGISIdentityAgent
```

The old interactive Engine Scheduled Task, if present, remains disabled.

## Phase P5 — live target acceptance

Before any browser opens Live, verify:

```text
ENGINE_STARTUP_OWNER=HKCU_RUN
IDENTITY_AGENT=RUNNING
TUNNEL=RUNNING
ENGINE_IDLE=YES
CAMERA_DEMANDED=NO
```

Then test both existing accounts independently on the target machine.

Expected authority:

```text
operator  + target Node + CAM-01 -> target physical camera
operator2 + target Node + CAM-02 -> target physical camera
```

For each account verify:

- Browser Association resolves the target Node;
- Live opens only the target machine's camera;
- camera demand goes active only for the authorized viewer;
- the other machine's physical camera is never selected;
- `Live -> Archive -> Diagnostics -> Settings -> Live` preserves the intended
  Operator viewer lifecycle;
- logout/final viewer release returns the target Engine to idle;
- a browser/session without the required association cannot obtain target
  physical-camera authority;
- detection/clip/alert logical attribution under both accounts matches the
  explicitly approved event-alias policy; a static Engine `AEGIS_CAMERA_ID`
  must not silently be treated as evidence of account-specific alias symmetry.

Do not claim the target accepted until both accounts pass on real hardware,
including the reviewed event-attribution boundary.

## Final multi-node evidence

A target is complete only when evidence supports all of:

```text
TARGET_PREFLIGHT=PASS
UNIQUE_NODE_ID=PASS
UNIQUE_AGENT_IDENTITY=PASS
UNIQUE_SSH_IDENTITY=PASS
ONE_PHYSICAL_CAMERA_PER_NODE=PASS
OPERATOR_CAM01_TARGET_CAMERA=PASS
OPERATOR2_CAM02_TARGET_CAMERA=PASS
CROSS_NODE_CAMERA_ISOLATION=PASS
ACCOUNT_ALIAS_EVENT_ATTRIBUTION=PASS
NAVIGATION_CONTINUITY=PASS
FINAL_VIEWER_RELEASE=PASS
REBOOT_LIFECYCLE=PASS
```
