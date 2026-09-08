"""Cross-platform exclusive lock behavior used by Core and the launcher."""

import errno

import pytest

from aegis_soc.platform_lock import AlreadyRunningError, ExclusiveFileLock


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
