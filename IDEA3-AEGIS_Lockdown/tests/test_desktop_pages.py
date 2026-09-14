"""Headless contracts for the completed desktop operations workspace."""

from aegis_soc import database as db
from aegis_soc.gui import NAV_ITEMS


def test_authenticated_navigation_exposes_all_eight_operational_pages():
    assert [(key, enabled) for key, _label, enabled in NAV_ITEMS] == [
        ("overview", True),
        ("incidents", True),
        ("devices", True),
        ("lockdown", True),
        ("recovery", True),
        ("audit", True),
        ("diagnostics", True),
        ("settings", True),
    ]


def test_fetch_incidents_returns_newest_first_with_complete_fields(tmp_path, monkeypatch):
    monkeypatch.setattr(db.config, "DB_PATH", str(tmp_path / "incidents.db"))
    db.init_db()

    first_id = db.create_incident("203.0.113.8")
    db.close_incident(first_id, "resolved")
    second_id = db.create_incident("198.51.100.42")

    incidents = db.fetch_incidents(limit=10)

    assert [incident["id"] for incident in incidents] == [second_id, first_id]
    assert incidents[0] == {
        "id": second_id,
        "opened_at": incidents[0]["opened_at"],
        "closed_at": None,
        "state": "OPEN",
        "attacker_ip": "198.51.100.42",
        "summary": None,
    }
    assert incidents[1]["state"] == "CLOSED"
    assert incidents[1]["summary"] == "resolved"


def test_fetch_incidents_honors_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(db.config, "DB_PATH", str(tmp_path / "limited.db"))
    db.init_db()
    first_id = db.create_incident("203.0.113.1")
    db.close_incident(first_id, "done")
    db.create_incident("203.0.113.2")

    assert len(db.fetch_incidents(limit=1)) == 1
