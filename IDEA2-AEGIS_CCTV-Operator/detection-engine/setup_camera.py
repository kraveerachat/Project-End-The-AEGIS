#!/usr/bin/env python3
"""
setup_camera — pick this machine's camera, the way an app asks you to choose a
microphone.

Every edge node runs its own copy of the engine against its own hardware, so
``AEGIS_CAMERA_SOURCE`` is a *per-machine* value. Until now filling it in meant
opening ``.env`` in an editor and typing an index someone had guessed. This
replaces that with: probe what is really attached, show it, let the person
choose, write it down.

    python setup_camera.py              # interactive picker (the normal path)
    python setup_camera.py --list       # just show what's attached, write nothing
    python setup_camera.py --json       # same, machine-readable
    python setup_camera.py --source rtsp://cam/stream1   # set it without prompting

Run it on the node itself. It deliberately has no remote/web equivalent: this
reads *local* hardware, and Monitor has no channel to another machine's USB
bus. Monitor only ever learns, after the fact, which device was chosen — see
``EngineConfig.describe_camera_device`` and the heartbeat payload.

Exit codes: 0 wrote a source · 1 error · 2 nothing written (no device, or the
user quit) · 130 interrupted.
"""

from __future__ import annotations

# Set before OpenCV is imported: a scan deliberately opens indices that do not
# exist, and each miss is a WARN on stderr that would bury the actual table.
import os

os.environ.setdefault("OPENCV_LOG_LEVEL", "SILENT")
os.environ.setdefault("OPENCV_VIDEOIO_PRIORITY_MSMF", os.environ.get(
    "OPENCV_VIDEOIO_PRIORITY_MSMF", ""
) or "0" if False else os.environ.get("OPENCV_VIDEOIO_PRIORITY_MSMF", ""))

import argparse
import json
import re
import sys
import tempfile
from typing import Dict, List, Optional, Tuple

from aegis_engine.camera_devices import (
    DEFAULT_MAX_INDEX,
    BACKENDS,
    CameraDevice,
    environment_report,
    probe_devices,
    save_preview,
    verify_source,
    windows_name_hint,
)

ENV_KEY_SOURCE = "AEGIS_CAMERA_SOURCE"
ENV_KEY_DEVICE_NAME = "AEGIS_CAMERA_DEVICE_NAME"

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ENV = os.path.join(HERE, ".env")
EXAMPLE_ENV = os.path.join(HERE, ".env.example")

EXIT_OK, EXIT_ERROR, EXIT_NOTHING_WRITTEN, EXIT_INTERRUPTED = 0, 1, 2, 130


class Abort(Exception):
    """User quit, or we cannot prompt. Never a crash — always a clean exit."""

    def __init__(self, message: str, code: int = EXIT_NOTHING_WRITTEN) -> None:
        super().__init__(message)
        self.code = code


# ── console helpers ──────────────────────────────────────────────────────────
def out(msg: str = "") -> None:
    print(msg, flush=True)


def rule(char: str = "─", width: int = 74) -> None:
    out(char * width)


def ask(prompt: str) -> str:
    """Read one line. A closed/redirected stdin aborts instead of looping.

    Without this guard, running the picker from a service manager or a piped
    script would spin on EOF forever — the exact "don't let it hang" case.
    """
    if not sys.stdin or not sys.stdin.isatty():
        raise Abort(
            "This step needs an interactive terminal (stdin is not a TTY).\n"
            "Run `python setup_camera.py` directly on the node, or use\n"
            "`--source <index|url>` to set the value without prompting.",
            EXIT_ERROR,
        )
    try:
        return input(prompt).strip()
    except EOFError:
        raise Abort("Input stream closed — nothing was written.")
    except KeyboardInterrupt:
        raise Abort("Interrupted — nothing was written.", EXIT_INTERRUPTED)


