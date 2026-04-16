# Dataset Visualizer

Small local browser for `/home/ec2-user/dataset/manifest.json`.

Run both backend and frontend:

```bash
npm run dev
```

Ports:

- frontend: `http://localhost:5173`
- backend: `http://localhost:4100`

The backend reads the manifest and serves frame images from the raw dataset
folder. It does not copy or modify dataset files.

