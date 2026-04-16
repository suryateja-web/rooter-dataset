# Dataset Debugger

Compare MLflow postprocessor runs with dataset ground truth and raw detections.

Run:

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

The app reads:

- MLflow tracking server: `http://127.0.0.1:5000`
- MLflow artifact store: `/home/ec2-user/mlflow_server/mlartifacts`
- Dataset manifest: `/home/ec2-user/dataset/manifest.json`
- Ground truth annotations: `/home/ec2-user/dataset/annotations`

