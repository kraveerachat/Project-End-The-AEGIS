# Beelink detection agent and Core remote-alert ingress (lab-tested, NOT deployed)

Nothing in this directory is installed, enabled or applied by the repository. Review, then deploy as an owner action.

## Flow

```
Beelink journal (sshd, root-owned)  ->  tools/aegis_beelink_agent.py  --mTLS MQTT-->  Core broker
      aegis/alert/beelink  {at, kind, attacker_ip, detail, source, nonce} + client certificate + signature
Core: aegis_soc/remote_alert_subscriber.py -> remote_alert.RemoteAlertVerifier (cert chain, identity, EKU, validity,
      signature, topic/source, kind, address, freshness, replay) -> remote_response.RemoteResponse (graduated policy, per source)
```

* Only `ssh_brute_force` and `ssh_login_after_failures` exist. There is no "all clear": a remote host can only add evidence.
* A refused alert (no certificate, wrong CA, wrong identity, bad signature, stale, replayed, unknown kind) is audited as
  `ALERT_REFUSED remote source=<id> code=<CODE>` and never scored.
* CRITICAL for a remote source never cuts by itself. It creates a pending CUT; `RemoteResponse.confirm_cut` (an
  operator-authenticated Core path, NOT yet wired to the Desktop or aegisctl) sends it to that source's relay target.
* Remote decisions never block on the Core host (the attacked machine is another host) and never set the Desktop's
  `cut_recommended_for` (the Desktop's CUT acts on this Core's relay).

## Certificates (disposable commands for review; use your own CA process)

```
# sender CA (keep the key offline)
openssl ecparam -name prime256v1 -genkey -noout -out agent-ca.key
openssl req -x509 -new -key agent-ca.key -sha256 -days 365 -subj "/CN=AEGIS remote alert sender CA" -out agent-ca.crt
# one sender: CN must be aegis-alert-<source>, extendedKeyUsage clientAuth, NOT a CA
openssl ecparam -name prime256v1 -genkey -noout -out aegis-alert-beelink.key
openssl req -new -key aegis-alert-beelink.key -subj "/CN=aegis-alert-beelink" -out aegis-alert-beelink.csr
printf 'basicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth\n' > ext.cnf
openssl x509 -req -in aegis-alert-beelink.csr -CA agent-ca.crt -CAkey agent-ca.key -CAcreateserial -days 90 -sha256 \
        -extfile ext.cnf -out aegis-alert-beelink.crt
chmod 0600 aegis-alert-beelink.key
```

Issue the Core's broker client certificate (`CN=aegis-core`, clientAuth) the same way. Short validity and rotation are the
revocation mechanism: there is no CRL check, so a leaked key is neutralised by pinning (`AEGIS_REMOTE_ALERT_PIN_BEELINK`),
by changing the pin, or by replacing the sender CA.

## Install on the protected host (owner action, not executed)

1. Minimal tree under `/opt/aegis-beelink-agent`: `tools/aegis_beelink_agent.py` and `aegis_soc/{__init__,alert_sink,ip_containment,
   production_detector,graduated_detector,remote_alert}.py`, plus a venv from `requirements-remote-alert.txt`.
2. Account `aegis-agent` (no login shell, group `systemd-journal` only), config at `/etc/aegis-beelink-agent/agent.env`
   (`agent.env.example`), certificates under `/etc/aegis-beelink-agent/pki` (key 0600 `aegis-agent`).
3. `aegis-beelink-agent.service` to `/etc/systemd/system/`, then `daemon-reload`, `enable --now`. Roll back with
   `disable --now`, removal of the unit file and `daemon-reload`; the agent changes nothing else on the host.

## Core side (lab first)

Enable only for a reviewed stage with `core-remote-alert.env.example`, the broker listener from
`mosquitto-remote-alert.conf.example` and `.acl.example`. Needs `AEGIS_GRADUATED_RESPONSE=YES`, a trusted Core clock, and
`cryptography` (the ingress refuses to start without it).

## Known limits (be explicit before deploying)

* The Core has ONE relay device. A real second relay for the Beelink needs its own device identity, keys, topics and ACK store in
  the protocol stack; that is not built here. Until then a Beelink CUT target is `NONE` (refuses), `DRYRUN` (lab) or, in the lab
  profile only, an explicit `LAB_RELAY` mapping.
* The operator confirmation is a Core-internal API (`confirm_cut`), covered by tests, not yet reachable from the Desktop/aegisctl.
* The Core's remote components (`remote_alert`, `remote_alert_subscriber`, `remote_response`) are loaded BY NAME by the supervisor and
  are deliberately not static imports: the governed release builder derives the Core closure and the pinned third-party set from
  static imports, and `cryptography` is not in that reviewed set. A governed release that does not ship them has no remote
  ingress (the Core logs `REMOTE_ALERTS_COMPONENT_MISSING` and carries on). Shipping them needs an owner-approved release change:
  add the three modules to the closure, map and pin `cryptography` (builder `DIST_FOR_IMPORT` and `requirements.txt`).
* No CRL/OCSP. Direct issuance only (leaf signed by the configured CA; no intermediates).
* Core and agent clocks must be within 120 s (NTP). An untrusted Core clock refuses every remote alert.
