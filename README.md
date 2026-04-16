# Rooter Dataset Manifest

This repo tracks the lightweight dataset catalog for local model development.

Mental model:

- frame folders are dataset sessions
- segment labels, match kills, assists, and `is_alive` are session annotations
- raw mobile JSON files are app detection/OCR runs attached to those sessions
- postprocessor experiments should consume app runs and write outputs to MLflow
  or an artifact store, not into this repo

Tracked:

- `ingest_raw_sessions.py`
- `manifest.json`
- notes/configs/scripts added later

Not tracked:

- raw frame dumps
- raw mobile JSON outputs
- generated artifacts
- postprocessor outputs
- overlays, videos, model weights

Regenerate the manifest after adding new raw sessions:

```bash
python3 /home/ec2-user/dataset/ingest_raw_sessions.py
```

Run the dataset visualizer:

```bash
cd /home/ec2-user/dataset/visualizer
npm install
npm run build
npm start
```

Open:

```text
http://localhost:4100
```

Run the dataset annotator:

```bash
cd /home/ec2-user/dataset/annotator
npm install
npm run build
npm start
```

Open:

```text
http://localhost:4200
```

Annotation JSON files are saved under:

```text
annotations/<session_id>.json
```

Run the dataset debugger:

```bash
cd /home/ec2-user/dataset/debugger
npm install
npm run build
npm start
```

Open:

```text
http://localhost:4300
```

The debugger compares MLflow run artifacts with annotation JSON and raw frame
detections.

Current convention:

- app runs under `paramveer_testing/*` are tagged as `latest_model`
- app runs under `1April`, `20march`, and `2april` are tagged as `bad_iou_model`
