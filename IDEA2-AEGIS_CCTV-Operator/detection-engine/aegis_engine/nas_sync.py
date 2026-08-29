"""
NASSyncWorker — durable off-load of finalized segments to the Local NAS.

For every ~10-minute segment the recorder finalizes, this worker:

1. Computes a local checksum (SHA-256) up front.
2. Ensures the remote directory exists, then transfers the file with
   ``rsync`` (default) or ``scp`` via :mod:`subprocess`.
3. **Verifies** the copy landed intact — by re-hashing on the NAS over SSH
   (``checksum``) or comparing byte size (``size``). Unverified success is
   forbidden; a successful transfer exit code alone is never sufficient.
4. Deletes the local file **only if** verification passed.

Transfers are retried with exponential backoff. A segment that never verifies
is **kept on local disk** and logged loudly — we would rather run the edge disk
toward full and raise an operator alarm than silently lose footage.

Security / auth
---------------
Uses key-based SSH (``AEGIS_NAS_SSH_KEY`` or the agent/default key) with
``BatchMode=yes`` so a missing key fails fast instead of hanging on a password
prompt. No credentials are ever embedded in code or logs.

Windows note: ``ssh``/``scp`` ship with the OpenSSH client on Windows 10+;
``rsync`` requires WSL or Git-for-Windows. Set ``AEGIS_NAS_METHOD=scp`` on a
bare Windows host.
"""

from __future__ import annotations

import hashlib
import os
import queue
import shlex
import subprocess
import threading
from typing import List, Optional

from .config import EngineConfig
from .logging_setup import get_logger
from .metrics import MetricsRegistry
from .models import SegmentInfo, utc_now_iso

log = get_logger("NASSyncWorker")


