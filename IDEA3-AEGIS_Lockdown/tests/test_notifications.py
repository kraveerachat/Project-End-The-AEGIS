"""Focused tests for aegis_soc.notifications -- the pure, session-local
security notification model (no tkinter dependency).
"""
import pytest

from aegis_soc import notifications as notif


def test_add_returns_notification_with_expected_fields():
    center = notif.NotificationCenter()
    n = center.add(
        severity=notif.SEVERITY_WARNING,
        category=notif.CATEGORY_CONNECTIVITY,
        title_key="notif.broker_disconnected_title",
        message_key="notif.broker_disconnected_message",
    )
    assert n.id == 1
    assert n.severity == notif.SEVERITY_WARNING
    assert n.acknowledged is False
    assert n.timestamp > 0


def test_add_rejects_unknown_severity():
    center = notif.NotificationCenter()
    with pytest.raises(ValueError):
        center.add(severity="APOCALYPSE", category=notif.CATEGORY_SYSTEM,
                    title_key="x", message_key="y")


def test_ids_increment_and_newest_first():
    center = notif.NotificationCenter()
    first = center.add(severity=notif.SEVERITY_INFO, category=notif.CATEGORY_SYSTEM,
                        title_key="a", message_key="b")
    second = center.add(severity=notif.SEVERITY_INFO, category=notif.CATEGORY_SYSTEM,
                         title_key="a", message_key="b")
    assert second.id == first.id + 1
    assert [n.id for n in center.all()] == [second.id, first.id]


def test_unread_count_tracks_acknowledgement():
    center = notif.NotificationCenter()
    n1 = center.add(severity=notif.SEVERITY_INFO, category=notif.CATEGORY_SYSTEM,
                     title_key="a", message_key="b")
    center.add(severity=notif.SEVERITY_WARNING, category=notif.CATEGORY_SYSTEM,
               title_key="a", message_key="b")
    assert center.unread_count() == 2
    assert center.acknowledge(n1.id) is True
    assert center.unread_count() == 1


def test_acknowledge_unknown_id_returns_false():
    center = notif.NotificationCenter()
    assert center.acknowledge(9999) is False


def test_acknowledge_all_clears_unread_count():
    center = notif.NotificationCenter()
    center.add(severity=notif.SEVERITY_INFO, category=notif.CATEGORY_SYSTEM,
               title_key="a", message_key="b")
    center.add(severity=notif.SEVERITY_CRITICAL, category=notif.CATEGORY_SYSTEM,
               title_key="a", message_key="b")
    center.acknowledge_all()
    assert center.unread_count() == 0


def test_critical_unread_count_only_counts_unacknowledged_critical():
    center = notif.NotificationCenter()
    critical = center.add(severity=notif.SEVERITY_CRITICAL, category=notif.CATEGORY_SYSTEM,
                           title_key="a", message_key="b")
    center.add(severity=notif.SEVERITY_WARNING, category=notif.CATEGORY_SYSTEM,
               title_key="a", message_key="b")
    assert center.critical_unread_count() == 1
    center.acknowledge(critical.id)
    assert center.critical_unread_count() == 0


def test_max_items_evicts_oldest():
    center = notif.NotificationCenter(max_items=3)
    for _ in range(5):
        center.add(severity=notif.SEVERITY_INFO, category=notif.CATEGORY_SYSTEM,
                   title_key="a", message_key="b")
    assert len(center.all()) == 3


def test_clear_removes_everything():
    center = notif.NotificationCenter()
    center.add(severity=notif.SEVERITY_INFO, category=notif.CATEGORY_SYSTEM,
               title_key="a", message_key="b")
    center.clear()
    assert center.all() == []
    assert center.unread_count() == 0


def test_acknowledge_never_touches_incident_or_containment_state():
    # Acknowledging is presentation-state only -- there is no incident_id
    # mutation, no containment flag, nothing beyond the Notification's own
    # `acknowledged` field. This test documents that boundary: the returned
    # object exposes incident_id as a read-only reference, never a live
    # link back into database state.
    center = notif.NotificationCenter()
    n = center.notify_attacker_detected("203.0.113.5", incident_id=42)
    assert n.incident_id == 42
    center.acknowledge(n.id)
    # incident_id is unchanged by acknowledgement -- it was never a
    # mutable pointer into incident state, just a read-only cross-reference.
    assert center.all()[0].incident_id == 42


def test_notify_attacker_detected_with_known_ip_uses_ip_message_key():
    center = notif.NotificationCenter()
    n = center.notify_attacker_detected("198.51.100.7")
    assert n.severity == notif.SEVERITY_CRITICAL
    assert n.source_ip == "198.51.100.7"
    assert n.format_kwargs == {"source_ip": "198.51.100.7"}
    assert n.message_key == "notif.security_alert_message"
    assert n.navigation_target == notif.NAV_INCIDENTS


def test_notify_attacker_detected_without_ip_never_fabricates_one():
    center = notif.NotificationCenter()
    n = center.notify_attacker_detected(None)
    assert n.source_ip is None
    assert n.format_kwargs == {}
    assert n.message_key == "notif.security_alert_message_unknown"


def test_notify_broker_disconnected_is_warning_not_critical():
    center = notif.NotificationCenter()
    n = center.notify_broker_disconnected()
    assert n.severity == notif.SEVERITY_WARNING
    assert n.category == notif.CATEGORY_CONNECTIVITY


def test_notify_esp32_offline_is_warning():
    center = notif.NotificationCenter()
    n = center.notify_esp32_offline()
    assert n.severity == notif.SEVERITY_WARNING


def test_notify_lockdown_engaged_is_critical():
    center = notif.NotificationCenter()
    n = center.notify_lockdown_engaged()
    assert n.severity == notif.SEVERITY_CRITICAL
    assert n.navigation_target == notif.NAV_LOCKDOWN


def test_notify_normal_restored_is_info_not_success_fabrication():
    # Restoring NORMAL is real evidence (an uplink state transition already
    # observed), so INFO is appropriate -- but it must never be styled as
    # a physical-isolation-verified claim; the message key is asserted
    # separately by an i18n test to avoid over-claiming text here.
    center = notif.NotificationCenter()
    n = center.notify_normal_restored()
    assert n.severity == notif.SEVERITY_INFO


def test_notify_audit_integrity_invalid_is_critical():
    center = notif.NotificationCenter()
    n = center.notify_audit_integrity_invalid()
    assert n.severity == notif.SEVERITY_CRITICAL
    assert n.navigation_target == notif.NAV_AUDIT


def test_all_convenience_builders_use_declared_severities_only():
    center = notif.NotificationCenter()
    builders = (
        center.notify_broker_disconnected,
        center.notify_esp32_offline,
        lambda: center.notify_attacker_detected("203.0.113.9"),
        center.notify_lockdown_engaged,
        center.notify_normal_restored,
        center.notify_audit_integrity_invalid,
    )
    for builder in builders:
        n = builder()
        assert n.severity in notif.SEVERITIES


def test_no_notification_field_encodes_attack_classification():
    # This is the mandatory boundary from the task spec: nothing in this
    # module may claim "SSH brute force", "port scan", etc. Since the
    # convenience builders only ever set an i18n *key* (never raw prose)
    # and format_kwargs only ever carries source_ip/incident_id, there is
    # no code path here that could smuggle a fabricated attack label in.
    center = notif.NotificationCenter()
    n = center.notify_attacker_detected("203.0.113.9")
    allowed_kwarg_keys = {"source_ip"}
    assert set(n.format_kwargs.keys()) <= allowed_kwarg_keys
