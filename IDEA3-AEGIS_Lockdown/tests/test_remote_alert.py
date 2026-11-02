"""Remote alert envelope: a valid signed alert is accepted; every forged, unauthenticated or replayed one is refused."""

from __future__ import annotations

import base64
import datetime
import json

import pytest
from remote_alert_support import NOW, issue, make_ca, serialization

from aegis_soc import remote_alert as ra

IP = "203.0.113.50"
SOURCE = "beelink"
T0 = NOW.timestamp()


@pytest.fixture(scope="module")
def ca():
    return make_ca()


@pytest.fixture(scope="module")
def other_ca():
    return make_ca("Someone else's CA")


@pytest.fixture(scope="module")
def agent(ca):
    return issue(ca, ra.identity_for(SOURCE))


def verifier(ca, *, sources=None, clock=lambda: T0, trusted=lambda: True):
    return ra.RemoteAlertVerifier(
        ca_pem_chunks=[ca.pem], sources=sources or {SOURCE: ra.SourcePolicy(ra.identity_for(SOURCE))}, clock=clock,
        clock_trusted=trusted,
    )


def envelope(identity, *, kind=ra.KIND_SSH_BRUTE_FORCE, ip=IP, source=SOURCE, now=T0, nonce=None, detail="seen in sshd journal"):
    return ra.build_envelope(source=source, kind=kind, attacker_ip=ip, detail=detail, cert_der=identity.der,
                             private_key=identity.key, now=now, nonce=nonce)


def raw_envelope(identity, payload, *, cert_der=None, signer=None):
    """An envelope with an arbitrary payload, signed as the real agent would (used to forge kinds build_envelope refuses)."""
    signature = ra._sign((signer or identity).key, ra.canonical(payload))
    return json.dumps({"v": 1, "payload": payload, "cert": base64.b64encode(cert_der or identity.der).decode(),
                       "sig": base64.b64encode(signature).decode()}).encode()


def payload(**changes):
    base = {"at": T0, "kind": ra.KIND_SSH_BRUTE_FORCE, "attacker_ip": IP, "detail": "x", "source": SOURCE, "nonce": "ab" * 16}
    base.update(changes)
    return base


def topic(source=SOURCE):
    return ra.topic_for(source)


def refused(v, raw, code, tp=None):
    with pytest.raises(ra.Refusal) as info:
        v.verify(tp or topic(), raw)
    assert info.value.code == code


# --------------------------------------------------------------------------------------------- accepted


@pytest.mark.parametrize("kind", ["ec", "ed25519", "rsa"])
def test_a_valid_signed_alert_is_accepted_for_every_supported_key_type(ca, kind):
    identity = issue(ca, ra.identity_for(SOURCE), kind=kind)
    alert = verifier(ca).verify(topic(), envelope(identity))
    assert (alert.source, alert.kind, alert.attacker_ip) == (SOURCE, ra.KIND_SSH_BRUTE_FORCE, IP)
    assert len(alert.cert_sha256) == 64


def test_both_reported_kinds_are_accepted(ca, agent):
    v = verifier(ca)
    assert v.verify(topic(), envelope(agent, kind=ra.KIND_SSH_BRUTE_FORCE)).kind == ra.KIND_SSH_BRUTE_FORCE
    assert v.verify(topic(), envelope(agent, kind=ra.KIND_SSH_LOGIN_AFTER_FAILURES)).kind == ra.KIND_SSH_LOGIN_AFTER_FAILURES


def test_a_pinned_certificate_is_accepted_and_any_other_is_refused(ca, agent):
    import hashlib
    pin = hashlib.sha256(agent.der).hexdigest()
    pinned = {SOURCE: ra.SourcePolicy(ra.identity_for(SOURCE), frozenset({pin}))}
    assert verifier(ca, sources=pinned).verify(topic(), envelope(agent)).source == SOURCE
    sibling = issue(ca, ra.identity_for(SOURCE))   # same CA, same CN, different key: not the pinned leaf
    refused(verifier(ca, sources=pinned), envelope(sibling), ra.CERT_NOT_PINNED)


# --------------------------------------------------------------------------------------------- no / invalid certificate


def test_an_alert_without_a_certificate_is_refused(ca, agent):
    body = json.loads(envelope(agent))
    del body["cert"]
    refused(verifier(ca), json.dumps(body).encode(), ra.MALFORMED)
    body["cert"] = ""
    refused(verifier(ca), json.dumps(body).encode(), ra.CERT_MISSING)


def test_an_unsigned_alert_is_refused(ca, agent):
    body = json.loads(envelope(agent))
    body["sig"] = ""
    refused(verifier(ca), json.dumps(body).encode(), ra.SIGNATURE_MISSING)
    del body["sig"]
    refused(verifier(ca), json.dumps(body).encode(), ra.MALFORMED)


def test_a_certificate_from_another_ca_is_refused(ca, other_ca):
    stranger = issue(other_ca, ra.identity_for(SOURCE))
    refused(verifier(ca), envelope(stranger), ra.CERT_UNTRUSTED)


