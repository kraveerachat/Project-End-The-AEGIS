# AEGIS IDEA3 — Production Constraints / Do-Not-Break Rules

These constraints override convenience.

## Network infrastructure
Do NOT automatically:

- reset or reconfigure MikroTik
- change TP-Link VLAN/PVID configuration
- change production routing
- change UFW production rules
- change Twingate configuration
- provision production MQTT on a host without an explicit deployment instruction
- connect/disconnect physical cables

Software work must not silently become network provisioning.

## Physical relay
Do NOT trigger a real relay CUT or RESTORE during unit/integration development unless the user explicitly requests a physical production test in the current conversation.

Default to dry-run/mocked hardware.

Never auto-RESTORE on software startup, restart, crash recovery, or shutdown.

## Security controls
Do NOT disable, bypass, weaken, or duplicate around:

- HMAC authentication
- nonce anti-replay
- timestamp validation
- ACK tracking
- heartbeat / Dead Man's Switch
- secure boot/fail-safe behavior
- explicit recovery policy
- audit logging/hash-chain integrity
- Admin authentication for sensitive human commands

## Secrets
Never commit or expose:

- HMAC secret values
- Admin PIN values
- Telegram/API tokens
- passwords
- SSH private keys
- production credentials

Do not place secrets into session handoffs or test fixtures.

## Penetration / attack tooling
Do not automatically launch Nmap attack-mode scans, Hydra, Metasploit, flood tools, exploitation frameworks, or external penetration tests as part of startup, autonomous runtime, or ordinary CI.

Security tests must be scoped, authorized, and separate from production startup.

## IDEA1 / IDEA2 isolation
Do not repurpose existing IDEA1/IDEA2 production ports or networks from a coding task.

Historical intended port roles at the documented checkpoint:

```text
TP-Link P1 = trunk
P2 = VLAN10 / Beelink
P3 = VLAN20 / IDEA2
P4 = VLAN40 / IDEA3
P5 = VLAN30 / Management
```

Treat this as reference only; verify before any real infrastructure action.

## Human voice commands
Voice commands must route through the same controller/security model.

Do not allow a microphone transcript to publish privileged MQTT commands directly.

Do not ask the user to speak an Admin PIN aloud as the default authentication mechanism.

## Source of truth
If an old report says PASS but current tests fail, current tests win.

If documentation and implementation differ, investigate and update documentation rather than pretending they match.
