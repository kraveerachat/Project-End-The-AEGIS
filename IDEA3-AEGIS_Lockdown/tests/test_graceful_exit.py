"""SIGTERM closes the purple Desktop entrypoints through their normal shutdown path."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import tempfile
import time
import tkinter as tk
from pathlib import Path

import pytest

from tools import graceful_exit

LOCKDOWN_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def root():
    try:
        window = tk.Tk()
    except tk.TclError as error:
        pytest.skip(f"Tk display unavailable: {error}")
    window.withdraw()
    saved = {signum: signal.getsignal(signum) for signum in graceful_exit.SIGNALS}
    yield window
    for signum, handler in saved.items():
        signal.signal(signum, handler)
    try:
        window.destroy()
    except tk.TclError:
        pass


@pytest.mark.parametrize("signum", [signal.SIGTERM, signal.SIGINT])
def test_signal_runs_the_application_close_once(root, signum):
    calls = []

    class App:
        def _on_close(self):
            calls.append("close")
            root.destroy()

    graceful_exit.install(root, App())
    root.after(50, lambda: os.kill(os.getpid(), signum))
    root.mainloop()
    assert calls == ["close"]


def test_without_an_app_close_the_window_is_destroyed(root):
    graceful_exit.install(root)
    root.after(50, lambda: os.kill(os.getpid(), signal.SIGTERM))
    root.mainloop()
    with pytest.raises(tk.TclError):
        root.winfo_exists()


def test_no_signal_leaves_the_window_open(root):
    state = graceful_exit.install(root)
    root.after(500, root.quit)
    root.mainloop()
    assert state["requested"] is None and root.winfo_exists()


def test_demo_entrypoint_exits_zero_and_removes_its_temp_dir_on_sigterm():
    try:
        tk.Tk().destroy()
    except tk.TclError as error:
        pytest.skip(f"Tk display unavailable: {error}")
    tmp_root = tempfile.mkdtemp(prefix="aegis-graceful-")
    env = {key: os.environ[key] for key in ("PATH", "HOME", "DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR") if key in os.environ}
    env["TMPDIR"] = tmp_root
    process = subprocess.Popen([sys.executable, "-m", "tools.demo_purple_desktop"], cwd=LOCKDOWN_ROOT, env=env,
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and not any(p.name.startswith("aegis-purple-demo-") for p in Path(tmp_root).iterdir()):
            assert process.poll() is None, process.stderr.read()
            time.sleep(0.2)
        time.sleep(1.5)
        process.send_signal(signal.SIGTERM)
        assert process.wait(timeout=15) == 0
        assert list(Path(tmp_root).iterdir()) == []
    finally:
        if process.poll() is None:
            process.kill()
        os.rmdir(tmp_root) if not list(Path(tmp_root).iterdir()) else None
