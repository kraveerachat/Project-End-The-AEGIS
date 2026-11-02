"""IDEA3 graduated response: decide how hard to respond to detected attack evidence.

Pure policy, no I/O. The Core feeds it evidence (what the detector observed plus what the Core itself observed while
containing) and receives one ``Decision`` per observation. The Core performs the action; this module never contains,
cuts, restores, publishes or writes anything.

Levels and actions (each action fires once, on the transition into its level):

    LOW       below the MEDIUM score       -> record only
    MEDIUM    one confirmed detector rule  -> SOFTWARE_BLOCK (reversible firewall block of that address)
    HIGH      several vectors / sources    -> RECOMMEND_CUT (an operator decides on the Desktop)
    CRITICAL  score AND corroboration      -> AUTO_CUT (physical relay cut, once per lockdown episode)

Why a forged log line cannot cut the uplink: CRITICAL requires *corroborating* evidence that a detector line alone cannot
supply. Corroboration is either a Core-side observation (the Core's own block of the address failed, or the address kept
producing new detector evidence after the Core confirmed the block, which a working block would have dropped before it
was logged) or a compromise signal (a successful SSH login from an address that already crossed the brute-force rule).
Without corroboration the level is capped at HIGH, which only recommends a CUT to a human. RESTORE is never decided here.

Thresholds are lab defaults chosen to be explainable, not tuned; they are module constants so tests pin them.
"""

from __future__ import annotations

import ipaddress
import threading
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field

# -- evidence kinds ---------------------------------------------------------------------------------------------------------
# Detector-observed (arrive over the Core-local alert ingress):
PORT_SCAN = "port_scan"
SSH_BRUTE_FORCE = "ssh_brute_force"
SYN_FLOOD = "syn_flood"
SSH_LOGIN_AFTER_FAILURES = "ssh_login_after_failures"
GENERIC = "generic"  # a version-1 alert that carries no kind
DETECTOR_KINDS = frozenset({PORT_SCAN, SSH_BRUTE_FORCE, SYN_FLOOD, SSH_LOGIN_AFTER_FAILURES, GENERIC})
# Core-observed (never accepted from the alert ingress):
CONTAINMENT_FAILED = "containment_failed"
POST_CONTAINMENT_ACTIVITY = "post_containment_activity"
DISTRIBUTED_ATTACK = "distributed_attack"
CORE_KINDS = frozenset({CONTAINMENT_FAILED, POST_CONTAINMENT_ACTIVITY, DISTRIBUTED_ATTACK})

# MITRE ATT&CK technique per kind (report / UI only).
MITRE = {
    PORT_SCAN: "T1046",
    SSH_BRUTE_FORCE: "T1110",
    SYN_FLOOD: "T1498",
    SSH_LOGIN_AFTER_FAILURES: "T1078",
    GENERIC: "",
    CONTAINMENT_FAILED: "",
    POST_CONTAINMENT_ACTIVITY: "",
    DISTRIBUTED_ATTACK: "T1498",
}

SCORES = {
    GENERIC: 30,
    PORT_SCAN: 30,
    SSH_BRUTE_FORCE: 40,
    SYN_FLOOD: 50,
    SSH_LOGIN_AFTER_FAILURES: 100,
    CONTAINMENT_FAILED: 60,
    POST_CONTAINMENT_ACTIVITY: 60,
    DISTRIBUTED_ATTACK: 30,
}
MULTI_VECTOR_BONUS = 20  # two or more distinct detector kinds from one address

# Corroborating kinds: the only way to reach CRITICAL. SSH_LOGIN_AFTER_FAILURES counts only with prior brute force.
CORE_CORROBORATION = frozenset({CONTAINMENT_FAILED, POST_CONTAINMENT_ACTIVITY})

LOW, MEDIUM, HIGH, CRITICAL = "LOW", "MEDIUM", "HIGH", "CRITICAL"
LEVEL_ORDER = (LOW, MEDIUM, HIGH, CRITICAL)
MEDIUM_SCORE = 30
HIGH_SCORE = 60
CRITICAL_SCORE = 100

NONE = "NONE"
SOFTWARE_BLOCK = "SOFTWARE_BLOCK"
RECOMMEND_CUT = "RECOMMEND_CUT"
AUTO_CUT = "AUTO_CUT"

