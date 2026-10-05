#!/usr/bin/env python3
"""AEGIS Drive (IDEA1) - multi-file streaming ZIP acceptance verifier (spec section 24).

Archive mode (Python zipfile is a REQUIRED reader):
    python verify_zip.py ARCHIVE [--manifest MANIFEST] [--inspect-offset-only NAME]
      - testzip() must return None, then extractall() must succeed;
      - with --manifest: the multiset of extracted SHA-256 values must equal the manifest's;
      - with --inspect-offset-only NAME: that entry must be a real offset-only ZIP64 entry
        (local header offset >= 0xFFFFFFFF, sizes < 0xFFFFFFFF, central offset field 0xFFFFFFFF,
        central ZIP64 extra holding ONLY the 8-byte offset, version needed 45).

Extracted mode (folders produced by Windows Explorer or macOS Archive Utility):
    python verify_zip.py --extracted DIR MANIFEST

Exit code 0 = PASS, 1 = FAIL. Nothing here talks to AEGIS.
"""
import hashlib
import json
import os
import struct
import sys
import tempfile
import zipfile

U32 = 0xFFFFFFFF


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def manifest_hashes(manifest_path):
    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)
    return sorted(entry["sha256"] for entry in manifest["files"])


def fail(message):
    print(f"FAIL: {message}")
    return 1


def check_archive(archive, manifest_path):
    with zipfile.ZipFile(archive) as z:
        bad = z.testzip()
        if bad is not None:
            return fail(f"testzip() reported {bad!r}")
        with tempfile.TemporaryDirectory() as out:
            z.extractall(out)
            hashes = sorted(sha256_file(os.path.join(out, info.filename)) for info in z.infolist())
        names = [info.filename for info in z.infolist()]
    if manifest_path is not None:
        expected = manifest_hashes(manifest_path)
        if hashes != expected:
            return fail(f"extracted SHA-256 values differ from the manifest ({len(hashes)} vs {len(expected)} entries)")
    print(f"PASS: {len(names)} entries extracted byte-exact")
    return 0


def central_record(archive, z, name):
    """Raw central-directory record of `name` (scanned from zipfile's start_dir)."""
    with open(archive, "rb") as f:
        f.seek(z.start_dir)
        for _ in z.infolist():
            fixed = f.read(46)
            if fixed[:4] != b"PK\x01\x02":
                raise ValueError("central directory signature missing")
            n, x, c = struct.unpack("<HHH", fixed[28:34])
            fname = f.read(n)
            extra = f.read(x)
            f.read(c)
            flags = struct.unpack("<H", fixed[8:10])[0]
            decoded = fname.decode("utf-8" if flags & 0x800 else "cp437")
            if decoded == name:
                return fixed, extra
    raise KeyError(name)


def inspect_offset_only(archive, name):
    with zipfile.ZipFile(archive) as z:
        try:
            info = z.getinfo(name)
        except KeyError:
            return fail(f"no entry named {name!r}")
        fixed, extra = central_record(archive, z, name)
    version_needed = struct.unpack("<H", fixed[6:8])[0]
    comp, uncomp = struct.unpack("<II", fixed[20:28])
    offset_field = struct.unpack("<I", fixed[42:46])[0]
    problems = []
    if info.header_offset < U32:
        problems.append(f"local header offset {info.header_offset} < 0xFFFFFFFF")
    if info.file_size >= U32 or info.compress_size >= U32:
        problems.append("sizes overflow (this is size-ZIP64, not offset-only)")
    if comp != info.compress_size or uncomp != info.file_size:
        problems.append("central size fields do not hold the real 32-bit sizes")
    if offset_field != U32:
        problems.append(f"central offset field is {offset_field:#x}, expected 0xFFFFFFFF")
    if version_needed != 45:
        problems.append(f"version needed is {version_needed}, expected 45")
    z64 = None
    p = 0
    while p + 4 <= len(extra):
        tag, size = struct.unpack("<HH", extra[p:p + 4])
        if tag == 0x0001:
            z64 = extra[p + 4:p + 4 + size]
        p += 4 + size
    if z64 is None:
        problems.append("no ZIP64 extra (0x0001)")
    elif len(z64) != 8 or struct.unpack("<Q", z64)[0] != info.header_offset:
        problems.append(f"ZIP64 extra must hold only the 8-byte offset (data size {len(z64)})")
    if problems:
        return fail("; ".join(problems))
    print(f"PASS: {name} is offset-only ZIP64 at {info.header_offset}")
    return 0


def check_extracted(folder, manifest_path):
    hashes = []
    for dirpath, _dirs, files in os.walk(folder):
        for fn in files:
            hashes.append(sha256_file(os.path.join(dirpath, fn)))
    expected = manifest_hashes(manifest_path)
    if sorted(hashes) != expected:
        return fail(f"extracted folder differs from the manifest ({len(hashes)} files vs {len(expected)})")
    print(f"PASS: {len(hashes)} extracted files match the manifest")
    return 0


def main(argv):
    if argv[:1] == ["--extracted"] and len(argv) == 3:
        return check_extracted(argv[1], argv[2])
    if not argv or argv[0].startswith("--"):
        print(__doc__)
        return 2
    archive = argv[0]
    manifest = None
    offset_name = None
    i = 1
    while i < len(argv):
        if argv[i] == "--manifest":
            manifest = argv[i + 1]
            i += 2
        elif argv[i] == "--inspect-offset-only":
            offset_name = argv[i + 1]
            i += 2
        else:
            print(__doc__)
            return 2
    try:
        if offset_name is not None:
            return inspect_offset_only(archive, offset_name)
        return check_archive(archive, manifest)
    except (zipfile.BadZipFile, OSError, ValueError) as err:
        return fail(str(err))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
