"""AEGIS IDEA3 PR11 Phase 4 — L7u runtime contract for the Core-mediated Recovery channel (repository-only, hermetic).

Covers the facts the L7u design depends on: the UMask 0077 trap, the pre-provisioned directory, the socket ownership/mode contract, and
that the dedicated group is a transport mechanism only (SO_PEERCRED stays the authority). No broker, device or network listener is opened.
"""

from __future__ import annotations

import inspect
import os
import re
import shutil
import socket
import tempfile
from pathlib import Path

from test_core_recovery_security import _exchange, credential, env, served  # noqa: F401  (pytest fixtures)

from aegis_soc import recovery_core, supervisor
from aegis_soc import recovery_protocol as rp

ROOT = Path(__file__).resolve().parents[1]


def test_the_default_socket_path_is_the_l7u_runtime_directory_socket() -> None:
    assert rp.DEFAULT_SOCKET_PATH == "/run/aegis-idea3-recovery/recovery.sock"


def test_umask_0077_makes_an_application_created_directory_untraversable_by_the_operator_group(tmp_path: Path, served) -> None:  # noqa: F811
    """The hazard L7u closes: the Core unit runs with UMask=0077, so `mkdir(mode=0o755)` yields 0700 and the operator cannot traverse."""
    old = os.umask(0o077)
    try:
        target = tmp_path / "app-made" / "recovery.sock"
        server = recovery_core.RecoveryServer(target, served.service, allowed_uid=os.geteuid(), socket_gid=os.getegid())
        server.start()
        try:
            mode = target.parent.stat().st_mode & 0o777
        finally:
            server.close()
    finally:
        os.umask(old)
    assert mode == 0o700 and mode & 0o050 == 0  # group cannot traverse: this is why L7u must pre-provision the directory


def test_a_pre_provisioned_0750_directory_survives_the_core_umask_and_keeps_its_mode(tmp_path: Path, served) -> None:  # noqa: F811
    directory = Path(tempfile.mkdtemp(prefix="aegis-l7u-"))
    try:
        directory.chmod(0o750)
        old = os.umask(0o077)
        try:
            server = recovery_core.RecoveryServer(directory / "recovery.sock", served.service, allowed_uid=os.geteuid(), socket_gid=os.getegid())
            server.start()
            try:
                assert (directory.stat().st_mode & 0o777) == 0o750
                metadata = (directory / "recovery.sock").stat()
                assert (metadata.st_mode & 0o777) == 0o660 and metadata.st_gid == os.getegid()
            finally:
                server.close()
        finally:
            os.umask(old)
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def test_the_application_never_widens_a_pre_provisioned_directory(served) -> None:  # noqa: F811
    source = inspect.getsource(recovery_core.RecoveryServer._prepare_path)
    assert "chmod" not in source and "chown" not in source  # only mkdir(exist_ok=True); an existing 0750 directory is kept as provisioned


def test_group_membership_is_transport_only_so_a_reachable_socket_still_refuses_the_wrong_uid(served) -> None:  # noqa: F811
    """The dedicated group makes the socket REACHABLE (0660 + group); authorization is still the SO_PEERCRED uid check."""
    server = served.start(allowed_uid=os.geteuid() + 1, socket_gid=os.getegid(), deadline=5.0)
    metadata = Path(server.path).stat()
    assert (metadata.st_mode & 0o777) == 0o660 and metadata.st_gid == os.getegid()
    reply, elapsed = _exchange(server.path, wait=1.5)  # sends ZERO bytes
    assert reply is not None and (reply["ok"], reply["code"]) == (False, "PEER_REFUSED")
    assert elapsed < 1.0 and served.containment.calls == []


def test_peer_credentials_are_read_before_any_request_byte_even_on_a_group_reachable_socket() -> None:
    source = inspect.getsource(recovery_core.RecoveryServer)
    handle = source[source.index("def _read_and_handle"):]
    assert handle.index("_peer_from(connection)") < handle.index("connection.recv")


def test_the_server_is_unix_only_with_no_network_listener() -> None:
    text = Path(recovery_core.__file__).read_text()
    assert "AF_UNIX" in text and not re.search(r"AF_INET|AF_INET6|0\.0\.0\.0|\.listen\(\s*\)|bind\(\(", text)
    assert recovery_core.RecoveryServer.family == socket.AF_UNIX


def test_the_supervisor_passes_the_configured_uid_and_gid_and_never_a_default_gid() -> None:
    source = inspect.getsource(supervisor.AegisSupervisor.start_recovery)
    assert "allowed_uid=operator_uid" in source and "socket_gid=config.RECOVERY_SOCKET_GID" in source
    assert "RECOVERY_OPERATOR_UID" in source and "operator_uid is None" in source  # without the uid the channel stays disabled


def test_the_observer_ui_remains_unprivileged() -> None:
    text = (ROOT / "aegis_soc" / "recovery_ui.py").read_text()
    assert not re.search(r"^(import|from)\s+(aegis_soc\.)?(database|mqtt_client|controller|telegram|local_restore)", text, re.MULTILINE)
