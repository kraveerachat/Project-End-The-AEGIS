"""
camera_devices — find out which capture devices this machine can *actually* use.

Every edge node in the fleet is a different laptop with a different set of
cameras (built-in webcam, USB cam, a virtual camera some conferencing app
installed). ``AEGIS_CAMERA_SOURCE`` is per-machine for that reason, and until
now the only way to fill it in was to guess an index, start the engine, and see
whether frames appeared. This module replaces the guessing.

Two rules shape the whole thing:

**An index that opens is not a working camera.** ``cv2.VideoCapture(n)`` can
return ``isOpened() == True`` for a device that never delivers a single frame —
a metadata-only V4L2 node, an IR/depth sensor exposed alongside a colour
camera, a virtual camera with no source attached. So every candidate here is
opened *and* read from; :attr:`CameraDevice.delivers_frames` is the field that
matters, and it is measured, never assumed.

**Friendly names come from the OS, and only where the OS actually maps them.**
OpenCV's ``VideoCapture`` API has no name accessor at all — it is index-in,
frames-out. The names below are read from platform sources and correlated by
position, which is trustworthy on exactly one platform:

* **Linux** — ``/sys/class/video4linux/videoN/name``. Index *N* here is the
  same *N* OpenCV opens, so the mapping is exact.
* **Windows** — the DirectShow capture-filter list (via the optional
  ``pygrabber`` package), which is enumerated in *the same order OpenCV's
  DirectShow backend indexes devices*, so index *i* is name *i* exactly.
  Without ``pygrabber`` we fall back to PnP device names
  (``Win32_PnPEntity``), whose order Windows does not publish — that fallback
  is reported as a hint and is refused outright when the counts disagree.
* **macOS** — ``system_profiler SPCameraDataType``. Order is not published by
  AVFoundation either, so it carries the same hint-only caveat.

When a name cannot be obtained, :attr:`CameraDevice.name` is ``None`` and
:attr:`CameraDevice.name_source` says *why*. Nothing in here invents a label
for a device it could not identify.
"""

from __future__ import annotations

import json
import os
import platform
import subprocess
import time
from contextlib import contextmanager
from dataclasses import dataclass, replace
from typing import List, Optional, Sequence, Tuple, Union

try:  # same hard dependency (and same message) as video_catcher
    import cv2  # type: ignore
except Exception as exc:  # pragma: no cover
    raise RuntimeError(
        "OpenCV (opencv-python) is required for the Detection Engine. "
        "Install it with: pip install -r requirements.txt"
    ) from exc


# How far to probe by default. Indices are sparse on Windows (a machine can
# have 0, 1 and 3 but not 2), so probing must not stop at the first gap.
DEFAULT_MAX_INDEX = 5

# A camera may need a few reads before the first frame arrives (auto-exposure,
# USB negotiation). Give every candidate the same modest benefit of the doubt.
_WARMUP_READS = 6
_WARMUP_SLEEP_S = 0.08

# Names are read by shelling out to a platform tool; never let that hang the
# picker if the tool is missing, slow, or wedged.
_NAME_LOOKUP_TIMEOUT_S = 8.0

Source = Union[int, str]


# ── backends ─────────────────────────────────────────────────────────────────
# "any" is the default on purpose: it is exactly what VideoCatcher._open_camera
# passes (``cv2.VideoCapture(source)`` with no backend argument). Probing with a
# different backend than the engine uses would produce a list that does not
# describe what the engine will see — the picker must not lie about that.

def _backend_map() -> dict:
    out = {"any": cv2.CAP_ANY}
    for name, attr in (
        ("msmf", "CAP_MSMF"),
        ("dshow", "CAP_DSHOW"),
        ("v4l2", "CAP_V4L2"),
        ("avfoundation", "CAP_AVFOUNDATION"),
        ("gstreamer", "CAP_GSTREAMER"),
    ):
        val = getattr(cv2, attr, None)
        if val is not None:
            out[name] = val
    return out


