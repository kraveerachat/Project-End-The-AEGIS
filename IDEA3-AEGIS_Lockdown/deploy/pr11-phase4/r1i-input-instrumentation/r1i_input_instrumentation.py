#!/usr/bin/env python3
"""Repository-only R1I input instrumentation builder and state validator.

This module intentionally knows nothing about P4_STAGES and has no live side
effects.  The shell handlers own the explicit mutation boundary.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import re
import sys
from pathlib import Path

TABLE = "aegis_idea3_r1i"
FAMILY = "inet"
PRIORITY = -10
PREFIX = "AEGIS_NEWCONN "
RATE = "50/second"
RATE_PER_SECOND = 50
BURST = 60
SYN_THRESHOLD = 20
SYN_WINDOW_SECONDS = 2
PORTSCAN_THRESHOLD = 10
PORTSCAN_WINDOW_SECONDS = 10
INITIAL_SYN = "tcp flags & (syn | ack) == syn"
RULE = f'ct state new {INITIAL_SYN} limit rate {RATE} burst {BURST} packets log prefix "{PREFIX}" level info'
STANDARD_PRIORITY_BOUNDARIES = frozenset({-300, -200, -150, -100, 0, 50, 100})

EXPECTED = f'''table {FAMILY} {TABLE} {{
    chain input {{
        type filter hook input priority {PRIORITY}; policy accept;
        {RULE}
    }}
    chain forward {{
        type filter hook forward priority {PRIORITY}; policy accept;
        {RULE}
    }}
}}
'''

VERDICTS = re.compile(r"\b(accept|drop|reject|queue|return|jump|goto|continue)\b", re.I)


class R1IError(ValueError):
    pass


def render(path: Path) -> None:
    path.write_text(EXPECTED, encoding="utf-8")


def validate_text(text: str) -> None:
    if text != EXPECTED:
        raise R1IError("RENDERED_NFT_NOT_EXACT")
    rules_only = "\n".join(line for line in text.splitlines() if "policy accept" not in line)
    if VERDICTS.search(rules_only):
        raise R1IError("OWNED_RULE_CONTAINS_VERDICT")
    if text.count(f"priority {PRIORITY};") != 2 or PRIORITY in STANDARD_PRIORITY_BOUNDARIES:
        raise R1IError("HOOK_PRIORITY_INVALID")
    if text.count(f'log prefix "{PREFIX}"') != 2:
        raise R1IError("LOG_PREFIX_INVALID")
    if "AEGIS_NEWCONN" not in text or "SRC=" in text or "DPT=" in text:
        # SRC/DPT are emitted by the kernel log formatter, not hard-coded in nft.
        raise R1IError("KERNEL_LOG_PAYLOAD_CONTRACT_INVALID")
    if "P4_STAGES" in text or "blocked_ipv4" in text or "aegis_idea3 " in text:
        raise R1IError("FOREIGN_CONTAINMENT_SURFACE_REFERENCED")


def validate_state(text: str) -> None:
    """Validate nft's rendered state without requiring byte-for-byte formatting."""
    if f"table {FAMILY} {TABLE}" not in text:
        raise R1IError("TABLE_IDENTITY_INVALID")
    rules_only = "\n".join(line for line in text.splitlines() if "policy accept" not in line)
    if VERDICTS.search(rules_only):
        raise R1IError("OWNED_RULE_CONTAINS_VERDICT")
    for hook in ("input", "forward"):
        match = re.search(rf"chain {hook} \{{.*?type filter hook {hook} priority (-?\d+|[A-Za-z]+);", text, re.S)
        if not match or match.group(1) != str(PRIORITY):
            raise R1IError(f"{hook.upper()}_HOOK_INVALID")
    if text.count(f'log prefix "{PREFIX}"') != 2:
        raise R1IError("LOG_PREFIX_INVALID")
    if text.count(f"ct state new {INITIAL_SYN}") != 2 or text.count(f"limit rate {RATE} burst {BURST} packets") != 2:
        raise R1IError("RULE_OR_RATE_INVALID")


def validate_live_dump(text: str) -> dict[str, int | str]:
    """Read-only proof of the supplied live nft dump's ordering facts."""
    if not text or "table inet aegis_idea3 {" not in text:
        raise R1IError("LIVE_L2_TABLE_MISSING")
    input_match = re.search(r"chain input \{.*?priority ([^;]+);", text, re.S)
    forward_match = re.search(r"chain forward \{.*?priority ([^;]+);", text, re.S)
    if not input_match or not forward_match:
        raise R1IError("LIVE_HOOK_PRIORITY_UNREADABLE")
    if input_match.group(1).strip() != "filter" or forward_match.group(1).strip() != "filter":
        raise R1IError("LIVE_HOOK_PRIORITY_UNEXPECTED")
    if "ip saddr @blocked_ipv4 drop" not in text:
        raise R1IError("LIVE_CONTAINMENT_DROP_UNREADABLE")
    if not (PRIORITY < 0) or PRIORITY in STANDARD_PRIORITY_BOUNDARIES:
        raise R1IError("PROPOSED_PRIORITY_INVALID")
    return {"input_priority": 0, "forward_priority": 0, "proposed_priority": PRIORITY}


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def valid_source(value: str) -> bool:
    try:
        ipaddress.IPv4Address(value)
        return True
    except ipaddress.AddressValueError:
        return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    p_render = sub.add_parser("render")
    p_render.add_argument("path", type=Path)
    p_validate = sub.add_parser("validate")
    p_validate.add_argument("path", type=Path)
    p_state = sub.add_parser("validate-state")
    p_state.add_argument("path", type=Path)
    p_live = sub.add_parser("validate-live")
    p_live.add_argument("path", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "render":
            render(args.path)
        elif args.command == "validate":
            validate_text(args.path.read_text(encoding="utf-8"))
            print(f"R1I_RENDER=PASS sha256={digest(args.path.read_text(encoding='utf-8'))}")
        elif args.command == "validate-state":
            validate_state(args.path.read_text(encoding="utf-8"))
            print("R1I_STATE=PASS")
        else:
            print(validate_live_dump(args.path.read_text(encoding="utf-8")))
    except (OSError, R1IError) as exc:
        print(f"R1I_TOOL=FAIL reason={exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
