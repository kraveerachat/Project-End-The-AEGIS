"""Test-only driver: runs the Core status push client once with a hostname->address map and no other change.

The map lets an isolated test resolve a certificate hostname to loopback without touching /etc/hosts or DNS. It is
never part of the shipped client and is read only from AEGIS_TEST_HOST_MAP.
"""

from __future__ import annotations

import os
import socket
import sys

_mapping = dict(item.split("=", 1) for item in os.environ.get("AEGIS_TEST_HOST_MAP", "").split(",") if item)
_real_getaddrinfo = socket.getaddrinfo


def _patched(host, *args, **kwargs):
    return _real_getaddrinfo(_mapping.get(host, host), *args, **kwargs)


socket.getaddrinfo = _patched

from tools import status_push_client  # noqa: E402

sys.exit(status_push_client.main(["--once"]))
