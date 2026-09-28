#!/usr/bin/env python3
"""L7 broker TLS-hostname probe (read-only, handshake only). Authority: L7 operational design OD-L7-04/05, 2026-09-27 amendments.

Proves, BEFORE the Core is started, that the Core's real TLS code path can verify the L6 broker: it builds the Core's own verifying
context (pinned CA, TLS 1.2 minimum, hostname check ON) with ``--server-name`` (the DNS name in the broker certificate, which has no IP
SAN) and completes a TLS handshake to the AP broker address on the given port. It sends no application bytes: no credentials are read
or used and no protocol packet is written, so it cannot change any broker or Core state. Plaintext port 1883 is refused.
Output is one stable line: ``L7_BROKER_TLS_PROBE=PASS tls=<version>`` or ``L7_BROKER_TLS_PROBE=FAIL reason=<CODE>``.
"""

from __future__ import annotations

import argparse
import socket
import ssl
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    tls = sub.add_parser("tls")
    tls.add_argument("--repo-root", required=True)
    tls.add_argument("--ca-file", required=True)
    tls.add_argument("--address", required=True)
    tls.add_argument("--port", type=int, required=True)
    tls.add_argument("--server-name", required=True)
    args = parser.parse_args()
    if args.port == 1883 or not (1 <= args.port <= 65535):
        print("plaintext or invalid port refused", file=sys.stderr)
        return 2
    sys.path.insert(0, args.repo_root)
    try:
        from aegis_soc.mqtt_client import build_mqtt_ssl_context

        context = build_mqtt_ssl_context(args.ca_file, server_name=args.server_name)
    except (OSError, ValueError, ssl.SSLError):
        print("L7_BROKER_TLS_PROBE=FAIL reason=CONTEXT_INVALID")
        return 1
    try:
        raw = socket.create_connection((args.address, args.port), timeout=5)
    except OSError:
        print("L7_BROKER_TLS_PROBE=FAIL reason=NO_LISTENER")
        return 1
    try:
        with context.wrap_socket(raw, server_hostname=args.address) as wrapped:
            version = wrapped.version() or "UNKNOWN"
    except ssl.SSLCertVerificationError:
        print("L7_BROKER_TLS_PROBE=FAIL reason=TLS_VERIFY_FAILED")
        return 1
    except (OSError, ssl.SSLError):
        print("L7_BROKER_TLS_PROBE=FAIL reason=TLS_HANDSHAKE_FAILED")
        return 1
    finally:
        raw.close()
    print(f"L7_BROKER_TLS_PROBE=PASS tls={version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
