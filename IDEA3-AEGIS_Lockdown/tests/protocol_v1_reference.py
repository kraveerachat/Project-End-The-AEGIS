"""Spec-literal Protocol v1 reference used only to generate and check golden vectors.

This module deliberately does not import ``aegis_soc``. It implements the design
(§4.3 wire grammar, §4.5 signing input) directly, so the production codec is
never used to certify itself.
"""

from __future__ import annotations

import hashlib
import hmac
import struct
from collections.abc import Sequence

LABEL = b"AEGIS-IDEA3-PROTOCOL"
C2D = b"CORE_TO_DEVICE"
D2C = b"DEVICE_TO_CORE"
DOMAIN = {"COMMAND": C2D, "HEARTBEAT": C2D, "ACK": D2C, "STATUS": D2C}


def lp(data: bytes) -> bytes:
    """uint32 big-endian length prefix followed by the bytes themselves."""
    return struct.pack(">I", len(data)) + data


def signing_input(domain: bytes, topic: str, elements: Sequence[str]) -> bytes:
    out = lp(LABEL) + lp(domain) + lp(topic.encode("ascii"))
    for element in elements:
        out += lp(element.encode("ascii"))
    return out


def mac(key: bytes, domain: bytes, topic: str, elements: Sequence[str]) -> str:
    return hmac.new(key, signing_input(domain, topic, elements), hashlib.sha256).hexdigest()


def wire(version_text: str, strings: Sequence[str]) -> bytes:
    """Serialize exactly as the §4.3 grammar: no whitespace, strings verbatim."""
    return ("[" + version_text + "".join(f',"{text}"' for text in strings) + "]").encode("ascii")
