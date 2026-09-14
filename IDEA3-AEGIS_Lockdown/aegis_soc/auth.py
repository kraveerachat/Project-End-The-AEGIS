"""Pure desktop Admin authentication and in-memory session state.

Desktop authentication gates access to the Tkinter shell only. It never grants
or caches authorization for CUT, RESTORE, ARM, DISARM, or recovery actions.
"""

from __future__ import annotations

import hmac
import os
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from . import config

DEFAULT_ADMIN_ID = "admin"


def configured_admin_id(env: Mapping[str, str] | None = None) -> str:
    """Return the configured desktop Admin identifier.

    The identifier is not a secret. Production credential safety remains the
    responsibility of the existing profile/preflight layer; this helper never
    reads or persists the PIN itself.
    """

    values = os.environ if env is None else env
    return (values.get("AEGIS_ADMIN_ID") or DEFAULT_ADMIN_ID).strip()


def verify_admin_credentials(
    admin_id: str | None,
    pin: str | None,
    *,
    env: Mapping[str, str] | None = None,
    pin_verifier: Callable[[str | None], bool] | None = None,
) -> bool:
    """Verify both desktop Admin ID and the existing configured Admin PIN."""

    if not isinstance(admin_id, str) or not admin_id or not isinstance(pin, str) or not pin:
        return False
    expected_id = configured_admin_id(env)
    if not expected_id or not hmac.compare_digest(admin_id, expected_id):
        return False
    verifier = config.verify_pin if pin_verifier is None else pin_verifier
    return bool(verifier(pin))


@dataclass
class DesktopSession:
    """Process-memory-only authenticated desktop session metadata."""

    authenticated: bool = False
    admin_id: str | None = None
    authenticated_at: float | None = None

    def login(self, admin_id: str) -> None:
        if not isinstance(admin_id, str) or not admin_id:
            raise ValueError("admin_id is required")
        self.authenticated = True
        self.admin_id = admin_id
        self.authenticated_at = time.time()

    def logout(self) -> None:
        self.authenticated = False
        self.admin_id = None
        self.authenticated_at = None