EVIDENCE_WINDOW_SEC = 600.0        # evidence older than this no longer counts
POST_BLOCK_GRACE_SEC = 5.0         # log lines already in flight when the block landed are not "bypass" evidence
DISTRIBUTED_WINDOW_SEC = 120.0
DISTRIBUTED_SOURCES = 3            # this many addresses at MEDIUM or above inside the window = a distributed attack
MAX_TRACKED = 1024
MAX_EVIDENCE_PER_ADDRESS = 32


def _rank(level: str) -> int:
    return LEVEL_ORDER.index(level)


@dataclass(frozen=True)
class Evidence:
    kind: str
    at: float


@dataclass
class _Track:
    evidence: list[Evidence] = field(default_factory=list)
    level: str = LOW
    blocked_at: float | None = None
    first_medium_at: float | None = None


@dataclass(frozen=True)
class Decision:
    """What the Core should do now. ``action`` is NONE unless this observation raised the level."""

    address: str
    kind: str
    level: str
    previous_level: str
    score: int
    action: str
    corroborated: bool
    reasons: tuple[str, ...]  # stable tokens, e.g. "port_scan+30", for audit rows and localized messages
    mitre: tuple[str, ...]

    @property
    def escalated(self) -> bool:
        return _rank(self.level) > _rank(self.previous_level)


