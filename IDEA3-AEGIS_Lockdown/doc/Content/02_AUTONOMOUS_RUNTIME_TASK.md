# AEGIS IDEA3 — Autonomous Runtime Task

## Goal
Build an autonomous runtime/supervisor for IDEA3 so a user can start the software stack with one command and does not need to keep multiple terminals open or manually babysit processes.

Target UX:

```bash
./aegisctl start --profile production
./aegisctl status
./aegisctl logs
./aegisctl stop
```

Alternative Python entry point is acceptable if the repository architecture makes it cleaner, but `aegisctl` should be the user-facing wrapper.

## 1. Inspect before changing
Do not guess filenames.

Inspect the full repository first, especially actual equivalents of:

- main/server entry point
- SOC GUI
- config
- security/HMAC
- MQTT client/manager
- database/audit
- detector
- ESP32 firmware
- tests
- README / architecture docs

Search for actual implementations of:

- `CUT_UPLINK`
- `RESTORE_UPLINK`
- `ARM`
- `DISARM`
- heartbeat
- ACK
- HMAC
- nonce
- attacker IP
- detector events
- ESP32 state

## 2. Preserve security flow
Do not bypass existing security mechanisms.

Every real ESP32 command must continue through the canonical security path using the repository's existing:

- HMAC
- nonce
- timestamp
- ACK behavior
- audit logging

Never hardcode secrets, tokens, PINs, passwords, private keys, or production credentials.

## 3. Separate business control from GUI
If command logic is tightly coupled to Tkinter/GUI, refactor toward a single reusable controller, for example:

```text
aegis_soc/controller.py
AegisCommandController
```

Desired logical shape:

```text
GUI ---------\
Voice --------> CommandController -> security -> MQTT -> ESP32
Detector -----/
Supervisor ---/
CLI ----------/
```

Avoid multiple independent implementations of CUT/RESTORE.

## 4. Autonomous supervisor
Create a supervisor module appropriate for the real repository, for example:

```text
aegis_soc/supervisor.py
aegis_autonomous.py
```

Suggested states:

```text
INIT
PREFLIGHT
WAIT_BROKER
WAIT_DEVICE
RUNNING
DEGRADED
LOCKDOWN
SHUTDOWN
```

Do not exit just because MQTT or a component is temporarily unavailable. Use bounded retry/backoff.

Suggested reconnect delays: 1s, 2s, 5s, 10s, then cap around 30s.

## 5. Preflight
At startup verify relevant items that actually exist in the repo:

- supported Python version
- dependencies
- config validity
- broker address/port
- required secret presence without printing values
- database/log writability
- detector component availability
- MQTT reachability or recoverable broker-wait state
- microphone only if voice is enabled
- GUI/display only if GUI mode is enabled

Production profile must reject known demo/default secrets or PIN defaults if the current code defines them.

## 6. MQTT/device monitoring
Reuse existing MQTT infrastructure.

Monitor actual project topics for:

- connection state
- ACK
- device status
- attacker IP
- heartbeat / last-seen

Respect existing config constants and timeouts.

MQTT disconnection should transition to DEGRADED and reconnect rather than killing the supervisor.

## 7. Fail-safe ESP32 handling
Never auto-send RESTORE simply because the PC process restarted.

If device state is unknown after supervisor restart, treat it as UNKNOWN/DEGRADED until confirmed.

Physical safety/security state must not be reset for convenience.

## 8. Detector integration
Find the real detector implementation.

Preserve existing detection thresholds unless there is a verified bug and tests justify a change.

Machine-confirmed containment may run autonomously when explicitly enabled by config, but must use the same authenticated command/audit path.

Provide a config switch equivalent to:

```text
AEGIS_AUTO_CONTAIN=0/1
```

Default development behavior should be conservative.

## 9. Voice control
Voice is optional and independently supervised.

Use a config switch equivalent to:

```text
AEGIS_VOICE_ENABLE=1
```

Voice must call the shared controller, not publish raw privileged MQTT commands.

Do not speak or log Admin PINs.

Voice failure must not crash SOC/detector/supervisor.