class NASSyncWorker(threading.Thread):
    def __init__(
        self,
        config: EngineConfig,
        metrics: MetricsRegistry,
        stop_event: Optional[threading.Event] = None,
        monitor: Optional[object] = None,
    ) -> None:
        super().__init__(name="NASSyncWorker", daemon=True)
        self._cfg = config
        self._metrics = metrics
        self._stop_event = stop_event or threading.Event()
        self._queue: "queue.Queue[SegmentInfo]" = queue.Queue()
        self._pending = 0
        self._pending_lock = threading.Lock()
        # Optional MonitorClient — persist a `clips` row ONLY after a verified
        # transfer (see _finish_ok), never optimistically. Fails soft.
        self._monitor = monitor
        if not self._cfg.nas_enabled:
            self._metrics.on_nas_disabled()

    def stop(self) -> None:
        self._stop_event.set()

    # -- producer side (called from the recorder callback) -----------------
    def submit(self, info: SegmentInfo) -> None:
        """Queue a finalized segment for transfer. Thread-safe, non-blocking."""
        if not self._cfg.nas_enabled:
            self._metrics.on_nas_disabled()
            log.info("NAS disabled — leaving segment on local disk: %s", info.path)
            return
        with self._pending_lock:
            self._pending += 1
            self._metrics.on_nas_pending(self._pending)
        self._queue.put(info)

    # -- consumer thread ---------------------------------------------------
    def run(self) -> None:
        if not self._cfg.nas_enabled:
            self._metrics.on_nas_disabled()
            log.info("NAS integration disabled; local recordings will be retained")
            return
        log.info(
            "NAS worker started · %s → %s@%s:%s (verify=%s)",
            self._cfg.nas_method,
            self._cfg.nas_user,
            self._cfg.nas_host,
            self._cfg.nas_dest_dir,
            self._cfg.nas_verify,
        )
        try:
            while not self._stop_event.is_set():
                try:
                    info = self._queue.get(timeout=0.5)
                except queue.Empty:
                    continue
                try:
                    self._sync_one(info)
                finally:
                    with self._pending_lock:
                        self._pending = max(0, self._pending - 1)
                        self._metrics.on_nas_pending(self._pending)
        except Exception:  # pragma: no cover - defensive
            log.exception("unhandled error in NAS worker loop")
        finally:
            log.info("NAS worker stopped")

    # -- per-segment workflow ---------------------------------------------
    def _sync_one(self, info: SegmentInfo) -> None:
        path = info.path
        if not os.path.exists(path):
            log.warning("segment vanished before sync: %s", path)
            self._metrics.on_nas_result(ok=False, when_wall=utc_now_iso())
            return

        basename = os.path.basename(path)
        remote_path = f"{self._cfg.nas_dest_dir.rstrip('/')}/{basename}"

        local_hash = None
        if self._cfg.nas_verify == "checksum":
            local_hash = self._sha256(path)

        self._ensure_remote_dir()

        for attempt in range(1, self._cfg.nas_max_retries + 1):
            if self._stop_event.is_set():
                log.info("stop requested; leaving %s for next run", basename)
                return

            log.info("transferring %s (attempt %d/%d)",
                     basename, attempt, self._cfg.nas_max_retries)
            rc, out, err = self._transfer(path, remote_path)
            if rc != 0:
                log.warning("transfer of %s failed (rc=%d): %s",
                            basename, rc, (err or out)[:300])
                self._backoff(attempt)
                continue

            if self._verify(path, remote_path, local_hash):
                log.info("verified %s on NAS", basename)
                self._finish_ok(path, basename, info, remote_path)
                return
            log.warning("verification mismatch for %s; will retry", basename)
            self._backoff(attempt)

        log.error(
            "gave up syncing %s after %d attempts — KEPT on local disk for safety",
            basename, self._cfg.nas_max_retries,
        )
        self._metrics.on_nas_result(ok=False, when_wall=utc_now_iso())

    def _finish_ok(
        self, path: str, basename: str,
        info: "SegmentInfo", remote_path: str,
    ) -> None:
        self._metrics.on_nas_result(ok=True, when_wall=utc_now_iso())

        # Persist the clip row NOW — this line is reached only *after* the
        # sha256/size verification above passed, so stored_on_nas=True is never
        # optimistic. file_path is the verified location on the NAS. Fail-soft:
        # a DB write failure must not stop us from freeing local disk below.
        if self._monitor is not None:
            self._monitor.post_clip(
                camera_id=info.camera_id,
                started_at=info.started_wall,
                duration_sec=info.duration_s,
                file_path=remote_path,
                stored_on_nas=True,
            )

        if not self._cfg.nas_delete_after_sync:
            return
        try:
            os.remove(path)
            log.info("deleted local segment after verified sync: %s", basename)
        except OSError as exc:
            log.error("synced but could not delete local %s: %s", basename, exc)

    # -- transfer & verify primitives -------------------------------------
    def _transfer(self, local_path: str, remote_path: str):
        target = f"{self._cfg.nas_user}@{self._cfg.nas_host}:{remote_path}"
        if self._cfg.nas_method == "rsync":
            cmd = [
                "rsync", "-az", "--partial",
                f"--timeout={int(self._cfg.nas_transfer_timeout_s)}",
                "-e", self._ssh_transport(),
                local_path, target,
            ]
        else:  # scp
            cmd = ["scp"] + self._scp_opts() + [local_path, target]
        return self._run(cmd, timeout=self._cfg.nas_transfer_timeout_s)

    def _verify(self, local_path: str, remote_path: str, local_hash: Optional[str]) -> bool:
        mode = self._cfg.nas_verify
        if mode == "size":
            local_size = os.path.getsize(local_path)
            rc, out, _ = self._ssh_exec(f"stat -c %s {shlex.quote(remote_path)}")
            if rc != 0:
                return False
            try:
                return int(out.strip()) == local_size
            except ValueError:
                return False
        # checksum
        if local_hash is None:
            local_hash = self._sha256(local_path)
        rc, out, _ = self._ssh_exec(f"sha256sum {shlex.quote(remote_path)}")
        if rc != 0:
            # BusyBox NAS boxes may only have `sha256` — try a fallback.
            rc, out, _ = self._ssh_exec(f"sha256 -q {shlex.quote(remote_path)}")
            if rc != 0:
                log.warning("no sha256 tool on NAS; cannot checksum-verify")
                return False
        remote_hash = out.strip().split()[0] if out.strip() else ""
        return remote_hash == local_hash

    def _ensure_remote_dir(self) -> None:
        rc, _, err = self._ssh_exec(f"mkdir -p {shlex.quote(self._cfg.nas_dest_dir)}")
        if rc != 0:
            log.warning("could not ensure remote dir %s: %s",
                        self._cfg.nas_dest_dir, err[:200])

    # -- ssh/scp command construction -------------------------------------
    def _common_ssh_opts(self) -> List[str]:
        opts = [
            "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", f"ConnectTimeout=15",
        ]
        if self._cfg.nas_ssh_key:
            opts += ["-i", self._cfg.nas_ssh_key]
        return opts

    def _ssh_transport(self) -> str:
        """The `-e` value for rsync: a single 'ssh ...' string."""
        parts = ["ssh", "-p", str(self._cfg.nas_ssh_port)] + self._common_ssh_opts()
        return " ".join(shlex.quote(p) for p in parts)

    def _scp_opts(self) -> List[str]:
        return ["-P", str(self._cfg.nas_ssh_port)] + self._common_ssh_opts()

    def _ssh_exec(self, remote_cmd: str):
        host = f"{self._cfg.nas_user}@{self._cfg.nas_host}"
        cmd = ["ssh", "-p", str(self._cfg.nas_ssh_port)] + self._common_ssh_opts()
        cmd += [host, remote_cmd]
        return self._run(cmd, timeout=30.0)

    # -- subprocess & hashing helpers -------------------------------------
    @staticmethod
    def _sha256(path: str) -> str:
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()

    def _run(self, cmd: List[str], timeout: float):
        """Run a subprocess, returning (returncode, stdout, stderr). Never raises."""
        log.debug("exec: %s", " ".join(cmd))
        try:
            proc = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
                text=True,
            )
            return proc.returncode, proc.stdout or "", proc.stderr or ""
        except FileNotFoundError:
            return 127, "", f"executable not found: {cmd[0]}"
        except subprocess.TimeoutExpired:
            return 124, "", f"timeout after {timeout}s: {cmd[0]}"
        except Exception as exc:  # pragma: no cover - defensive
            return 1, "", f"{type(exc).__name__}: {exc}"

    def _backoff(self, attempt: int) -> None:
        delay = self._cfg.nas_retry_backoff_s * attempt
        self._stop_event.wait(delay)  # interruptible sleep