def test_a_self_signed_certificate_with_the_right_name_is_refused(ca):
    forged_ca = make_ca(ra.identity_for(SOURCE))
    refused(verifier(ca), envelope(forged_ca), ra.CERT_UNTRUSTED)


def test_an_expired_or_not_yet_valid_certificate_is_refused(ca):
    old = issue(ca, ra.identity_for(SOURCE), not_before=NOW - datetime.timedelta(days=60), not_after=NOW - datetime.timedelta(days=30))
    refused(verifier(ca), envelope(old), ra.CERT_EXPIRED)
    future = issue(ca, ra.identity_for(SOURCE), not_before=NOW + datetime.timedelta(days=5), not_after=NOW + datetime.timedelta(days=30))
    refused(verifier(ca), envelope(future), ra.CERT_NOT_YET_VALID)


def test_a_certificate_that_is_not_for_client_authentication_is_refused(ca):
    server_only = issue(ca, ra.identity_for(SOURCE), client_auth=False, server_auth=True)
    refused(verifier(ca), envelope(server_only), ra.CERT_NOT_CLIENT_AUTH)
    no_usage = issue(ca, ra.identity_for(SOURCE), client_auth=False)
    refused(verifier(ca), envelope(no_usage), ra.CERT_NOT_CLIENT_AUTH)


def test_a_certificate_authority_certificate_cannot_act_as_the_sender(ca):
    as_ca = issue(ca, ra.identity_for(SOURCE), is_ca=True)
    refused(verifier(ca), envelope(as_ca), ra.CERT_IS_CA)


def test_a_valid_certificate_of_another_identity_cannot_speak_for_the_source(ca):
    evil = issue(ca, ra.identity_for("evil"))   # a real, CA-issued client certificate, but not beelink's
    refused(verifier(ca), envelope(evil, source=SOURCE), ra.CERT_IDENTITY_MISMATCH)


# --------------------------------------------------------------------------------------------- forged content


def test_a_payload_changed_after_signing_is_refused(ca, agent):
    body = json.loads(envelope(agent))
    body["payload"]["attacker_ip"] = "203.0.113.99"
    refused(verifier(ca), json.dumps(body).encode(), ra.BAD_SIGNATURE)


def test_a_replayed_certificate_signed_by_someone_without_the_key_is_refused(ca, agent):
    """The certificate is public. An attacker who copies it still cannot sign: the signature must verify under its key."""
    attacker_key = issue(ca, "attacker")
    forged = raw_envelope(agent, payload(), signer=attacker_key)
    refused(verifier(ca), forged, ra.BAD_SIGNATURE)


def test_the_signature_algorithm_comes_from_the_certificate_not_the_message(ca, agent):
    body = json.loads(envelope(agent))
    body["alg"] = "none"
    refused(verifier(ca), json.dumps(body).encode(), ra.MALFORMED)  # no field of the message can steer the check


def test_a_message_for_another_topic_than_its_claimed_source_is_refused(ca, agent):
    both = {SOURCE: ra.SourcePolicy(ra.identity_for(SOURCE)), "other": ra.SourcePolicy(ra.identity_for("other"))}
    refused(verifier(ca, sources=both), envelope(agent), ra.TOPIC_SOURCE_MISMATCH, tp=topic("other"))


def test_a_source_that_is_not_allowed_or_a_bad_topic_is_refused(ca, agent):
    refused(verifier(ca), envelope(agent), ra.SOURCE_NOT_ALLOWED, tp=topic("stranger"))
    refused(verifier(ca), envelope(agent), ra.TOPIC_INVALID, tp="aegis/alert/")
    refused(verifier(ca), envelope(agent), ra.TOPIC_INVALID, tp="aegis/alert/beelink/../x")
    refused(verifier(ca), envelope(agent), ra.TOPIC_INVALID, tp="other/beelink")


@pytest.mark.parametrize("kind", ["all_clear", "resolved", "clear", "ok", "port_scan", "syn_flood", "generic", ""])
def test_there_is_no_all_clear_and_no_other_kind_a_valid_sender_can_claim(ca, agent, kind):
    """Even with a perfect signature from the real agent, only the two observation kinds exist."""
    refused(verifier(ca), raw_envelope(agent, payload(kind=kind)), ra.BAD_KIND)


@pytest.mark.parametrize("bad", ["not-an-ip", "127.0.0.1", "0.0.0.0", "255.255.255.255", "203.0.113.0/24", 5, None])
def test_an_address_the_core_would_never_block_is_refused(ca, agent, bad):
    refused(verifier(ca), raw_envelope(agent, payload(attacker_ip=bad)), ra.BAD_ADDRESS)


def test_a_detail_that_is_not_short_printable_ascii_is_refused(ca, agent):
    refused(verifier(ca), raw_envelope(agent, payload(detail="x" * 201)), ra.BAD_DETAIL)
    refused(verifier(ca), raw_envelope(agent, payload(detail="line\nbreak")), ra.BAD_DETAIL)
    refused(verifier(ca), raw_envelope(agent, payload(detail="\u0e44\u0e17\u0e22")), ra.BAD_DETAIL)