BACKENDS = _backend_map()


def backend_id(name: str) -> int:
    try:
        return BACKENDS[name.lower()]
    except KeyError:
        raise ValueError(
            f"unknown backend {name!r}; available: {', '.join(sorted(BACKENDS))}"
        )


@contextmanager
def _quiet_opencv():
    """Silence OpenCV's per-probe warnings — failing to open index 4 is the
    expected outcome of a scan, not something to shout about on the console."""
    logging_mod = getattr(getattr(cv2, "utils", None), "logging", None)
    if logging_mod is None:  # pragma: no cover - older/newer cv2 layouts
        yield
        return
    try:
        previous = logging_mod.getLogLevel()
        logging_mod.setLogLevel(logging_mod.LOG_LEVEL_SILENT)
    except Exception:  # pragma: no cover
        yield
        return
    try:
        yield
    finally:
        try:
            logging_mod.setLogLevel(previous)
        except Exception:  # pragma: no cover
            pass


# ── the device record ────────────────────────────────────────────────────────
@dataclass(frozen=True)
class CameraDevice:
    """One probed device index. ``delivers_frames`` is the field that matters."""

    index: int
    backend: str
    opened: bool
    delivers_frames: bool
    width: Optional[int] = None
    height: Optional[int] = None
    fps: Optional[float] = None
    name: Optional[str] = None
    name_source: str = "not looked up"
    name_confirmed: bool = False
    error: Optional[str] = None

    @property
    def usable(self) -> bool:
        return self.opened and self.delivers_frames

    @property
    def env_value(self) -> str:
        """What goes into AEGIS_CAMERA_SOURCE for this device."""
        return str(self.index)

    def display_name(self) -> str:
        """Never fabricated: an unidentified device is described as such."""
        if not self.name:
            return f"index {self.index} (name unavailable)"
        return f"{self.name} (index {self.index})"

    def resolution_text(self) -> str:
        if self.width and self.height:
            fps = f" @ {self.fps:.0f}fps" if self.fps else ""
            return f"{self.width}x{self.height}{fps}"
        return "resolution unknown"

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "backend": self.backend,
            "opened": self.opened,
            "deliversFrames": self.delivers_frames,
            "usable": self.usable,
            "width": self.width,
            "height": self.height,
            "fps": self.fps,
            "name": self.name,
            "nameSource": self.name_source,
            "nameConfirmed": self.name_confirmed,
            "error": self.error,
            "envValue": self.env_value,
        }


# ── probing ──────────────────────────────────────────────────────────────────
def probe_index(index: int, backend: str = "any") -> CameraDevice:
    """Open one index and try to actually read a frame from it."""
    api = backend_id(backend)
    cap = None
    try:
        with _quiet_opencv():
            cap = cv2.VideoCapture(index, api)
            if not cap.isOpened():
                return CameraDevice(index=index, backend=backend, opened=False,
                                    delivers_frames=False)

            image = None
            for attempt in range(_WARMUP_READS):
                ok, img = cap.read()
                if ok and img is not None and getattr(img, "size", 0) > 0:
                    image = img
                    break
                if attempt + 1 < _WARMUP_READS:
                    time.sleep(_WARMUP_SLEEP_S)

            if image is None:
                # Opened but mute. Real case, not theoretical — this is why the
                # picker refuses to offer an index purely because it opened.
                return CameraDevice(
                    index=index, backend=backend, opened=True, delivers_frames=False,
                    error="opened but delivered no frame",
                )

            h, w = image.shape[0], image.shape[1]
            fps = None
            try:
                raw_fps = float(cap.get(cv2.CAP_PROP_FPS))
                # Many drivers report 0 or a nonsense value; only trust a sane one.
                if 0.1 < raw_fps < 1000:
                    fps = raw_fps
            except Exception:
                pass
            return CameraDevice(index=index, backend=backend, opened=True,
                                delivers_frames=True, width=int(w), height=int(h),
                                fps=fps)
    except Exception as exc:  # a backend can throw rather than return False
        return CameraDevice(index=index, backend=backend, opened=False,
                            delivers_frames=False,
                            error=f"{type(exc).__name__}: {exc}")
    finally:
        if cap is not None:
            try:
                cap.release()
            except Exception:
                pass


