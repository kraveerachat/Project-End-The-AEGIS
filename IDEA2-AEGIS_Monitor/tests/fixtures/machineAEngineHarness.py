from __future__ import annotations

import argparse
import http.client
import json
import os
from pathlib import Path
import queue
import secrets
import signal
import socket
import sys
import threading
import time
from urllib.request import Request, urlopen


def _engine_root() -> Path:
    configured = os.environ.get("AEGIS_ENGINE_ROOT")
    if configured:
        return Path(configured).resolve()
    return (
        Path(__file__).resolve().parents[3]
        / "IDEA2-AEGIS_CCTV-Operator"
        / "detection-engine"
    )


ENGINE_ROOT = _engine_root()
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

import numpy as np  # noqa: E402

from aegis_engine.config import EngineConfig  # noqa: E402
from aegis_engine.local_api import LocalEventAPI  # noqa: E402
from aegis_engine.metrics import MetricsRegistry  # noqa: E402
from aegis_engine.models import Frame  # noqa: E402
from aegis_engine.stream_hub import StreamHub  # noqa: E402
from aegis_engine.demand_grant import sign_payload  # noqa: E402


PROTECTED_PORTS = {8077, 8078, 18078}


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        port = int(listener.getsockname()[1])
    if port in PROTECTED_PORTS:
        return _free_port()
    return port


def _json_get(port: int, path: str = "/health") -> dict:
    request = Request(f"http://127.0.0.1:{port}{path}")
    with urlopen(request, timeout=2) as response:
        return json.loads(response.read().decode("utf-8"))


def _wait_ready(port: int, timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            return _json_get(port)
        except Exception as error:  # server thread is still starting
            last_error = error
            time.sleep(0.05)
    raise RuntimeError(f"Engine fixture did not become ready: {last_error}")


class ProtocolRealEngine:
    def __init__(self, port: int, key: str) -> None:
        if port in PROTECTED_PORTS:
            raise ValueError("Task 13 fixture must not use a protected runtime port")
        self.port = port
        self.key = key
        self._stop = threading.Event()
        self._demand = threading.Event()
        self._frames: "queue.Queue[Frame]" = queue.Queue(maxsize=2)
        self._config = EngineConfig(
            node_id="machine-a-node",
            camera_id="CAM-01",
            camera_label="Machine A disposable fixture",
            capture_on_demand=True,
            detection_engine_api_key=key,
            api_host="127.0.0.1",
            api_port=port,
            stream_enabled=True,
            stream_max_fps=12.0,
            stream_first_frame_timeout_s=5,
            stream_idle_timeout_s=5,
        ).validate()
        self._metrics = MetricsRegistry()
        self._stream = StreamHub(
            self._config,
            self._frames,
            stop_event=self._stop,
            capture_demand_event=self._demand,
        )
        self._api = LocalEventAPI(
            self._config,
            self._metrics,
            stream_hub=self._stream,
            capture_demand_event=self._demand,
        )
        self._feeder = threading.Thread(target=self._feed, name="Task13FrameFeeder", daemon=True)

    def _feed(self) -> None:
        sequence = 0
        while not self._stop.is_set():
            if not self._demand.wait(0.05):
                continue
            sequence += 1
            frame = Frame(
                seq=sequence,
                image=np.full((48, 64, 3), sequence % 255, dtype=np.uint8),
            )
            try:
                self._frames.put(frame, timeout=0.1)
            except queue.Full:
                pass
            time.sleep(0.04)

    def start(self) -> dict:
        self._stream.start()
        self._feeder.start()
        self._api.start()
        return _wait_ready(self.port)

    def stop(self) -> None:
        self._api.stop()
        self._stream.stop()
        self._stop.set()
        if self._stream.is_alive():
            self._stream.join(timeout=3)
        if self._feeder.is_alive():
            self._feeder.join(timeout=3)


def _contract_probe() -> int:
    port = _free_port()
    engine = ProtocolRealEngine(port, "task13-disposable-engine-key")
    connection: http.client.HTTPConnection | None = None
    response: http.client.HTTPResponse | None = None
    try:
        startup = engine.start()
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        connection.request(
            "GET",
            "/stream.mjpg",
            headers={
                "X-Detection-Engine-Key": engine.key,
                "X-Aegis-Producer-Generation": "1",
                "X-Aegis-Logical-Camera-Id": "CAM-01",
                "X-Aegis-Demand-Grant": sign_payload({
                    "v": 1, "action": "attach", "jti": secrets.token_urlsafe(32),
                    "demandOwnerId": secrets.token_urlsafe(32), "producerGeneration": "1",
                    "logicalCameraId": "CAM-01", "nodeId": "machine-a-node", "physicalCameraId": 1,
                    "engineBootId": engine._stream.producer_boot_id, "userId": "2",
                    "sessionBindingHash": "v1:" + "a" * 64,
                    "expiresAtMs": int(time.time() * 1000) + 29000,
                }, engine.key),
            },
        )
        response = connection.getresponse()
        if response.status != 200:
            raise RuntimeError(f"Engine fixture stream returned {response.status}")
        first = response.read(128)
        if not first:
            raise RuntimeError("Engine fixture did not produce an MJPEG part")
        demanded = _wait_for_state(port, camera_demanded=True, stream_viewers=1)
        response.close()
        connection.close()
        response = None
        connection = None
        final = _wait_for_state(port, camera_demanded=False, stream_viewers=0)
        print(json.dumps({
            "startupDemanded": startup["camera_demanded"],
            "startupViewers": startup["stream_viewers"],
            "streamDemanded": demanded["camera_demanded"],
            "streamViewers": demanded["stream_viewers"],
            "finalDemanded": final["camera_demanded"],
            "finalViewers": final["stream_viewers"],
            "protectedPortUsed": port in PROTECTED_PORTS,
        }, separators=(",", ":")))
        return 0
    finally:
        if response is not None:
            response.close()
        if connection is not None:
            connection.close()
        engine.stop()


def _wait_for_state(port: int, **expected: object) -> dict:
    deadline = time.monotonic() + 8
    current: dict = {}
    while time.monotonic() < deadline:
        current = _json_get(port)
        if all(current.get(key) == value for key, value in expected.items()):
            return current
        time.sleep(0.05)
    raise RuntimeError(f"Engine state did not converge: expected={expected}, actual={current}")


def _serve(port: int, key: str) -> int:
    engine = ProtocolRealEngine(port, key)
    stopping = threading.Event()

    def request_stop(_signum, _frame) -> None:
        stopping.set()

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    try:
        startup = engine.start()
        print(json.dumps({
            "ready": True,
            "port": port,
            "cameraDemanded": startup["camera_demanded"],
            "streamViewers": startup["stream_viewers"],
        }, separators=(",", ":")), flush=True)
        while not stopping.wait(0.2):
            pass
        return 0
    finally:
        engine.stop()


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--contract-probe", action="store_true")
    mode.add_argument("--serve", action="store_true")
    parser.add_argument("--port", type=int)
    parser.add_argument("--key", default="task13-disposable-engine-key")
    args = parser.parse_args()
    if args.contract_probe:
        return _contract_probe()
    if not args.port:
        parser.error("--port is required with --serve")
    return _serve(args.port, args.key)


if __name__ == "__main__":
    raise SystemExit(main())
