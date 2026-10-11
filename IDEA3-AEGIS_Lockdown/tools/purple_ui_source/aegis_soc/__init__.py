"""Isolated accepted purple Desktop source with current non-UI module fallback.

The five UI modules beside this file are exact copies of the owner-accepted
PYTHONUI source. Only the offline/observer launchers load this package; the
operational ``aegis_soc`` package remains unchanged.
"""

from pathlib import Path

_current_package = Path(__file__).resolve().parents[3] / "aegis_soc"
__path__.append(str(_current_package))
