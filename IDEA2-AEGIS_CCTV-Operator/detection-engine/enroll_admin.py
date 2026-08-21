#!/usr/bin/env python3
"""Create a local SFace Admin template without storing source images in Git."""

from __future__ import annotations

import argparse
import hashlib
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _normalized(value) -> np.ndarray:
    vector = np.asarray(value, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(vector))
    if not np.isfinite(norm) or norm <= 0:
        raise ValueError("invalid face embedding")
    return vector / norm


def _load_image(path: Path, max_side: int):
    image = cv2.imread(str(path))
    if image is None:
        return None
    height, width = image.shape[:2]
    scale = min(1.0, max_side / float(max(height, width)))
    if scale < 1.0:
        image = cv2.resize(
            image,
            (max(1, round(width * scale)), max(1, round(height * scale))),
            interpolation=cv2.INTER_AREA,
        )
    return image


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Enroll one Admin identity from trusted local reference images."
    )
    parser.add_argument("--input", required=True)
    parser.add_argument("--detector-model", required=True)
    parser.add_argument("--recognizer-model", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--name", default="Admin")
    parser.add_argument("--detector-threshold", type=float, default=0.60)
    parser.add_argument("--max-side", type=int, default=640)
    parser.add_argument("--replace", action="store_true")
    args = parser.parse_args()

    input_root = Path(args.input)
    output = Path(args.output)
    if output.exists() and not args.replace:
        raise FileExistsError(f"output already exists (use --replace): {output}")
    if output.suffix.lower() != ".npz":
        raise ValueError("Admin template output must use the .npz extension")

    paths = sorted(
        path
        for path in input_root.rglob("*")
        if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES
    )
    if len(paths) < 3:
        raise ValueError("at least three trusted Admin reference images are required")

    detector = cv2.FaceDetectorYN_create(
        args.detector_model,
        "",
        (320, 320),
        args.detector_threshold,
        0.3,
        5000,
    )
    recognizer = cv2.FaceRecognizerSF_create(args.recognizer_model, "")
    embeddings = []
    image_hashes = []
    rejected = []

    for path in paths:
        image = _load_image(path, args.max_side)
        if image is None:
            rejected.append((path.name, "unreadable"))
            continue
        height, width = image.shape[:2]
        detector.setInputSize((width, height))
        _, faces = detector.detect(image)
        if faces is None or len(faces) != 1:
            rejected.append(
                (path.name, "no-face" if faces is None else "multiple-faces")
            )
            continue
        aligned = recognizer.alignCrop(image, faces[0])
        embeddings.append(_normalized(recognizer.feature(aligned)))
        image_hashes.append(_sha256(path))

    if len(embeddings) < 3:
        raise RuntimeError(
            f"only {len(embeddings)} valid references; at least three are required"
        )
    matrix = np.asarray(embeddings, dtype=np.float32)
    output.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        output,
        version=np.asarray([1], dtype=np.int32),
        display_name=np.asarray([args.name]),
        embeddings=matrix,
        recognizer_sha256=np.asarray([_sha256(Path(args.recognizer_model))]),
        detector_sha256=np.asarray([_sha256(Path(args.detector_model))]),
        source_image_sha256=np.asarray(image_hashes),
        created_at=np.asarray([datetime.now(timezone.utc).isoformat()]),
    )
    print("ADMIN_TEMPLATE=CREATED")
    print(f"REFERENCES_ACCEPTED={len(embeddings)}")
    print(f"REFERENCES_REJECTED={len(rejected)}")
    print(f"OUTPUT={output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