class GraduatedResponse:
    """Per-address scoring with a single global auto-CUT latch per lockdown episode."""

    def __init__(self, *, clock: Callable[[], float]) -> None:
        self._clock = clock
        self._tracks: OrderedDict[str, _Track] = OrderedDict()
        self._medium_sources: OrderedDict[str, float] = OrderedDict()
        self._auto_cut_latched = False
        # The Core calls in from the alert-server thread and the MQTT status thread. The engine never calls out, so this
        # lock cannot take part in a lock-order inversion with the Core's command lock.
        self._lock = threading.RLock()

    # -- public ---------------------------------------------------------------------------------------------------------
    @property
    def auto_cut_latched(self) -> bool:
        return self._auto_cut_latched

    def reset_episode(self) -> None:
        """Called by the Core after an operator RESTORE: the next CRITICAL may cut again. Evidence is kept."""
        with self._lock:
            self._auto_cut_latched = False

    def level_of(self, address: str) -> str:
        track = self._tracks.get(address)
        return track.level if track else LOW

    def observe(self, address: str, kind: str) -> Decision:
        """Detector evidence for ``address``. ``kind`` must be a detector kind; anything else raises ValueError."""
        if kind not in DETECTOR_KINDS:
            raise ValueError("unknown detector evidence kind")
        safe = self._address(address)
        with self._lock:
            return self._observe_locked(safe, kind)

    def _observe_locked(self, safe: str, kind: str) -> Decision:
        now = self._clock()
        track = self._track(safe)
        if track.blocked_at is not None and now - track.blocked_at > POST_BLOCK_GRACE_SEC:
            # The Core confirmed a block of this address earlier; a working block drops its packets before they are
            # logged, so new detector evidence from it means the block is being bypassed.
            self._add(track, POST_CONTAINMENT_ACTIVITY, now)
        self._add(track, kind, now)
        return self._decide(safe, kind, track, now)

    def containment_result(self, address: str, *, confirmed: bool) -> Decision | None:
        """The Core's own outcome for the SOFTWARE_BLOCK it performed. A failure is corroborating evidence."""
        safe = self._address(address)
        with self._lock:
            return self._containment_locked(safe, confirmed)

    def _containment_locked(self, safe: str, confirmed: bool) -> Decision | None:
        track = self._tracks.get(safe)
        if track is None:
            return None
        now = self._clock()
        if confirmed:
            track.blocked_at = now
            return None
        self._add(track, CONTAINMENT_FAILED, now)
        return self._decide(safe, CONTAINMENT_FAILED, track, now)

    # -- internals ------------------------------------------------------------------------------------------------------
    @staticmethod
    def _address(address: str) -> str:
        return str(ipaddress.IPv4Address(str(address)))

    def _track(self, address: str) -> _Track:
        if address not in self._tracks and len(self._tracks) >= MAX_TRACKED:
            self._tracks.popitem(last=False)
        track = self._tracks.setdefault(address, _Track())
        self._tracks.move_to_end(address)
        return track

    @staticmethod
    def _add(track: _Track, kind: str, now: float) -> None:
        track.evidence.append(Evidence(kind, now))
        if len(track.evidence) > MAX_EVIDENCE_PER_ADDRESS:
            del track.evidence[: len(track.evidence) - MAX_EVIDENCE_PER_ADDRESS]

    def _distributed(self, address: str, now: float) -> bool:
        for other, at in list(self._medium_sources.items()):
            if now - at > DISTRIBUTED_WINDOW_SEC:
                del self._medium_sources[other]
        return len(self._medium_sources) >= DISTRIBUTED_SOURCES and address in self._medium_sources

    def _score(self, track: _Track, now: float) -> tuple[int, bool, list[str]]:
        live = [e for e in track.evidence if now - e.at <= EVIDENCE_WINDOW_SEC]
        track.evidence = live
        kinds_seen: list[str] = []
        for item in live:  # each kind counts once: repeating one rule does not climb by itself
            if item.kind not in kinds_seen:
                kinds_seen.append(item.kind)
        score = sum(SCORES[kind] for kind in kinds_seen)
        reasons = [f"{kind}+{SCORES[kind]}" for kind in kinds_seen]
        detector_kinds = {kind for kind in kinds_seen if kind in DETECTOR_KINDS and kind != SSH_LOGIN_AFTER_FAILURES}
        if len(detector_kinds) >= 2:
            score += MULTI_VECTOR_BONUS
            reasons.append(f"multi_vector+{MULTI_VECTOR_BONUS}")
        login_after_brute_force = SSH_LOGIN_AFTER_FAILURES in kinds_seen and SSH_BRUTE_FORCE in kinds_seen
        if SSH_LOGIN_AFTER_FAILURES in kinds_seen and not login_after_brute_force:
            # A login line without the brute-force evidence is not a compromise signal on its own.
            score -= SCORES[SSH_LOGIN_AFTER_FAILURES]
            reasons.remove(f"{SSH_LOGIN_AFTER_FAILURES}+{SCORES[SSH_LOGIN_AFTER_FAILURES]}")
            reasons.append(f"{SSH_LOGIN_AFTER_FAILURES}+0_uncorroborated")
        corroborated = login_after_brute_force or any(kind in CORE_CORROBORATION for kind in kinds_seen)
        return score, corroborated, reasons

    def _decide(self, address: str, kind: str, track: _Track, now: float) -> Decision:
        score, corroborated, reasons = self._score(track, now)
        level = self._level_for(score, corroborated)
        if _rank(level) >= _rank(MEDIUM):
            self._medium_sources[address] = now
            self._medium_sources.move_to_end(address)
            if self._distributed(address, now) and not any(e.kind == DISTRIBUTED_ATTACK for e in track.evidence):
                self._add(track, DISTRIBUTED_ATTACK, now)
                score, corroborated, reasons = self._score(track, now)
                level = self._level_for(score, corroborated)
                if _rank(level) < _rank(HIGH):
                    level = HIGH
                    reasons.append("distributed_sources")
        previous = track.level
        if _rank(level) < _rank(previous):
            level = previous  # within one episode the level never drops by decay alone
        track.level = level
        action = NONE
        if _rank(level) > _rank(previous):
            action = {MEDIUM: SOFTWARE_BLOCK, HIGH: RECOMMEND_CUT, CRITICAL: AUTO_CUT}.get(level, NONE)
        if action == AUTO_CUT:
            if self._auto_cut_latched:
                action = NONE
            else:
                self._auto_cut_latched = True
        mitre = tuple(sorted({MITRE[e.kind] for e in track.evidence if MITRE.get(e.kind)}))
        return Decision(address, kind, level, previous, score, action, corroborated, tuple(reasons), mitre)

    @staticmethod
    def _level_for(score: int, corroborated: bool) -> str:
        if score >= CRITICAL_SCORE and corroborated:
            return CRITICAL
        if score >= HIGH_SCORE:
            return HIGH
        if score >= MEDIUM_SCORE:
            return MEDIUM
        return LOW
