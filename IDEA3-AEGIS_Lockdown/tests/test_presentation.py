"""Focused tests for aegis_soc.presentation -- the Slice 1 UX/UI refresh's
pure, headless-testable Overview state-mapping layer.

These tests import no tkinter and require no DISPLAY: presentation.py has
no GUI dependency by design, precisely so this coverage can run anywhere.
"""
from aegis_soc import presentation as pres


def test_broker_metric_unknown_when_no_callback_has_fired():
    metric = pres.broker_metric(None)
    assert metric.value == "UNKNOWN"
    assert metric.status == pres.STATUS_UNKNOWN


def test_broker_metric_connected_and_disconnected():
    assert pres.broker_metric(True).value == "CONNECTED"
    assert pres.broker_metric(True).status == pres.STATUS_HEALTHY
    assert pres.broker_metric(False).value == "DISCONNECTED"
    assert pres.broker_metric(False).status == pres.STATUS_CRITICAL


def test_esp32_metric_unknown_when_never_seen():
    metric = pres.esp32_metric(None, offline_threshold_sec=45)
    assert metric.value == "UNKNOWN"
    assert metric.status == pres.STATUS_UNKNOWN


def test_esp32_metric_online_within_threshold():
    metric = pres.esp32_metric(10, offline_threshold_sec=45)
    assert metric.value == "ONLINE"
    assert metric.status == pres.STATUS_HEALTHY
    assert "10s ago" in metric.helper


def test_esp32_metric_offline_past_threshold():
    metric = pres.esp32_metric(90, offline_threshold_sec=45)
    assert metric.value == "OFFLINE"
    assert metric.status == pres.STATUS_CRITICAL


def test_esp32_metric_includes_rssi_and_heap_when_available():
    metric = pres.esp32_metric(5, offline_threshold_sec=45, rssi=-62, heap=41234)
    assert "RSSI -62 dBm" in metric.helper
    assert "heap 41234 B" in metric.helper


def test_uplink_metric_normal_lockdown_and_unknown():
    assert pres.uplink_metric("NORMAL").value == "NORMAL"
    assert pres.uplink_metric("NORMAL").status == pres.STATUS_HEALTHY
    assert pres.uplink_metric("LOCKDOWN").value == "LOCKDOWN"
    assert pres.uplink_metric("LOCKDOWN").status == pres.STATUS_CRITICAL
    assert pres.uplink_metric(None).value == "UNKNOWN"
    assert pres.uplink_metric("SOMETHING_ELSE").status == pres.STATUS_UNKNOWN


def test_system_health_unknown_when_evidence_missing():
    # No broker evidence yet.
    metric = pres.system_health_metric(None, 5, 45)
    assert metric.value == "UNKNOWN"
    assert metric.status == pres.STATUS_UNKNOWN
    # No device evidence yet.
    metric = pres.system_health_metric(True, None, 45)
    assert metric.value == "UNKNOWN"


def test_system_health_never_reports_failed():
    """This GUI has no crash/failure signal; system_health_metric must only
    ever produce HEALTHY, DEGRADED, or UNKNOWN -- never a fabricated FAILED."""
    possible_status_values = set()
    for broker_connected in (True, False, None):
        for seconds_since_seen in (0, 10, 46, 1000, None):
            metric = pres.system_health_metric(broker_connected, seconds_since_seen, 45)
            possible_status_values.add(metric.value)
    assert possible_status_values == {"HEALTHY", "DEGRADED", "UNKNOWN"}


def test_system_health_healthy_only_when_broker_connected_and_device_fresh():
    metric = pres.system_health_metric(True, 10, 45)
    assert metric.value == "HEALTHY"
    assert metric.status == pres.STATUS_HEALTHY


def test_system_health_degraded_when_broker_down_or_device_stale():
    assert pres.system_health_metric(False, 10, 45).value == "DEGRADED"
    assert pres.system_health_metric(True, 90, 45).value == "DEGRADED"


def test_mode_metric_reflects_armed_boolean_only():
    assert pres.mode_metric(True).value == "ARMED"
    assert pres.mode_metric(True).status == pres.STATUS_HEALTHY
    assert pres.mode_metric(False).value == "DISARMED"
    assert pres.mode_metric(False).status == pres.STATUS_WARNING


def test_deadman_metric_severity_thresholds():
    assert pres.deadman_metric(60).status == pres.STATUS_HEALTHY
    assert pres.deadman_metric(30).status == pres.STATUS_WARNING
    assert pres.deadman_metric(20).status == pres.STATUS_WARNING
    assert pres.deadman_metric(10).status == pres.STATUS_CRITICAL
    assert pres.deadman_metric(0).status == pres.STATUS_CRITICAL
    assert pres.deadman_metric(60).value == "60s"


def test_incidents_metric_zero_when_no_open_incident():
    metric = pres.incidents_metric(None)
    assert metric.value == "0"
    assert metric.status == pres.STATUS_HEALTHY
    assert metric.helper == ""


def test_incidents_metric_one_with_detail_when_open():
    incident = {"id": 7, "state": "CONTAINED", "attacker_ip": "203.0.113.5"}
    metric = pres.incidents_metric(incident)
    assert metric.value == "1"
    assert metric.status == pres.STATUS_WARNING
    assert "#7" in metric.helper
    assert "CONTAINED" in metric.helper
    assert "203.0.113.5" in metric.helper


def test_today_metric_is_a_plain_neutral_count():
    metric = pres.today_metric(3)
    assert metric.value == "3"
    assert metric.status == pres.STATUS_NEUTRAL


def test_extract_source_parses_origin_marker():
    assert pres.extract_source("CUT_UPLINK - desc (origin=gui)") == "GUI"
    assert pres.extract_source("RESTORE_UPLINK (origin=telegram)") == "TELEGRAM"


def test_extract_source_falls_back_to_system_without_marker():
    assert pres.extract_source("System ARMED") == "SYSTEM"
    assert pres.extract_source("") == "SYSTEM"
    assert pres.extract_source(None) == "SYSTEM"


def test_build_activity_rows_maps_fields_and_formats_time():
    log_rows = [
        (5, "2026-09-14 14:32:08", "CRITICAL", "COMMAND_REJECTED", "denied (origin=gui)", None),
        (4, "2026-09-14 14:31:59", "INFO", "MODE_CHANGE", "System ARMED", None),
    ]
    rows = pres.build_activity_rows(log_rows)
    assert len(rows) == 2
    assert rows[0].time == "14:32:08"
    assert rows[0].severity == "CRITICAL"
    assert rows[0].event == "COMMAND_REJECTED"
    assert rows[0].source == "GUI"
    assert rows[1].source == "SYSTEM"


def test_build_activity_rows_respects_limit():
    log_rows = [(i, "2026-09-14 00:00:00", "INFO", "EVENT", None, None) for i in range(20)]
    rows = pres.build_activity_rows(log_rows, limit=8)
    assert len(rows) == 8


def test_build_activity_rows_handles_no_rows():
    assert pres.build_activity_rows([]) == []
