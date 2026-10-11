# AEGIS IDEA3 — Manual CUT Production Review

Status: PENDING INDEPENDENT REVIEW

Scope: Manual CUT only.
RESTORE, Auto-CUT, Incident #2, and existing Recovery
authorization are outside the deployment authority of this candidate.

## Source and Tests

- [ ] Exact GitHub main commit verified
- [ ] Candidate source and deployment templates reviewed
- [ ] Offline regression tests independently reproduced
- [ ] No unrelated changes included

## Security Review

- [ ] Non-root operator UID verified
- [ ] Dedicated CUT transport GID verified
- [ ] No unrelated transport group members
- [ ] SO_PEERCRED identity checks verified
- [ ] Core server UID verification verified
- [ ] Fresh CUT-only credential approved
- [ ] CUT credential distinct from D4 RESTORE credential
- [ ] Credential ownership and permissions verified
- [ ] Strict audit and refusal behavior verified
- [ ] Command locking and no-retry behavior verified
- [ ] ACK/STATUS not treated as physical relay proof
- [ ] Incident and Protected CIDR safeguards preserved

## Deployment Authorization

- [ ] Independent security/integration review approved
- [ ] Written Human Owner authorization recorded
- [ ] Exact release and rollback plan approved
- [ ] Core service hardening reviewed
- [ ] CUT Socket and tmpfiles configuration approved
- [ ] Controlled restart and recovery plan approved

## Physical Acceptance

- [ ] Isolated RJ45 Cable Tester confirmed
- [ ] Separately authorized physical test window
- [ ] Recovery method confirmed before CUT
- [ ] Physical relay observation recorded
- [ ] Production status and audit evidence reviewed

## Explicit Exclusions

- No legacy direct MQTT publishing
- No RESTORE using CUT authority
- No bypass of LOCKDOWN or existing Incident protections
- No unapproved Production activation
- No claim of physical success from ACK alone

Final Reviewer Decision: PENDING
Human Owner Authorization: PENDING
Production Activation: NOT AUTHORIZED
