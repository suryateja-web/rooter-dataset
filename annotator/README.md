# Dataset Annotator

Small local tool for writing ground-truth annotations for dataset sessions.

Run:

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

Annotations are saved as JSON files:

```text
/home/ec2-user/dataset/annotations/<session_id>.json
```

These JSON files are the pushed source of truth. The app does not write to
`manifest.json`.

