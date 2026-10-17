"""Test-only driver: runs the Core status push client once with a hostname->address map and no other change.

The map lets an isolated test resolve a certificate hostname to loopback without touching /etc/hosts or DNS. It is
never part of the shipped client and is read only from AEGIS_TEST_HOST_MAP. AEGIS_TEST_SIDECAR_ROOT makes it run the built sidecar package.
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

_sidecar = os.environ.get("AEGIS_TEST_SIDECAR_ROOT")
if _sidecar:
    # Prove the BUILT package is what runs: import only from its root and refuse if any Core module or a checkout copy was loaded.
    sys.path.insert(0, _sidecar)

from tools import status_push_client

if _sidecar:
    _forbidden = [m for m in sys.modules if m in {"aegis_soc.runtime", "aegis_soc.controller", "aegis_soc.mqtt_client", "paho"}]
    _outside = [m.__file__ for m in (status_push_client, sys.modules["aegis_soc.observer"]) if not m.__file__.startswith(_sidecar)]
    if _forbidden or _outside:
        print(f"sidecar isolation violated: {_forbidden} {_outside}", file=sys.stderr)
        sys.exit(99)

sys.exit(status_push_client.main(["--once"]))
