"""Shared YOLO tensor/geometry helpers for the hybrid recognizer.

YOLO supplies candidate regions only. This module intentionally exposes no
recognizer capable of returning ``Authorized`` because a one-class object
detector cannot establish identity. ``YoloSFaceAdminRecognizer`` reuses these
helpers and requires an SFace template match before authorizing a face.
"""

from __future__ import annotations

def _numpy(value):
    """Convert Torch/Ultralytics tensors without coupling tests to Torch."""
    for method in ("detach", "cpu"):
        fn = getattr(value, method, None)
        if fn is not None:
            value = fn()
    fn = getattr(value, "numpy", None)
    return fn() if fn is not None else value


def _same_face(first, second) -> bool:
    """Match Haar and YOLO boxes without assuming identical crop sizes."""
    ax, ay, aw, ah = first
    bx, by, bw, bh = second
    left, top = max(ax, bx), max(ay, by)
    right, bottom = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    intersection = max(0, right - left) * max(0, bottom - top)
    smaller_area = max(1, min(aw * ah, bw * bh))
    if intersection / smaller_area >= 0.35:
        return True
    centre_x, centre_y = ax + aw / 2, ay + ah / 2
    return bx <= centre_x <= bx + bw and by <= centre_y <= by + bh
