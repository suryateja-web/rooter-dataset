# Rooter Dataset Manifest

This repo tracks the lightweight reproducibility layer for local model
development.

Tracked:

- `ingest_raw_sessions.py`
- `manifest.json`
- notes/configs/scripts added later

Not tracked:

- raw frame dumps
- raw mobile JSON outputs
- generated artifacts
- overlays, videos, model weights

Regenerate the manifest after adding new raw sessions:

```bash
python3 /home/ec2-user/dataset/ingest_raw_sessions.py
```

Current convention:

- `paramveer_testing/*` sessions are tagged as `latest_model`
- `1April`, `20march`, and `2april` sessions are tagged as `bad_iou_model`