# ── the device table ─────────────────────────────────────────────────────────
def print_header(backend: str, max_index: int) -> None:
    env = environment_report()
    rule("═")
    out("  AEGIS Detection Engine · camera setup")
    rule("═")
    out(f"  Host      : {env['platform']} ({env['machine']})")
    out(f"  Python    : {env['python']}   OpenCV: {env['opencv']}")
    io_bits = ", ".join(f"{k}={'yes' if v else 'no'}"
                        for k, v in env["video_io"].items() if v is not None)
    out(f"  Video I/O : {io_bits}")
    out(f"  Probing   : indices 0-{max_index} via the '{backend}' backend"
        f"{' (same call the engine makes)' if backend == 'any' else ''}")
    out()


def print_devices(devices: List[CameraDevice]) -> None:
    usable = [d for d in devices if d.usable]
    mute = [d for d in devices if not d.usable]

    if usable:
        out("  Working cameras (opened AND delivered a frame):")
        out()
        for d in usable:
            flag = "" if d.name_confirmed or not d.name else "  ← name unconfirmed"
            out(f"    [{d.index}]  {d.display_name()}{flag}")
            out(f"         {d.resolution_text()}")
        out()
        sources = {d.name_source for d in usable}
        for s in sorted(sources):
            out(f"    name source: {s}")
        out()

    if mute:
        # Surfaced, not hidden: these are exactly the indices someone would
        # otherwise type into .env by hand and then spend an hour debugging.
        out("  Indices that opened but produced NO frames — do not use these:")
        for d in mute:
            out(f"    [{d.index}]  {d.error or 'no frame'}"
                + (f"  ({d.name})" if d.name else ""))
        out()

    hint = windows_name_hint()
    if hint:
        out(f"  Note: {hint}")
        out()


# ── .env writing ─────────────────────────────────────────────────────────────
_PLAIN = re.compile(r"^[A-Za-z0-9_./:@-]+$")


def env_quote(value: str) -> str:
    """Quote only when needed, so a bare index stays a bare index in the file."""
    if value == "" or _PLAIN.match(value):
        return value
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def sanitize_name(name: Optional[str]) -> str:
    """A device name comes from the OS — treat it as untrusted text before it
    goes into a config file that is later parsed and shipped to Monitor."""
    if not name:
        return ""
    cleaned = "".join(ch for ch in name if ch.isprintable()).strip()
    return cleaned[:100]