def probe_devices(
    max_index: int = DEFAULT_MAX_INDEX,
    backend: str = "any",
    resolve_names: bool = True,
    progress=None,
) -> List[CameraDevice]:
    """Probe indices ``0..max_index`` and return every one that opened.

    Indices that never opened are dropped (there is nothing to say about them);
    indices that opened without producing a frame are kept and flagged, because
    a caller needs to *tell the user* about them rather than silently hide the
    index they were about to type in by hand.
    """
    found: List[CameraDevice] = []
    for i in range(max_index + 1):
        if progress is not None:
            progress(i, max_index)
        dev = probe_index(i, backend)
        if dev.opened:
            found.append(dev)
    if resolve_names and found:
        found = attach_names(found)
    return found


def verify_source(source: Source, backend: str = "any") -> Tuple[bool, str]:
    """Confirm a source can be opened *and* read right now.

    Used twice by the picker: to validate a hand-typed RTSP URL / file path, and
    to re-check the chosen device immediately before writing it to ``.env`` (a
    USB camera unplugged mid-prompt must not be silently written into config).
    """
    if isinstance(source, str):
        stripped = source.strip()
        if stripped.lstrip("-").isdigit():
            source = int(stripped)
        else:
            source = stripped

    cap = None
    try:
        with _quiet_opencv():
            cap = (cv2.VideoCapture(source, backend_id(backend))
                   if isinstance(source, int) else cv2.VideoCapture(source))
            if not cap.isOpened():
                return False, "could not be opened"
            for attempt in range(_WARMUP_READS):
                ok, img = cap.read()
                if ok and img is not None and getattr(img, "size", 0) > 0:
                    return True, f"delivered a {img.shape[1]}x{img.shape[0]} frame"
                if attempt + 1 < _WARMUP_READS:
                    time.sleep(_WARMUP_SLEEP_S)
            return False, "opened but delivered no frame"
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"
    finally:
        if cap is not None:
            try:
                cap.release()
            except Exception:
                pass


