"""Dedicated Recovery observer/operator entrypoint: ``python -m aegis_soc.recovery_ui``.

This is NOT ``server_admin.py`` / ``AegisAdminGUI``. It imports only the Recovery client and the wire contract, so it
cannot start an MQTT session, publish a heartbeat or command, run Telegram control, read Core credentials, fall back to
a repo-local database, or apply the desktop demo defaults (PIN, HMAC secret, broker). Every action is one bounded
request to the Core-owned Recovery socket; when that socket is unavailable or not owned by the Core account, the UI
fails closed and offers nothing.

There is no RESTORE button: production RESTORE is the owner's terminal-only Core-local D4 step (``aegisctl restore``).
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Callable
from typing import Any

from . import recovery_client as client
from . import recovery_protocol as rp

RESTORE_NOTE = "RESTORE is performed only by the owner in a terminal: aegisctl restore (Core-local D4). LVR-6 is an owner runbook step."
UNAVAILABLE_TEXT = "Recovery is unavailable (fail closed): the Core Recovery channel is not reachable or not trusted."


def render_lines(payload: dict[str, Any]) -> list[str]:
    """Plain-text rendering of a Core response; only Core-supplied safe fields are shown."""
    data = payload.get("data") or {}
    lines = [f"{payload.get('code', '?')}: {payload.get('detail', '')}"]
    incident = data.get("incident")
    if "incident" in data:
        lines.append(
            "incident: none" if not incident
            else f"incident #{incident['id']} {incident['state']} attacker_ip={incident['attacker_ip']}"
        )
    for gate in data.get("gates", []):
        detail = f" [{gate['detail']}]" if gate.get("detail") else ""
        lines.append(f"{gate['gate']}: {gate['status']} - {gate['summary']}{detail}")
    ladder = data.get("restore")
    if ladder:
        lines.append("restore evidence: " + ", ".join(f"{key}={ladder[key]}" for key in sorted(ladder)))
    return lines


def run_once(
    op: str = rp.OP_STATUS,
    *,
    summary: str | None = None,
    request: Callable[..., dict[str, Any]] = client.request,
    out: Callable[[str], None] = print,
) -> int:
    """One request, printed. Exit 0 ok, 2 refused by the Core, 3 unavailable / outcome unknown (fail closed)."""
    try:
        payload = request(op, summary=summary)
    except (client.RecoveryUnavailable, client.RecoveryOutcomeUnknown) as error:
        out(UNAVAILABLE_TEXT)
        out(str(error))
        return 3
    for line in render_lines(payload):
        out(line)
    return 0 if payload.get("ok") else 2


def _run_window(request: Callable[..., dict[str, Any]] = client.request) -> int:  # pragma: no cover - needs a display
    import tkinter as tk
    from tkinter import messagebox, scrolledtext

    root = tk.Tk()
    root.title("AEGIS IDEA3 - Recovery (observer)")
    output = scrolledtext.ScrolledText(root, width=110, height=24, state="disabled")
    output.pack(fill="both", expand=True, padx=8, pady=8)
    tk.Label(root, text=RESTORE_NOTE, wraplength=760, justify="left").pack(padx=8)
    summary_var = tk.StringVar()
    buttons: list[tk.Button] = []

    def show(lines: list[str]) -> None:
        output.configure(state="normal")
        output.delete("1.0", "end")
        output.insert("end", "\n".join(lines))
        output.configure(state="disabled")

    def act(op: str, *, summary: str | None = None) -> None:
        lines: list[str] = []
        try:
            payload = request(op, summary=summary)
            lines = render_lines(payload)
        except (client.RecoveryUnavailable, client.RecoveryOutcomeUnknown) as error:
            lines = [UNAVAILABLE_TEXT, str(error)]
            for button in buttons:
                button.configure(state="disabled")
        show(lines)

    def isolate() -> None:
        if messagebox.askyesno("Isolate", "Ask the Core to isolate the attacker IP bound to the open incident?"):
            act(rp.OP_ISOLATE)

    def close_incident() -> None:
        if messagebox.askyesno("Close", "Ask the Core to close the incident? It re-checks every gate first."):
            act(rp.OP_CLOSE, summary=summary_var.get())

    row = tk.Frame(root)
    row.pack(padx=8, pady=4)
    for label, command in (
        ("Refresh", lambda: act(rp.OP_STATUS)),
        ("Probe (R2/R6/R7)", lambda: act(rp.OP_PROBE)),
        ("Isolate bound attacker (R3)", isolate),
        ("RESTORE status (R4/R5)", lambda: act(rp.OP_RESTORE_STATUS)),
    ):
        button = tk.Button(row, text=label, command=command)
        button.pack(side="left", padx=4)
        buttons.append(button)
    closing = tk.Frame(root)
    closing.pack(padx=8, pady=4, fill="x")
    tk.Label(closing, text="Lessons learned:").pack(side="left")
    tk.Entry(closing, textvariable=summary_var, width=70).pack(side="left", padx=4)
    close_button = tk.Button(closing, text="Close incident (R8)", command=close_incident)
    close_button.pack(side="left")
    buttons.append(close_button)
    act(rp.OP_STATUS)
    root.mainloop()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="aegis_soc.recovery_ui", description="Core-mediated Recovery observer")
    parser.add_argument("--once", action="store_true", help="print the Core recovery status and exit (no window)")
    args = parser.parse_args(argv)
    if args.once:
        return run_once()
    try:
        return _run_window()
    except Exception as error:  # no display or toolkit: fail closed, never fall back to another path
        print(f"Recovery UI could not start: {type(error).__name__}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
