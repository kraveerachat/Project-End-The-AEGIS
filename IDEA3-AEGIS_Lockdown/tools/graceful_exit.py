"""Let SIGTERM/SIGINT close a Tk desktop through its normal shutdown path instead of killing the process.

Python signal handlers only run between Tk events, so the handler just records the request and a short ``after``
poll performs the close on the Tk thread.  The close callable is the application's own ``_on_close`` when it has
one (it stops the MQTT stand-in and logs), otherwise ``root.destroy``.  Nothing here sends a command anywhere.
"""

from __future__ import annotations

import signal

POLL_MS = 200
SIGNALS = (signal.SIGTERM, signal.SIGINT)


def install(root, app=None):
    """Install the handlers and return the flag dict (``requested`` is set once a signal arrived)."""

    state = {"requested": None, "closed": False}

    def request(signum, _frame):
        state["requested"] = signum

    def poll():
        if state["closed"]:
            return
        if state["requested"] is None:
            root.after(POLL_MS, poll)
            return
        state["closed"] = True
        close = getattr(app, "_on_close", None) or root.destroy
        try:
            close()
        finally:
            try:
                root.destroy()
            except Exception:
                pass

    for signum in SIGNALS:
        signal.signal(signum, request)
    root.after(POLL_MS, poll)
    return state