def update_env_file(path: str, values: Dict[str, str]) -> Tuple[bool, List[str]]:
    """Set keys in a .env, preserving every other line, comment and order.

    Returns (created_new_file, [notes]). Written via a temp file + replace so an
    interrupted run cannot leave the node with a truncated config.
    """
    notes: List[str] = []
    created = False

    if os.path.exists(path):
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.read().splitlines()
    elif os.path.exists(EXAMPLE_ENV):
        with open(EXAMPLE_ENV, "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.read().splitlines()
        created = True
        notes.append(f"no .env existed — started one from {os.path.basename(EXAMPLE_ENV)}")
    else:
        lines = [
            "# AEGIS Detection Engine — created by setup_camera.py",
            "# All other settings fall back to the defaults in aegis_engine/config.py.",
            "",
        ]
        created = True
        notes.append("no .env and no .env.example — created a minimal .env")

    for key, raw in values.items():
        rendered = f"{key}={env_quote(raw)}"
        pattern = re.compile(rf"^\s*(export\s+)?{re.escape(key)}\s*=")
        replaced = False
        for i, line in enumerate(lines):
            if pattern.match(line):
                lines[i] = rendered
                replaced = True
                break  # first assignment wins in dotenv; rewrite that one
        if not replaced:
            if lines and lines[-1].strip() != "":
                lines.append("")
            lines.append(rendered)
            notes.append(f"{key} was not present — appended it")

    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".env.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join(lines).rstrip("\n") + "\n")
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return created, notes


def current_source(path: str) -> Optional[str]:
    """What the .env says today — shown so the person knows what they're changing."""
    if not os.path.exists(path):
        return None
    pattern = re.compile(rf"^\s*(export\s+)?{re.escape(ENV_KEY_SOURCE)}\s*=(.*)$")
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                m = pattern.match(line)
                if m:
                    return m.group(2).strip().strip('"').strip("'") or None
    except OSError:
        return None
    return None


# ── selection flows ──────────────────────────────────────────────────────────
def commit(env_path: str, source: str, device_name: str, backend: str) -> int:
    """Re-verify, then write. The re-check is the point, not a formality.

    A USB camera can be unplugged, or grabbed by another process, between the
    scan and the keystroke that selects it. Writing an unverified source would
    hand the node a config that only fails later, in the engine, at 3am.
    """
    out()
    out(f"  Re-checking {source} before writing …")
    ok, detail = verify_source(source, backend)
    if not ok:
        out()
        out(f"  ✗ {source} is no longer usable: {detail}")
        out("    The device was working a moment ago, so most likely it was")
        out("    unplugged, went to sleep, or another process (a running engine,")
        out("    a video call) took exclusive hold of it.")
        out("    Nothing was written — your .env is unchanged.")
        return EXIT_NOTHING_WRITTEN

    out(f"  ✓ {detail}")
    created, notes = update_env_file(env_path, {
        ENV_KEY_SOURCE: source,
        # Written for humans reading the file and for the heartbeat's
        # "which camera is this node on?" field. Never read back as an
        # identifier — the source is the only thing that opens a device.
        ENV_KEY_DEVICE_NAME: sanitize_name(device_name),
    })
    out()
    rule()
    out(f"  Wrote {ENV_KEY_SOURCE}={source}"
        + (f"  ({device_name})" if device_name else ""))
    out(f"  File : {os.path.abspath(env_path)}")
    for n in notes:
        out(f"  Note : {n}")
    if created:
        out("  Review the rest of that file before starting the engine.")
    rule()
    out("  Restart the engine to pick this up:  python run.py")
    return EXIT_OK


def manual_source(env_path: str, backend: str) -> int:
    """Hand-typed source — an IP camera URL, or a file for a bench test."""
    out()
    out("  Enter a source to pass straight to cv2.VideoCapture:")
    out("    · an RTSP/HTTP URL   rtsp://user:pass@192.168.10.40:554/Streaming/Channels/101")
    out("    · a video file       ./testfeed.mp4")
    out("    · a device index     2")
    out("  (blank to go back)")
    raw = ask("  Source: ")
    if not raw:
        return EXIT_NOTHING_WRITTEN

    ok, detail = verify_source(raw, backend)
    if not ok:
        out(f"  ✗ Could not use that source: {detail}")
        answer = ask("  Write it to .env anyway? [y/N]: ").lower()
        if answer not in ("y", "yes"):
            out("  Nothing written.")
            return EXIT_NOTHING_WRITTEN
        # Deliberate override: a camera that is merely offline right now is a
        # legitimate thing to configure — VideoCatcher reconnects with backoff.
        created, notes = update_env_file(env_path, {
            ENV_KEY_SOURCE: raw, ENV_KEY_DEVICE_NAME: "",
        })
        out(f"  Wrote {ENV_KEY_SOURCE}={raw} (unverified) to {os.path.abspath(env_path)}")
        for n in notes:
            out(f"  Note : {n}")
        return EXIT_OK

    out(f"  ✓ {detail}")
    created, notes = update_env_file(env_path, {
        ENV_KEY_SOURCE: raw, ENV_KEY_DEVICE_NAME: "",
    })
    out(f"  Wrote {ENV_KEY_SOURCE}={raw} to {os.path.abspath(env_path)}")
    for n in notes:
        out(f"  Note : {n}")
    out("  Restart the engine to pick this up:  python run.py")
    return EXIT_OK


def no_devices_flow(devices: List[CameraDevice], env_path: str, backend: str,
                    max_index: int) -> int:
    """Nothing usable was found. Explain, then offer real ways forward."""
    out()
    rule()
    out("  No working camera found on this machine.")
    rule()
    out(f"  Probed indices 0-{max_index} with the '{backend}' backend.")
    opened_mute = [d for d in devices if d.opened and not d.delivers_frames]
    if opened_mute:
        out(f"  {len(opened_mute)} index(es) opened but never produced a frame: "
            + ", ".join(str(d.index) for d in opened_mute))
    out()
    out("  Most common causes, in the order worth checking:")
    out("    1. The engine is already running and holds the camera exclusively.")
    out("       Stop it (Ctrl-C in its terminal / stop the service) and rescan.")
    out("    2. Another app has the camera — a video call, OBS, Camera.")
    out("    3. OS permission not granted to this Python interpreter")
    out("       (macOS: Privacy & Security ▸ Camera; Linux: the user must be in")
    out("       the `video` group for /dev/video*).")
    out("    4. No camera is attached, or a USB cam needs replugging.")
    out("    5. This is a VM/container without the device passed through.")
    out()
    out("  You can still configure an IP camera here — it needs no local device.")
    out()

    while True:
        choice = ask("  [r] rescan   [m] enter a source manually   [q] quit: ").lower()
        if choice in ("q", ""):
            raise Abort("Nothing written — .env is unchanged.")
        if choice == "r":
            return -1  # signal the caller to rescan
        if choice == "m":
            code = manual_source(env_path, backend)
            if code == EXIT_OK:
                return code
            # fall through and offer the menu again
        else:
            out("  Type r, m or q.")


def picker_flow(devices: List[CameraDevice], env_path: str, backend: str) -> int:
    usable = {d.index: d for d in devices if d.usable}
    existing = current_source(env_path)
    if existing:
        out(f"  Current setting: {ENV_KEY_SOURCE}={existing}")
        out()

    default_index = next(iter(usable))
    while True:
        out("  Choose a camera by index.")
        out(f"    [{'/'.join(str(i) for i in usable)}] select   "
            "[p N] preview   [r] rescan   [m] manual source   [q] quit")
        choice = ask(f"  Camera [{default_index}]: ").strip()

        if choice.lower() in ("q", "quit"):
            raise Abort("Nothing written — .env is unchanged.")
        if choice.lower() in ("r", "rescan"):
            return -1
        if choice.lower() in ("m", "manual"):
            code = manual_source(env_path, backend)
            if code == EXIT_OK:
                return code
            continue
        if choice.lower().startswith("p"):
            rest = choice[1:].strip()
            idx = rest if rest else str(default_index)
            if not idx.isdigit() or int(idx) not in usable:
                out(f"  ✗ {idx or '(none)'} is not one of the working cameras.")
                continue
            path = os.path.join(HERE, "snapshots", f"camera-preview-{idx}.jpg")
            ok, detail = save_preview(int(idx), path, backend)
            out(f"  {'✓ Preview saved: ' if ok else '✗ Preview failed: '}{detail}")
            out("    Open that file to confirm you picked the right camera."
                if ok else "")
            continue

        if choice == "":
            choice = str(default_index)
        if not choice.isdigit() or int(choice) not in usable:
            out(f"  ✗ '{choice}' is not one of the working cameras "
                f"({', '.join(str(i) for i in usable)}).")
            continue

        device = usable[int(choice)]
        name = device.name or ""
        if device.name and not device.name_confirmed:
            # Do not let an unverified label become the recorded truth.
            out(f"  Note: '{device.name}' is this platform's best guess for index "
                f"{device.index}, not a confirmed mapping. Use [p {device.index}] "
                "to see a frame from it if you are unsure.")
        return commit(env_path, device.env_value, name, backend)


# ── entrypoint ───────────────────────────────────────────────────────────────
def scan(backend: str, max_index: int, quiet: bool) -> List[CameraDevice]:
    def progress(i: int, total: int) -> None:
        if not quiet:
            print(f"\r  scanning index {i}/{total} …", end="", flush=True)

    devices = probe_devices(max_index=max_index, backend=backend, progress=progress)
    if not quiet:
        print("\r" + " " * 40 + "\r", end="", flush=True)
    return devices


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="setup_camera.py",
        description="Pick this machine's camera and write it to the local .env.",
    )
    p.add_argument("--list", action="store_true",
                   help="show detected devices and exit without writing")
    p.add_argument("--json", action="store_true",
                   help="machine-readable device list; implies --list")
    p.add_argument("--source",
                   help="set AEGIS_CAMERA_SOURCE to this value without prompting "
                        "(still verified before writing)")
    p.add_argument("--force", action="store_true",
                   help="with --source: write even if the source cannot be opened")
    p.add_argument("--max-index", type=int, default=DEFAULT_MAX_INDEX,
                   help=f"highest device index to probe (default {DEFAULT_MAX_INDEX})")
    p.add_argument("--backend", default="any", choices=sorted(BACKENDS),
                   help="OpenCV capture backend; 'any' matches what the engine uses")
    p.add_argument("--env-file", default=DEFAULT_ENV,
                   help="path to the .env to update (default: ./.env)")
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    if args.max_index < 0:
        out("--max-index must be >= 0")
        return EXIT_ERROR

    try:
        # Non-interactive set: for provisioning scripts and IP cameras.
        if args.source is not None:
            ok, detail = verify_source(args.source, args.backend)
            if not ok and not args.force:
                out(f"✗ {args.source}: {detail}")
                out("  Nothing written. Re-run with --force to write it anyway "
                    "(valid for a camera that is merely offline right now).")
                return EXIT_NOTHING_WRITTEN
            out(f"{'✓ ' + detail if ok else '! writing unverified source: ' + detail}")
            created, notes = update_env_file(args.env_file, {
                ENV_KEY_SOURCE: args.source, ENV_KEY_DEVICE_NAME: "",
            })
            out(f"Wrote {ENV_KEY_SOURCE}={args.source} to "
                f"{os.path.abspath(args.env_file)}")
            for n in notes:
                out(f"Note: {n}")
            return EXIT_OK

        if args.json:
            devices = scan(args.backend, args.max_index, quiet=True)
            print(json.dumps({
                "environment": environment_report(),
                "backend": args.backend,
                "maxIndexProbed": args.max_index,
                "devices": [d.to_dict() for d in devices],
                "envFile": os.path.abspath(args.env_file),
                "currentSource": current_source(args.env_file),
            }, indent=2))
            return EXIT_OK if any(d.usable for d in devices) else EXIT_NOTHING_WRITTEN

        while True:  # rescan loop
            print_header(args.backend, args.max_index)
            devices = scan(args.backend, args.max_index, quiet=False)
            print_devices(devices)

            if args.list:
                out(f"  .env: {os.path.abspath(args.env_file)}"
                    f"   current {ENV_KEY_SOURCE}={current_source(args.env_file) or '(unset)'}")
                return EXIT_OK if any(d.usable for d in devices) else EXIT_NOTHING_WRITTEN

            if not any(d.usable for d in devices):
                code = no_devices_flow(devices, args.env_file, args.backend,
                                       args.max_index)
            else:
                code = picker_flow(devices, args.env_file, args.backend)
            if code == -1:
                out()
                continue  # rescan requested
            return code

    except Abort as exc:
        out()
        out(f"  {exc}")
        return exc.code
    except KeyboardInterrupt:
        out()
        out("  Interrupted — nothing was written.")
        return EXIT_INTERRUPTED


if __name__ == "__main__":
    sys.exit(main())
