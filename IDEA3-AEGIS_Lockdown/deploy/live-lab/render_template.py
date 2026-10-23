#!/usr/bin/env python3
"""Render one live-lab template: ``render_template.py SRC DST``.

Replaces ``<AEGIS_*>`` placeholders (the repository's deploy/ examples) and ``@NAME@`` placeholders (live-lab templates)
from LL_* environment variables. The AP passphrase is read from the file named by LL_AP_PSK_FILE and is never printed.
DST is written mode 0600. Any placeholder left unresolved is an error.
"""

from __future__ import annotations

import os
import re
import sys

ANGLE = {
    "<AEGIS_AP_INTERFACE>": "LL_AP_IFACE",
    "<AEGIS_AP_CHANNEL>": "LL_AP_CHANNEL",
    "<AEGIS_AP_SSID>": "LL_AP_SSID",
    "<AEGIS_AP_ADDRESS>": "LL_AP_ADDR",
    "<AEGIS_AP_PREFIXLEN>": "LL_AP_PREFIXLEN",
    "<AEGIS_AP_NETMASK>": "LL_AP_NETMASK",
    "<AEGIS_AP_SUBNET>": "LL_AP_SUBNET",
    "<AEGIS_DHCP_START>": "LL_DHCP_START",
    "<AEGIS_DHCP_END>": "LL_DHCP_END",
    "<AEGIS_BROKER_HOSTNAME>": "LL_BROKER_HOSTNAME",
    "<AEGIS_MQTT_PASSWORD_FILE>": "LL_MQTT_PASSWD_FILE",
    "<AEGIS_MQTT_ACL_FILE>": "LL_MQTT_ACL_FILE",
    "<AEGIS_MQTT_CA_FILE>": "LL_CA_FILE",
    "<AEGIS_MQTT_CERT_FILE>": "LL_CERT_FILE",
    "<AEGIS_MQTT_KEY_FILE>": "LL_KEY_FILE",
    "<AEGIS_TRUSTED_NTP_UPSTREAM>": "LL_NTP_UPSTREAM",
}


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: render_template.py SRC DST", file=sys.stderr)
        return 2
    src, dst = argv[1], argv[2]
    with open(src, encoding="utf-8") as handle:
        text = handle.read()
    for token, var in ANGLE.items():
        if token in text:
            value = os.environ.get(var)
            if not value:
                print(f"render: {var} is not set (needed for {token})", file=sys.stderr)
                return 1
            text = text.replace(token, value)
    if "<AEGIS_AP_PSK>" in text:
        with open(os.environ["LL_AP_PSK_FILE"], encoding="utf-8") as handle:
            psk = handle.read().strip()
        if not 8 <= len(psk) <= 63 or not psk.isprintable():
            print("render: the AP passphrase file must hold 8-63 printable characters", file=sys.stderr)
            return 1
        text = text.replace("<AEGIS_AP_PSK>", psk)
    for name in set(re.findall(r"@([A-Z0-9_]+)@", text)):
        value = os.environ.get(f"LL_{name}")
        if value is None:
            print(f"render: LL_{name} is not set (needed for @{name}@)", file=sys.stderr)
            return 1
        text = text.replace(f"@{name}@", value)
    code_lines = [ln for ln in text.splitlines() if not ln.lstrip().startswith("#")]
    left = sorted(set(re.findall(r"<AEGIS_[A-Z_]+>", "\n".join(code_lines))))
    if left:
        print(f"render: unresolved placeholders: {', '.join(left)}", file=sys.stderr)
        return 1
    fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as out:
        out.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