## 10. Process supervision
Use Python-native process management (`asyncio`, `subprocess.Popen`, or architecture-appropriate equivalent).

Avoid `shell=True` unless absolutely necessary.

Supervise actual independently-running components such as detector, optional GUI, and voice if the repository architecture requires separate processes.

Implement crash-loop protection, e.g.:

```text
AEGIS_MAX_RESTARTS=5
AEGIS_RESTART_WINDOW_SEC=300
```

A component can become FAILED while the supervisor stays alive and reports the failure.

## 11. Runtime profiles/modes
Support useful combinations such as:

```text
--profile development
--profile lab
--profile production
--headless
--gui
--voice
--no-voice
--dry-run
```

Do not invent flags that are meaningless for the actual repo; document the final interface.

## 12. aegisctl
Provide a user-facing CLI with at least:

```text
aegisctl start
aegisctl stop
aegisctl restart
aegisctl status
aegisctl doctor
aegisctl logs
aegisctl test
```

`status` should clearly distinguish healthy, degraded, unknown, failed, armed, lockdown, etc. Never fake PASS.

## 13. Logging
Add structured runtime logs with rotation.

Possible files:

```text
logs/aegis-supervisor.log
logs/aegis-events.jsonl
```

Events should include timestamp, component, level, event, and safe detail.

Never log secrets.

## 14. Single instance
Prevent accidental duplicate supervisors using a lock/PID strategy suitable for the platform.

## 15. Graceful shutdown
Handle SIGINT/SIGTERM.

Stop child components, disconnect MQTT, flush logs, and close database cleanly.

Do NOT send RESTORE_UPLINK automatically during shutdown.

## 16. Autostart
Provide a systemd unit or systemd-user unit where appropriate.

Prefer separating headless backend from GUI if GUI/display lifetime makes a single service fragile.

Use restart-on-failure with crash-loop protection.

## 17. Configuration
Use environment/config handling consistent with the repository.

Provide/update `.env.example` without real secrets.

Potential variables:

```text
AEGIS_PROFILE=production
AEGIS_BROKER_IP=192.168.10.13
AEGIS_BROKER_PORT=1883
AEGIS_AUTO_CONTAIN=1
AEGIS_START_GUI=1
AEGIS_VOICE_ENABLE=1
AEGIS_HEALTH_INTERVAL=5
AEGIS_MAX_RESTARTS=5
AEGIS_HMAC_SECRET=
AEGIS_ADMIN_PIN=
```

Only keep variables that actually fit the implementation.

## 18. Dry-run
Provide a dry-run path where the runtime, detector simulation, state machine, health checks, and logging can execute without changing the physical relay.

A dangerous command in dry-run should log something like:

```text
WOULD_SEND CUT_UPLINK
```

rather than triggering hardware.

## 19. Tests
Add tests appropriate to the final design, covering as many of these as relevant:

- supervisor state transitions
- production config rejection for unsafe defaults
- process restart/backoff
- MQTT reconnect
- device offline/degraded behavior
- ACK timeout
- controller CUT/RESTORE routing
- voice routing
- dry-run protection
- graceful shutdown
- duplicate-instance prevention

Use mocks/fakes. Unit tests must never operate the real relay.

Run existing tests too; do not weaken tests merely to get green output.

## 20. Acceptance criteria
The implementation is considered successful when:

- one user command starts the required IDEA3 software stack,
- users do not manually keep several terminals alive,
- component failures are visible and recoverable,
- MQTT disconnects are handled,
- ESP32 unknown/offline state becomes DEGRADED rather than falsely NORMAL,
- runtime can continue under systemd/daemon-style execution where appropriate,
- `status`, `logs`, and `stop` work clearly,
- existing security controls remain intact,
- dry-run integration can be tested without hardware actuation.

## 21. Work autonomously, but not on production infrastructure
Workflow:

1. inspect repo
2. establish Git state
3. make an implementation plan from real code
4. use a feature branch
5. implement incrementally
6. format/lint according to project conventions
7. run tests repeatedly
8. dry-run integration test
9. fix root causes
10. document final usage and rollback
11. update `04_SESSION_HANDOFF.md`

Do not deploy or alter network hardware as part of this software task.
