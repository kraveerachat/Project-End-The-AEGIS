"""Cross-platform exclusive lock behavior used by Core and the launcher."""

import errno
import os

import pytest

from aegis_soc.platform_lock import (
    LOCK_BYTE_OFFSET,
    AlreadyRunningError,
    ExclusiveFileLock,
)


def test_second_lock_owner_is_rejected(tmp_path):
    path = tmp_path / "runtime" / "aegis.lock"
    first = ExclusiveFileLock(path, "first-owner")
    second = ExclusiveFileLock(path, "second-owner")

    first.acquire()
    try:
        with pytest.raises(AlreadyRunningError, match="holds the runtime lock"):
            second.acquire()
    finally:
        first.release()


def test_released_lock_can_be_reacquired(tmp_path):
    path = tmp_path / "aegis.lock"
    first = ExclusiveFileLock(path, "first-owner")
    second = ExclusiveFileLock(path, "second-owner")

    first.acquire()
    first.release()
    second.acquire()
    second.release()


def test_lock_creates_parent_and_records_only_owner_text(tmp_path):
    path = tmp_path / "nested" / "aegis.lock"
    lock = ExclusiveFileLock(path, "pid=4321")

    lock.acquire()
    try:
        assert path.read_text(encoding="utf-8") == "pid=4321\n"
    finally:
        lock.release()


def test_release_is_idempotent(tmp_path):
    lock = ExclusiveFileLock(tmp_path / "aegis.lock", "owner")

    lock.acquire()
    lock.release()
    lock.release()


def test_windows_backend_uses_nonblocking_one_byte_lock(tmp_path):
    calls = []

    class FakeMsvcrt:
        LK_NBLCK = 2
        LK_UNLCK = 0

        @staticmethod
        def locking(fd, mode, count):
            calls.append((fd, mode, count))

    lock = ExclusiveFileLock(
        tmp_path / "aegis.lock",
        "owner",
        platform="win32",
        module_loader=lambda name: FakeMsvcrt if name == "msvcrt" else None,
    )

    lock.acquire()
    lock.release()

    assert [(mode, count) for _, mode, count in calls] == [(2, 1), (0, 1)]


def test_windows_contention_maps_to_already_running(tmp_path):
    class BusyMsvcrt:
        LK_NBLCK = 2
        LK_UNLCK = 0

        @staticmethod
        def locking(_fd, mode, _count):
            if mode == BusyMsvcrt.LK_NBLCK:
                raise OSError(errno.EACCES, "locked")

    lock = ExclusiveFileLock(
        tmp_path / "aegis.lock",
        "owner",
        platform="win32",
        module_loader=lambda _name: BusyMsvcrt,
    )

    with pytest.raises(AlreadyRunningError):
        lock.acquire()


def test_owner_text_cannot_inject_additional_lock_lines(tmp_path):
    with pytest.raises(ValueError, match="single non-empty line"):
        ExclusiveFileLock(tmp_path / "aegis.lock", "pid=1\nsecret=value")


def test_owner_text_stays_readable_by_another_handle_while_locked(tmp_path):
    """The lock file must identify its owner to anyone inspecting it.

    On POSIX flock is advisory so this always held. On Windows msvcrt.locking is a
    mandatory byte-range lock, so locking byte 0 made the owner line unreadable and
    raised PermissionError. The locked byte must therefore sit outside the content.
    """
    path = tmp_path / "aegis.lock"
    lock = ExclusiveFileLock(path, "pid=4321")

    lock.acquire()
    try:
        with open(path, "rb") as independent:
            assert independent.read().decode("utf-8") == "pid=4321\n"
    finally:
        lock.release()


def test_windows_backend_locks_a_reserved_byte_outside_the_owner_text(tmp_path):
    offsets = []

    class RecordingMsvcrt:
        LK_NBLCK = 2
        LK_UNLCK = 0

        @staticmethod
        def locking(fd, mode, count):
            offsets.append((mode, os.lseek(fd, 0, os.SEEK_CUR), count))

    lock = ExclusiveFileLock(
        tmp_path / "aegis.lock",
        "pid=4321",
        platform="win32",
        module_loader=lambda _name: RecordingMsvcrt,
    )

    lock.acquire()
    lock.release()

    assert [mode for mode, _offset, _count in offsets] == [2, 0]
    for _mode, offset, count in offsets:
        assert count == 1
        assert offset >= LOCK_BYTE_OFFSET
        assert offset > len("pid=4321\n")
    # Both acquire and release must contend on the same reserved byte.
    assert offsets[0][1] == offsets[1][1]


def test_reserved_lock_byte_does_not_grow_the_lock_file(tmp_path):
    """Seeking to the reserved offset must not extend or sparsely inflate the file."""
    path = tmp_path / "aegis.lock"

    class NoopMsvcrt:
        LK_NBLCK = 2
        LK_UNLCK = 0

        @staticmethod
        def locking(_fd, _mode, _count):
            return None

    lock = ExclusiveFileLock(
        path, "pid=4321", platform="win32", module_loader=lambda _name: NoopMsvcrt
    )

    lock.acquire()
    try:
        assert path.stat().st_size == len("pid=4321\n")
    finally:
        lock.release()

    assert path.stat().st_size == len("pid=4321\n")
    assert path.read_text(encoding="utf-8") == "pid=4321\n"
