import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

const PORT = Number(process.env.PORT || 4100);
const MANIFEST_PATH =
  process.env.MANIFEST_PATH || "/home/ec2-user/dataset/manifest.json";
const RAW_ROOT = process.env.RAW_ROOT || "/home/ec2-user/dataset/raw_data";

let manifestCache = null;
let manifestMtimeMs = 0;

function readManifest() {
  const stat = fs.statSync(MANIFEST_PATH);
  if (!manifestCache || stat.mtimeMs !== manifestMtimeMs) {
    manifestCache = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    manifestMtimeMs = stat.mtimeMs;
  }
  return manifestCache;
}

function getSession(sessionId) {
  const manifest = readManifest();
  return manifest.sessions.find((session) => session.session_id === sessionId);
}

function listFrames(framesPath) {
  return fs
    .readdirSync(framesPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(jpe?g|png)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function safeFramePath(session, frameName) {
  if (!/^[A-Za-z0-9._-]+\.(jpe?g|png)$/i.test(frameName)) {
    return null;
  }

  const framesRoot = path.resolve(session.frames_path);
  const framePath = path.resolve(framesRoot, frameName);
  if (!framePath.startsWith(`${framesRoot}${path.sep}`)) {
    return null;
  }
  if (!framePath.startsWith(path.resolve(RAW_ROOT))) {
    return null;
  }
  return framePath;
}

function summarizeSession(session) {
  return {
    session_id: session.session_id,
    source_type: session.source_type,
    collection_folder: session.collection_folder,
    relative_path: session.relative_path,
    frames_path: session.frames_path,
    frame_count: session.frame_count,
    first_frame: session.first_frame,
    last_frame: session.last_frame,
    annotations: session.annotations,
    app_run_count: session.app_runs.length,
    app_run_families: [
      ...new Set(
        session.app_runs.flatMap((run) => [
          run.detector_model_family,
          run.ocr_model_family,
        ]),
      ),
    ].filter(Boolean),
  };
}

app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/manifest", (_req, res) => {
  const manifest = readManifest();
  res.json({
    manifest_version: manifest.manifest_version,
    generated_at: manifest.generated_at,
    raw_root: manifest.raw_root,
    notes: manifest.notes,
    session_count: manifest.sessions.length,
    app_run_count: manifest.sessions.reduce(
      (total, session) => total + session.app_runs.length,
      0,
    ),
    frame_count: manifest.sessions.reduce(
      (total, session) => total + session.frame_count,
      0,
    ),
  });
});

app.get("/api/sessions", (req, res) => {
  const manifest = readManifest();
  const q = String(req.query.q || "").trim().toLowerCase();
  const collection = String(req.query.collection || "").trim();
  const model = String(req.query.model || "").trim();

  let sessions = manifest.sessions.map(summarizeSession);

  if (q) {
    sessions = sessions.filter((session) =>
      [session.session_id, session.relative_path, session.collection_folder]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }

  if (collection) {
    sessions = sessions.filter(
      (session) => session.collection_folder === collection,
    );
  }

  if (model) {
    sessions = sessions.filter((session) =>
      session.app_run_families.includes(model),
    );
  }

  res.json({ sessions });
});

app.get("/api/sessions/:sessionId", (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json({ session });
});

app.get("/api/sessions/:sessionId/frames", (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const offset = Math.max(0, Number(req.query.offset || 0));
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 48)));
  const frames = listFrames(session.frames_path);
  const page = frames.slice(offset, offset + limit).map((name, index) => ({
    name,
    index: offset + index,
    url: `/api/sessions/${encodeURIComponent(
      session.session_id,
    )}/frames/${encodeURIComponent(name)}`,
  }));

  res.json({
    offset,
    limit,
    total: frames.length,
    frames: page,
  });
});

app.get("/api/sessions/:sessionId/frames/:frameName", (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const framePath = safeFramePath(session, req.params.frameName);
  if (!framePath || !fs.existsSync(framePath)) {
    res.status(404).json({ error: "Frame not found" });
    return;
  }

  res.sendFile(framePath);
});

app.get("/api/sessions/:sessionId/app-runs/:runId/raw-summary", (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const run = session.app_runs.find((item) => item.run_id === req.params.runId);
  if (!run) {
    res.status(404).json({ error: "App run not found" });
    return;
  }

  res.json({ run });
});

const distPath = path.resolve(__dirname, "../dist");
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Dataset visualizer API running on http://0.0.0.0:${PORT}`);
  console.log(`Manifest: ${MANIFEST_PATH}`);
});

