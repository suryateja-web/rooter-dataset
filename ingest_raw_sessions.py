#!/usr/bin/env python3
"""Build a small manifest for raw debug-app frame sessions.

This does not normalize detections yet. It only records what exists, where it
lives, and which model family produced each raw mobile JSON output.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MODEL_FAMILY_BY_TOP_FOLDER = {
    "1April": "bad_iou_model",
    "20march": "bad_iou_model",
    "2april": "bad_iou_model",
    "paramveer_testing": "latest_model",
}


def slug(value: str) -> str:
    allowed = []
    for char in value.lower():
        if char.isalnum():
            allowed.append(char)
        else:
            allowed.append("_")
    compact = "_".join(part for part in "".join(allowed).split("_") if part)
    return compact or "unknown"


def infer_algo_variant(json_path: Path) -> str:
    stem = json_path.stem.lower()
    if "best_engine" in stem:
        return "best_engine"
    if "best_tflite" in stem:
        return "best_tflite"
    if "tflite" in stem:
        return "tflite"
    return "default"


def read_json_summary(json_path: Path, frame_names: set[str]) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "raw_json_path": str(json_path),
        "raw_output_format": "unknown",
        "json_entries": None,
        "total_detections": None,
        "matched_frame_count": None,
        "sample_frame_name": None,
        "error": None,
    }

    try:
        data = json.loads(json_path.read_text())
    except Exception as exc:  # noqa: BLE001 - manifest should record bad files.
        summary["error"] = f"{type(exc).__name__}: {exc}"
        return summary

    if not isinstance(data, list):
        summary["raw_output_format"] = type(data).__name__
        return summary

    summary["raw_output_format"] = "phone_detection_array_v1"
    summary["json_entries"] = len(data)

    total_detections = 0
    matched_frames = 0
    sample_frame_name = None

    for item in data:
        if not isinstance(item, dict):
            continue

        detections = item.get("detections")
        if isinstance(detections, list):
            total_detections += len(detections)

        file_name = item.get("fileName")
        if isinstance(file_name, str):
            basename = Path(file_name).name
            sample_frame_name = sample_frame_name or basename
            if basename in frame_names:
                matched_frames += 1

    summary["total_detections"] = total_detections
    summary["matched_frame_count"] = matched_frames
    summary["sample_frame_name"] = sample_frame_name
    return summary


def find_session_dirs(raw_root: Path) -> list[Path]:
    session_dirs = []
    for frames_dir in raw_root.rglob("CAPTURED_FRAMES"):
        if frames_dir.is_dir():
            session_dirs.append(frames_dir.parent)
    return sorted(session_dirs)


def build_manifest(raw_root: Path) -> dict[str, Any]:
    sessions = []

    for session_dir in find_session_dirs(raw_root):
        relative_session = session_dir.relative_to(raw_root)
        collection_folder = relative_session.parts[0]
        model_family = MODEL_FAMILY_BY_TOP_FOLDER.get(collection_folder, "unknown")

        frames_dir = session_dir / "CAPTURED_FRAMES"
        frames = sorted(
            path
            for path in frames_dir.iterdir()
            if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png"}
        )
        frame_names = {path.name for path in frames}

        session_id = f"session_{slug(str(relative_session))}"
        raw_outputs = []

        for json_path in sorted(session_dir.glob("*.json")):
            run_id = f"raw_{slug(str(relative_session))}_{slug(json_path.stem)}"
            output = {
                "run_id": run_id,
                "source": "mobile_debug_app",
                "model_family": model_family,
                "algo_variant": infer_algo_variant(json_path),
                **read_json_summary(json_path, frame_names),
            }
            raw_outputs.append(output)

        sessions.append(
            {
                "session_id": session_id,
                "source_type": "debug_app_frame_dump",
                "collection_folder": collection_folder,
                "relative_path": str(relative_session),
                "frames_path": str(frames_dir),
                "model_family": model_family,
                "frame_count": len(frames),
                "first_frame": frames[0].name if frames else None,
                "last_frame": frames[-1].name if frames else None,
                "raw_outputs": raw_outputs,
            }
        )

    return {
        "manifest_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "raw_root": str(raw_root),
        "notes": [
            "Raw frame folders are treated as immutable sessions.",
            "Raw mobile JSON files are treated as raw runs.",
            "Normalized detections and stats should be written later as artifacts linked by run_id.",
        ],
        "sessions": sessions,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-root", default="/home/ec2-user/dataset/raw_data")
    parser.add_argument("--out", default="/home/ec2-user/dataset/manifest.json")
    args = parser.parse_args()

    raw_root = Path(args.raw_root).resolve()
    out_path = Path(args.out).resolve()

    manifest = build_manifest(raw_root)
    out_path.write_text(json.dumps(manifest, indent=2) + "\n")

    session_count = len(manifest["sessions"])
    raw_run_count = sum(len(session["raw_outputs"]) for session in manifest["sessions"])
    frame_count = sum(session["frame_count"] for session in manifest["sessions"])
    print(f"Wrote {out_path}")
    print(f"sessions={session_count} raw_runs={raw_run_count} frames={frame_count}")


if __name__ == "__main__":
    main()