def save_preview(source: Source, path: str, backend: str = "any") -> Tuple[bool, str]:
    """Grab one frame and write it to ``path`` as a JPEG.

    A name is a hint; a picture is proof. Edge nodes are usually driven over
    SSH where ``cv2.imshow`` is useless, so the preview is a file the operator
    opens — that works on a headless box and on a desktop alike.
    """
    cap = None
    try:
        if isinstance(source, str) and source.strip().lstrip("-").isdigit():
            source = int(source.strip())
        with _quiet_opencv():
            cap = (cv2.VideoCapture(source, backend_id(backend))
                   if isinstance(source, int) else cv2.VideoCapture(source))
            if not cap.isOpened():
                return False, "could not be opened"
            image = None
            for attempt in range(_WARMUP_READS):
                ok, img = cap.read()
                if ok and img is not None and getattr(img, "size", 0) > 0:
                    image = img
                    break
                if attempt + 1 < _WARMUP_READS:
                    time.sleep(_WARMUP_SLEEP_S)
            if image is None:
                return False, "opened but delivered no frame"
        parent = os.path.dirname(os.path.abspath(path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        if not cv2.imwrite(path, image):
            return False, f"could not write {path}"
        return True, os.path.abspath(path)
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"
    finally:
        if cap is not None:
            try:
                cap.release()
            except Exception:
                pass


# ── friendly names, per platform ─────────────────────────────────────────────
def attach_names(devices: Sequence[CameraDevice]) -> List[CameraDevice]:
    """Best-effort platform names. Honest about which ones can be trusted."""
    system = platform.system()
    if system == "Linux":
        return _attach_linux(devices)
    if system == "Windows":
        # Preferred: DirectShow's own ordered list — index i really is name i.
        names, source = _names_windows_dshow()
        if names:
            return _attach_by_index(devices, names, source, confirmed=True)
        return _attach_by_position(devices, *_names_windows_pnp(), confirmed=False)
    if system == "Darwin":
        return _attach_by_position(devices, *_names_macos(), confirmed=False)
    return [replace(d, name=None,
                    name_source=f"no name source implemented for {system or 'this platform'}")
            for d in devices]


def windows_name_hint() -> Optional[str]:
    """Advice to print when Windows names had to fall back to the fuzzy source."""
    if platform.system() != "Windows":
        return None
    if _names_windows_dshow()[0]:
        return None
    return ("Install `pygrabber` (pip install pygrabber) to get exact device "
            "names on this machine — without it Windows offers no published "
            "index→name mapping and devices are listed by index only.")


def _run(cmd: List[str]) -> Optional[str]:
    """Run a platform query tool. Returns None on any failure — a missing name
    is an inconvenience, never a reason for the picker to fall over."""
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True,
            timeout=_NAME_LOOKUP_TIMEOUT_S,
        )
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout


def _attach_linux(devices: Sequence[CameraDevice]) -> List[CameraDevice]:
    """V4L2: OpenCV index N *is* /dev/videoN, so this mapping is exact."""
    out: List[CameraDevice] = []
    for dev in devices:
        path = f"/sys/class/video4linux/video{dev.index}/name"
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                name = fh.read().strip()
        except Exception:
            out.append(replace(
                dev, name=None,
                name_source=f"{path} unreadable — index-only",
            ))
            continue
        out.append(replace(
            dev, name=name or None, name_confirmed=bool(name),
            name_source=("/sys/class/video4linux (exact match to OpenCV index)"
                         if name else f"{path} was empty — index-only"),
        ))
    return out


def _names_windows_dshow() -> Tuple[List[str], str]:
    """DirectShow capture filters, in DirectShow's own enumeration order.

    This is the order OpenCV's DShow backend assigns indices in, which makes
    index *i* → name *i* an exact mapping rather than a guess. Requires the
    optional ``pygrabber`` package (a thin ``comtypes`` wrapper); absent it we
    fall back to the fuzzy PnP list.

    Caveat kept visible in ``name_source``: with the ``any`` backend OpenCV may
    resolve to Media Foundation instead of DirectShow, and the two enumeration
    orders are not guaranteed identical — so callers still get a preview option
    to confirm with their own eyes.
    """
    try:
        from pygrabber.dshow_graph import FilterGraph  # type: ignore
    except Exception:
        return [], "pygrabber not installed"
    try:
        names = [str(n).strip() for n in FilterGraph().get_input_devices()]
    except Exception as exc:
        return [], f"DirectShow enumeration failed ({type(exc).__name__})"
    if not names:
        return [], "DirectShow reported no capture devices"
    return names, ("DirectShow enumeration order (pygrabber) — index i is "
                   "name i for the dshow backend")


def _names_windows_pnp() -> Tuple[List[str], str]:
    """PnP camera/imaging device names via CIM. Order is NOT authoritative."""
    script = (
        "Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | "
        "Where-Object { ($_.PNPClass -eq 'Camera' -or $_.PNPClass -eq 'Image') "
        "-and $_.Status -eq 'OK' } | "
        "Select-Object -ExpandProperty Name"
    )
    stdout = _run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script])
    if stdout is None:
        return [], "PowerShell/CIM query failed — index-only"
    names = [ln.strip() for ln in stdout.splitlines() if ln.strip()]
    if not names:
        return [], "no PnP camera devices reported — index-only"
    return names, ("Windows PnP (Win32_PnPEntity) — order is not published by "
                   "Windows, so this pairing is a HINT, not a guarantee")