def test_extra_missing_or_mistyped_fields_are_refused(ca, agent):
    for changes in ({"extra": 1}, {"at": "now"}, {"nonce": "short"}, {"at": True}):
        body = payload(**changes)
        refused(verifier(ca), raw_envelope(agent, body), ra.MALFORMED)
    # NaN cannot even be signed canonically, but a sender can still put it on the wire: it must be refused, not crash.
    wire = json.loads(envelope(agent))
    text = json.dumps(wire).replace(json.dumps(wire["payload"]["at"]), "NaN", 1).encode()
    refused(verifier(ca), text, ra.MALFORMED)
    missing = payload()
    del missing["nonce"]
    refused(verifier(ca), raw_envelope(agent, missing), ra.MALFORMED)


@pytest.mark.parametrize("raw", [b"", b"not json", b"[]", b'{"v":1}', b"\xff\xfe", None, "text"])
def test_garbage_is_refused_as_malformed(ca, raw):
    refused(verifier(ca), raw, ra.MALFORMED)


def test_an_oversize_message_is_refused_before_any_parsing(ca):
    refused(verifier(ca), b"{" + b" " * ra.MAX_ENVELOPE_BYTES + b"}", ra.OVERSIZE)


# --------------------------------------------------------------------------------------------- freshness and replay


def test_a_stale_or_future_alert_is_refused(ca, agent):
    refused(verifier(ca), envelope(agent, now=T0 - ra.MAX_SKEW_SEC - 5), ra.STALE)
    refused(verifier(ca), envelope(agent, now=T0 + ra.MAX_SKEW_SEC + 5), ra.FROM_THE_FUTURE)


def test_the_same_signed_alert_cannot_be_accepted_twice(ca, agent):
    v = verifier(ca)
    raw = envelope(agent)
    v.verify(topic(), raw)
    refused(v, raw, ra.REPLAY)


def test_a_replayed_alert_is_refused_even_when_a_fresh_one_came_between(ca, agent):
    v = verifier(ca)
    first = envelope(agent)
    v.verify(topic(), first)
    v.verify(topic(), envelope(agent, kind=ra.KIND_SSH_LOGIN_AFTER_FAILURES))
    refused(v, first, ra.REPLAY)


def test_a_refused_alert_does_not_consume_the_replay_slot(ca, agent):
    v = verifier(ca)
    body = json.loads(envelope(agent))
    good_sig = body["sig"]
    body["payload"]["attacker_ip"] = "203.0.113.99"
    refused(v, json.dumps(body).encode(), ra.BAD_SIGNATURE)   # forged copy with the genuine signature
    body["payload"]["attacker_ip"] = IP
    assert body["sig"] == good_sig
    assert v.verify(topic(), json.dumps(body).encode()).attacker_ip == IP   # the genuine one still goes through


def test_an_untrusted_core_clock_refuses_everything(ca, agent):
    refused(verifier(ca, trusted=lambda: False), envelope(agent), ra.CLOCK_UNTRUSTED)


def test_the_replay_cache_is_bounded(ca, agent):
    v = verifier(ca)
    for index in range(ra.REPLAY_MAX_ENTRIES + 50):
        v._remember(f"sig-{index}")
    assert len(v._seen) <= ra.REPLAY_MAX_ENTRIES


# --------------------------------------------------------------------------------------------- misc


def test_an_unsupported_signing_key_is_not_signable_or_verifiable(ca):
    from cryptography.hazmat.primitives.asymmetric import ec
    weak = ec.generate_private_key(ec.SECP256K1())
    with pytest.raises(ra.Refusal) as info:
        ra._sign(weak, b"x")
    assert info.value.code == ra.KEY_UNSUPPORTED


def test_build_envelope_refuses_what_the_core_would_refuse(agent):
    for kwargs, code in (({"kind": "all_clear"}, ra.BAD_KIND), ({"ip": "127.0.0.1"}, ra.BAD_ADDRESS),
                         ({"detail": "x" * 300}, ra.BAD_DETAIL)):
        with pytest.raises(ra.Refusal) as info:
            envelope(agent, **kwargs)
        assert info.value.code == code


def test_the_verifier_needs_a_ca_and_valid_source_policies(ca):
    with pytest.raises(ValueError):
        ra.RemoteAlertVerifier(ca_pem_chunks=[], sources={SOURCE: ra.SourcePolicy("x")})
    with pytest.raises(ValueError):
        ra.RemoteAlertVerifier(ca_pem_chunks=[ca.pem], sources={"Bad Source": ra.SourcePolicy("x")})


def test_the_token_bucket_limits_and_refills():
    now = [0.0]
    bucket = ra.TokenBucket(2, 1, clock=lambda: now[0])
    assert [bucket.take() for _ in range(3)] == [True, True, False]
    now[0] += 1.0
    assert bucket.take() is True and bucket.take() is False


def test_the_private_key_is_never_part_of_an_envelope(agent):
    key_bytes = agent.key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    assert base64.b64encode(key_bytes)[:24] not in envelope(agent)
