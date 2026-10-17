"""Single Purple Desktop entry point: Core STATUS incidents and opt-in Core-local Manual CUT.

With CUT disabled, the incident desktop remains read-only. Enabling CUT requires
the existing exact enable flag and an absolute Core socket path. The accepted
Purple UI, Recovery STATUS transport, and CUT client retain their own boundaries.
"""

from __future__ import annotations

import os
import sys
import tkinter as tk
from pathlib import Path

from tools import graceful_exit
from tools import live_purple_cut_desktop as cut_desktop
from tools import live_purple_incident_desktop as incident_desktop

STATUS_FILE_ENV = "AEGIS_CORE_STATUS_FILE"


def configured_status_path():
    """Optional absolute override of the Core status file; it is only ever read directly; there is no privileged fallback."""
    value = os.environ.get(STATUS_FILE_ENV)
    if not value:
        return None
    path = Path(value)
    if not path.is_absolute():
        raise ValueError(f"{STATUS_FILE_ENV} must be an absolute path")
    return path


def create_app(root, *, flow=None, incident_source=None, prompts=None, run_async=None, **kwargs):
    source = incident_source if incident_source is not None else incident_desktop.default_source()
    path = cut_desktop.configuration()
    if os.environ.get(cut_desktop.ENABLE_ENV) == "YES" and path is None:
        raise ValueError("Manual CUT requires an absolute Core CUT socket path")
    options = dict(kwargs)
    status_path = configured_status_path()
    if status_path is not None:
        options.setdefault("status_path", status_path)
    if run_async is not None:
        options["run_async"] = run_async
    if path is None:
        return incident_desktop.create_incident_app(root, source=source, **options)
    return cut_desktop.create_cut_app(
        root, flow=flow if flow is not None else cut_desktop.client.ManualCutFlow(path),
        prompts=prompts, incident_source=source, **options,
    )


def main():
    try:
        configured_status_path()
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2
    if os.environ.get(cut_desktop.ENABLE_ENV) == "YES" and cut_desktop.configuration() is None:
        print("Manual CUT requires an absolute Core CUT socket path", file=sys.stderr)
        return 2
    root = tk.Tk()
    app, _isolation = create_app(root)
    graceful_exit.install(root, app)
    root.mainloop()
    return 0 if app else 1


if __name__ == "__main__":
    sys.exit(main())
