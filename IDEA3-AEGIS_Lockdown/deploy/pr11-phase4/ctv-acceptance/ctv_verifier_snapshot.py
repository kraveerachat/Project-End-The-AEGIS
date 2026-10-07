#!/usr/bin/env python3
"""Named CTv control-snapshot namespace; implementation is repository-only."""
from pathlib import Path
import hashlib

def manifest_sha256(path: Path) -> str:
    if path.is_symlink() or not path.is_file():
        raise ValueError("CTV_CONTROL_MANIFEST_INVALID")
    return hashlib.sha256(path.read_bytes()).hexdigest()
