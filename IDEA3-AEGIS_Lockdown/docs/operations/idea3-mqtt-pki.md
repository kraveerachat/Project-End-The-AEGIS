# IDEA3 MQTT PKI lifecycle

This document defines the repository profile for the dedicated IDEA3 MQTT PKI. It is repository guidance only and does not authorize or perform a live L6 deployment.

## Fixed profile

- CA subject common name: `AEGIS IDEA3 MQTT CA`
- CA validity target: 1825 days
- CA private key custody: owner-controlled and offline
- Broker hostname: `mqtt.aegis.home.arpa`
- Broker leaf SAN: `DNS:mqtt.aegis.home.arpa`
- Broker leaf EKU: `serverAuth`
- Core verification: CA validation and hostname verification are required
- IP-literal profile: not selected and not claimed closed

## Generation and signing order

1. On the owner-controlled offline CA host, generate the CA private key.
2. Create the dedicated CA certificate using the approved common name and validity target.
3. Generate the broker private key on an owner-controlled secure host.
4. Create a broker CSR for `mqtt.aegis.home.arpa`.
5. Render the repository broker extension profile with `p4-mqtt-pki.py render-broker-ext`.
6. Sign the broker CSR with the dedicated offline CA and the rendered extension profile.
7. Before any deployment, run `p4-mqtt-pki.py validate-broker-cert` against the CA certificate and broker certificate.

Private keys are never committed to the repository. Repository tests use only temporary throwaway PKI under pytest temporary directories.

## Validation requirements

A broker certificate is acceptable only when:

- its chain verifies to the approved dedicated MQTT CA;
- hostname verification succeeds for `mqtt.aegis.home.arpa`;
- the leaf is currently valid;
- the leaf is not a CA certificate;
- `serverAuth` EKU is present;
- the exact DNS SAN `mqtt.aegis.home.arpa` is present.

Wrong SAN, broken chain, expired/not-current leaf, or CA-as-leaf must fail closed.

## Rotation

Track broker certificate expiry and replace the leaf before expiration. Generate a new broker key and CSR, sign the replacement leaf with the owner-controlled CA, validate it with the repository validator, then deploy only inside the separately authorized L6 maintenance stage with rollback evidence ready.

The CA is not rotated merely because a broker leaf is renewed. CA rotation is a separate owner-controlled event and requires coordinated trust-store replacement on Core and device before the old CA is retired.

## Compromise and revocation response

If the broker private key is suspected compromised, stop using that leaf, generate a new broker key/CSR, sign a replacement certificate, validate it, and deploy the replacement under an authorized L6 stage. Record the compromised certificate serial in the owner-maintained revocation record/CRL process.

If the CA private key is suspected compromised, treat the CA as revoked: create a new dedicated MQTT CA offline, issue replacement broker material, update all trust anchors in a coordinated gated rollout, and retire the compromised CA only after replacement trust has been proven.

## Production boundary

This procedure does not write Production PKI paths, restart Mosquitto, modify `/etc/mosquitto`, flash the ESP32, or mark Phase 4 runtime complete. Live deployment remains separately gated by L6 prerequisites and fresh same-day K3 authorization.
