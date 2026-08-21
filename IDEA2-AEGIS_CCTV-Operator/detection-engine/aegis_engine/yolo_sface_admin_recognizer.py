"""YOLO candidate detection with SFace identity verification.

The local YOLO model remains the first gate, but a one-class detector cannot
prove identity by itself. A face is ``Authorized`` only when the YOLO Admin
candidate overlaps a YuNet face and that aligned face matches the enrolled
Admin SFace template. Any missing gate, inference error, or weak match remains
``Unknown`` so an object-detection false positive cannot grant identity.
"""

from __future__ import annotations

import hashlib
import os
import time
from typing import Iterable, List

import numpy as np

try:
    import cv2  # type: ignore
except Exception as exc:  # pragma: no cover
    raise RuntimeError("OpenCV is required (pip install -r requirements.txt)") from exc

from .config import EngineConfig
from .logging_setup import get_logger
from .models import DetectedEntity, DetectionStatus
from .yolo_admin_recognizer import _numpy, _same_face

log = get_logger("YoloSFaceAdminRecognizer")


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _normalized(value) -> np.ndarray:
    vector = np.asarray(value, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(vector))
    if not np.isfinite(norm) or norm <= 0:
        raise ValueError("face embedding is zero or non-finite")
    return vector / norm


class YoloSFaceAdminRecognizer:
    """Require agreement between YOLO and an enrolled biometric template."""

    def __init__(
        self,
        model_path: str,
        face_detector_model_path: str,
        face_recognizer_model_path: str,
        admin_embeddings_path: str,
        admin_class_name: str = "Admin-Face-Scan",
        admin_display_name: str = "Admin",
        admin_min_confidence: float = 50.0,
        face_match_cosine_threshold: float = 0.50,
        face_detector_score_threshold: float = 0.60,
        face_detector_max_side: int = 640,
        yolo_gate_ttl_s: float = 2.0,
        *,
        model=None,
        face_detector=None,
        face_recognizer=None,
        templates=None,
        template_recognizer_sha256: str | None = None,
        clock=time.monotonic,
    ) -> None:
        self._admin_display_name = admin_display_name
        self._admin_min_confidence = admin_min_confidence
        self._match_threshold = face_match_cosine_threshold
        self._detector_max_side = face_detector_max_side
        self._yolo_gate_ttl_s = yolo_gate_ttl_s
        self._clock = clock
        self._recent_yolo_boxes: List[
            tuple[tuple[int, int, int, int], float]
        ] = []

        if model is None:
            if not os.path.isfile(model_path):
                raise FileNotFoundError(
                    f"AEGIS_ADMIN_MODEL_PATH does not exist: {model_path}"
                )
            try:
                from ultralytics import YOLO  # type: ignore
            except Exception as exc:
                raise RuntimeError(
                    "YOLO recognition requires requirements-ai.txt"
                ) from exc
            model = YOLO(model_path)
        self._model = model

        names = getattr(self._model, "names", {})
        items = names.items() if isinstance(names, dict) else enumerate(names)
        self._admin_class_ids = {
            int(class_id)
            for class_id, name in items
            if str(name) == admin_class_name
        }
        if not self._admin_class_ids:
            raise ValueError(
                f"Admin class {admin_class_name!r} was not found in YOLO model classes"
            )

        if face_detector is None:
            if not os.path.isfile(face_detector_model_path):
                raise FileNotFoundError(
                    "AEGIS_FACE_DETECTOR_MODEL_PATH does not exist: "
                    f"{face_detector_model_path}"
                )
            face_detector = cv2.FaceDetectorYN_create(
                face_detector_model_path,
                "",
                (320, 320),
                face_detector_score_threshold,
                0.3,
                5000,
            )
        self._face_detector = face_detector

        if face_recognizer is None:
            if not os.path.isfile(face_recognizer_model_path):
                raise FileNotFoundError(
                    "AEGIS_FACE_RECOGNIZER_MODEL_PATH does not exist: "
                    f"{face_recognizer_model_path}"
                )
            face_recognizer = cv2.FaceRecognizerSF_create(
                face_recognizer_model_path, ""
            )
        self._face_recognizer = face_recognizer

        if templates is None:
            templates, template_recognizer_sha256 = self._load_templates(
                admin_embeddings_path
            )
        self._templates = np.asarray(
            [_normalized(item) for item in templates], dtype=np.float32
        )
        if self._templates.ndim != 2 or self._templates.shape[0] < 3:
            raise ValueError("Admin template must contain at least three embeddings")

        if template_recognizer_sha256 and face_recognizer_model_path:
            actual_hash = _sha256(face_recognizer_model_path)
            if actual_hash.lower() != template_recognizer_sha256.lower():
                raise ValueError(
                    "Admin template was created with a different SFace model"
                )

        log.info(
            "YOLO+SFace Admin recognizer loaded · yolo=%s · templates=%d · "
            "identity-threshold=%.3f",
            os.path.basename(model_path),
            self._templates.shape[0],
            self._match_threshold,
        )

    @staticmethod
    def _load_templates(path: str):
        if not os.path.isfile(path):
            raise FileNotFoundError(
                f"AEGIS_ADMIN_EMBEDDINGS_PATH does not exist: {path}"
            )
        try:
            with np.load(path, allow_pickle=False) as data:
                version = int(np.asarray(data["version"]).reshape(-1)[0])
                if version != 1:
                    raise ValueError(f"unsupported Admin template version: {version}")
                embeddings = np.asarray(data["embeddings"], dtype=np.float32)
                model_hash = str(
                    np.asarray(data["recognizer_sha256"]).reshape(-1)[0]
                )
        except (KeyError, OSError) as exc:
            raise ValueError(f"invalid Admin template: {path}") from exc
        return embeddings, model_hash

    def recognize(self, image_bgr) -> List[DetectedEntity]:
        faces = self._detect_faces(image_bgr)
        if not faces:
            return []

        try:
            yolo_boxes = self._yolo_candidates(image_bgr)
        except Exception:
            # Failure of the first gate cannot authorize any detected face.
            log.exception("YOLO inference failed; detected faces remain Unknown")
            yolo_boxes = []
            self._recent_yolo_boxes.clear()

        now = self._clock()
        self._recent_yolo_boxes = [
            (box, seen_at)
            for box, seen_at in self._recent_yolo_boxes
            if now - seen_at <= self._yolo_gate_ttl_s
        ]
        self._recent_yolo_boxes.extend((box, now) for box in yolo_boxes)
        gate_boxes = [box for box, _seen_at in self._recent_yolo_boxes]

        entities: List[DetectedEntity] = []
        for face in faces:
            bbox = self._face_bbox(face, image_bgr.shape[1], image_bgr.shape[0])
            status = DetectionStatus.UNKNOWN
            name = None
            identity_score = 0.0
            # YOLO can flicker between adjacent video frames. A short,
            # position-scoped cache keeps the first gate continuous, while
            # SFace still has to prove identity on every Authorized frame.
            if any(_same_face(bbox, candidate) for candidate in gate_boxes):
                try:
                    aligned = self._face_recognizer.alignCrop(image_bgr, face)
                    embedding = _normalized(self._face_recognizer.feature(aligned))
                    identity_score = float(np.max(self._templates @ embedding))
                    if identity_score >= self._match_threshold:
                        status = DetectionStatus.AUTHORIZED
                        name = self._admin_display_name
                except Exception:
                    # Alignment or embedding failure is an Unknown verdict.
                    log.exception("SFace verification failed; face remains Unknown")

            detector_score = float(face[14]) if len(face) > 14 else 0.0
            confidence = (
                max(0.0, min(1.0, identity_score)) * 100.0
                if status is DetectionStatus.AUTHORIZED
                else max(60.0, min(99.0, detector_score * 100.0))
            )
            entities.append(
                DetectedEntity(
                    status=status,
                    confidence=round(confidence, 2),
                    name=name,
                    bbox=bbox,
                )
            )
        return entities

    def _detect_faces(self, image_bgr) -> List[np.ndarray]:
        height, width = image_bgr.shape[:2]
        scale = min(1.0, self._detector_max_side / float(max(height, width)))
        detection_image = image_bgr
        if scale < 1.0:
            detection_image = cv2.resize(
                image_bgr,
                (max(1, round(width * scale)), max(1, round(height * scale))),
                interpolation=cv2.INTER_AREA,
            )
        detect_height, detect_width = detection_image.shape[:2]
        self._face_detector.setInputSize((detect_width, detect_height))
        _, faces = self._face_detector.detect(detection_image)
        if faces is None:
            return []
        output = []
        for raw_face in faces:
            face = np.asarray(raw_face, dtype=np.float32).copy()
            if scale < 1.0:
                face[:14] /= scale
            output.append(face)
        return output

    def _yolo_candidates(self, image_bgr) -> List[tuple[int, int, int, int]]:
        prediction = self._model.predict(
            image_bgr,
            conf=self._admin_min_confidence / 100.0,
            verbose=False,
        )[0]
        boxes = getattr(prediction, "boxes", None)
        if boxes is None:
            return []
        return self._candidate_boxes(
            _numpy(boxes.xyxy), _numpy(boxes.conf), _numpy(boxes.cls)
        )

    def _candidate_boxes(
        self,
        coordinates: Iterable,
        confidences: Iterable,
        class_ids: Iterable,
    ) -> List[tuple[int, int, int, int]]:
        output = []
        for coords, confidence, class_id in zip(
            coordinates, confidences, class_ids
        ):
            if (
                int(class_id) not in self._admin_class_ids
                or float(confidence) * 100.0 < self._admin_min_confidence
            ):
                continue
            x1, y1, x2, y2 = (int(round(float(value))) for value in coords)
            output.append((x1, y1, max(1, x2 - x1), max(1, y2 - y1)))
        return output

    @staticmethod
    def _face_bbox(face, frame_width: int, frame_height: int):
        x = max(0, min(frame_width - 1, int(round(float(face[0])))))
        y = max(0, min(frame_height - 1, int(round(float(face[1])))))
        width = max(1, min(frame_width - x, int(round(float(face[2])))))
        height = max(1, min(frame_height - y, int(round(float(face[3])))))
        return x, y, width, height


def build_configured_recognizer(config: EngineConfig):
    """Build only an explicitly selected backend; placeholder stays default."""
    if config.recognizer_backend == "placeholder":
        return None
    if config.recognizer_backend == "yolo-sface-admin":
        return YoloSFaceAdminRecognizer(
            model_path=config.admin_model_path or "",
            face_detector_model_path=config.face_detector_model_path or "",
            face_recognizer_model_path=config.face_recognizer_model_path or "",
            admin_embeddings_path=config.admin_embeddings_path or "",
            admin_class_name=config.admin_class_name,
            admin_display_name=config.admin_display_name,
            admin_min_confidence=config.admin_min_confidence,
            face_match_cosine_threshold=config.face_match_cosine_threshold,
            face_detector_score_threshold=config.face_detector_score_threshold,
            face_detector_max_side=config.face_detector_max_side,
            yolo_gate_ttl_s=config.yolo_gate_ttl_s,
        )
    raise ValueError(f"Unsupported recognizer backend: {config.recognizer_backend}")
