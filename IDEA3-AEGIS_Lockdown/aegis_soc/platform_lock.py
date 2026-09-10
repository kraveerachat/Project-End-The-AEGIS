"""Exclusive file locking without importing platform-only modules eagerly."""

from __future__ import annotations

import errno
import importlib
import sys
from collections.abc import Callable
from pathlib import Path
from types import ModuleType
from typing import BinaryIO

# Windows msvcrt.locking is a MANDATORY byte-range lock: any byte it covers becomes
# unreadable to other handles. POSIX flock is advisory and whole-file. To give both
# platforms the same observable contract - exclusive ownership plus an owner line
# that stays readable while the lock is held - Windows locks a single reserved byte
# far beyond the owner text instead of byte 0.
LOCK_BYTE_OFFSET = 1 << 30


class AlreadyRunningError(RuntimeError):
    """Raised when another process owns an AEGIS runtime lock."""


class ExclusiveFileLock:
    """Hold one OS-managed nonblocking lock for the lifetime of this object."""

    def __init__(
        self,
        path: Path,
        owner_text: str,
        *,
        platform: str | None = None,
        module_loader: Callable[[str], ModuleType] = importlib.import_module,
    ) -> None:
        if not owner_text or "\n" in owner_text or "\r" in owner_text:
            raise ValueError("lock owner must be a single non-empty line")
        self.path = path
        self.owner_text = owner_text
        self.platform = sys.platform if platform is None else platform
        self.module_loader = module_loader
        self._handle: BinaryIO | None = None
        self._platform_module: ModuleType | None = None

    def _lock(self, handle: BinaryIO) -> None:
        if self.platform == "win32":
            module = self.module_loader("msvcrt")
            handle.seek(LOCK_BYTE_OFFSET)
            module.locking(handle.fileno(), module.LK_NBLCK, 1)
        else:
            module = self.module_loader("fcntl")
            handle.seek(0)
            module.flock(handle.fileno(), module.LOCK_EX | module.LOCK_NB)
        self._platform_module = module

    def acquire(self) -> None:
        if self._handle is not None:
            raise RuntimeError("runtime lock is already acquired by this object")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+b")
        try:
            self._lock(handle)
        except OSError as exc:
            handle.close()
            if isinstance(exc, BlockingIOError) or exc.errno in {errno.EACCES, errno.EAGAIN}:
                raise AlreadyRunningError(
                    "another AEGIS process holds the runtime lock"
                ) from exc
            raise

        handle.seek(0)
        handle.truncate()
        handle.write(f"{self.owner_text}\n".encode())
        handle.flush()
        self._handle = handle

    def release(self) -> None:
        handle = self._handle
        if handle is None:
            return
        self._handle = None
        module = self._platform_module
        self._platform_module = None
        try:
            if self.platform == "win32":
                handle.seek(LOCK_BYTE_OFFSET)
                module.locking(handle.fileno(), module.LK_UNLCK, 1)
            else:
                handle.seek(0)
                module.flock(handle.fileno(), module.LOCK_UN)
        finally:
            handle.close()