def _names_macos() -> Tuple[List[str], str]:
    stdout = _run(["system_profiler", "-json", "SPCameraDataType"])
    if stdout is None:
        return [], "system_profiler query failed — index-only"
    try:
        data = json.loads(stdout)
        entries = data.get("SPCameraDataType") or []
        names = [str(e.get("_name")).strip() for e in entries if e.get("_name")]
    except Exception:
        return [], "system_profiler output was unparseable — index-only"
    if not names:
        return [], "no cameras reported by system_profiler — index-only"
    return names, ("macOS system_profiler — AVFoundation index order is not "
                   "published, so this pairing is a HINT, not a guarantee")


def _attach_by_index(
    devices: Sequence[CameraDevice], names: List[str], source: str,
    confirmed: bool,
) -> List[CameraDevice]:
    """Direct mapping: device index *i* takes ``names[i]``.

    Used only for name sources whose ordering IS the backend's index ordering,
    so gaps (an index that refuses to open) do not shift the pairing — unlike
    :func:`_attach_by_position`, which has to zip and therefore has to bail out
    when the counts disagree.
    """
    out: List[CameraDevice] = []
    for dev in devices:
        if 0 <= dev.index < len(names) and names[dev.index]:
            out.append(replace(dev, name=names[dev.index],
                               name_confirmed=confirmed, name_source=source))
        else:
            out.append(replace(
                dev, name=None, name_confirmed=False,
                name_source=(f"index {dev.index} is beyond the {len(names)} "
                             f"device(s) the OS listed — index-only"),
            ))
    return out


def _attach_by_position(
    devices: Sequence[CameraDevice], names: List[str], source: str,
    confirmed: bool,
) -> List[CameraDevice]:
    """Pair OS-reported names to probed indices by position.

    Only done when the counts match. If the OS reports 3 cameras and we probed
    2, any pairing would be a guess dressed up as data — so we report no names
    at all and say why. A wrong name is worse than no name: it is the one thing
    that would make an operator confidently pick the wrong camera.
    """
    usable = [d for d in devices if d.usable]
    if not names:
        return [replace(d, name=None, name_source=source) for d in devices]
    if len(names) != len(usable):
        reason = (f"{len(names)} device name(s) reported by the OS but "
                  f"{len(usable)} working device(s) probed — cannot pair them "
                  f"safely, showing indices only. OS reported: "
                  f"{', '.join(names)}")
        return [replace(d, name=None, name_source=reason) for d in devices]

    by_index = {}
    for dev, name in zip(usable, names):
        by_index[dev.index] = name
    return [
        replace(d, name=by_index.get(d.index),
                name_confirmed=confirmed and d.index in by_index,
                name_source=source if d.index in by_index
                else "opened but not a working camera — not paired with a name")
        for d in devices
    ]


# ── environment summary, for the picker's header and the final report ────────
def environment_report() -> dict:
    """What this machine is and what OpenCV can do on it."""
    build = ""
    try:
        build = cv2.getBuildInformation()
    except Exception:  # pragma: no cover
        pass

    def _has(marker: str) -> Optional[bool]:
        for line in build.splitlines():
            if line.strip().startswith(marker):
                return "YES" in line.upper()
        return None

    return {
        "platform": platform.platform(),
        "system": platform.system(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "opencv": cv2.__version__,
        "backends_available": sorted(BACKENDS),
        "video_io": {
            "FFMPEG": _has("FFMPEG:"),
            "GStreamer": _has("GStreamer:"),
            "DirectShow": _has("DirectShow:"),
            "MediaFoundation": _has("Media Foundation:"),
            "AVFoundation": _has("AVFoundation:"),
            "V4L/V4L2": _has("v4l/v4l2:"),
        },
    }
