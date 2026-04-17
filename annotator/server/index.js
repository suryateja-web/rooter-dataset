import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

const PORT = Number(process.env.PORT || 4200);
const DATASET_ROOT = process.env.DATASET_ROOT || "/home/ec2-user/dataset";
const MANIFEST_PATH =
  process.env.MANIFEST_PATH || path.join(DATASET_ROOT, "manifest.json");
const RAW_ROOT = process.env.RAW_ROOT || path.join(DATASET_ROOT, "raw_data");
const THUMB_CACHE_ROOT =
  process.env.THUMB_CACHE_ROOT || path.join(DATASET_ROOT, ".cache", "thumbnails");
const ANNOTATIONS_ROOT =
  process.env.ANNOTATIONS_ROOT || path.join(DATASET_ROOT, "annotations");

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
  return readManifest().sessions.find((session) => session.session_id === sessionId);
}

function safeSessionId(sessionId) {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    return null;
  }
  return sessionId;
}

function annotationPath(sessionId) {
  const safe = safeSessionId(sessionId);
  if (!safe) return null;
  const root = path.resolve(ANNOTATIONS_ROOT);
  const filePath = path.resolve(root, `${safe}.json`);
  if (!filePath.startsWith(`${root}${path.sep}`)) return null;
  return filePath;
}

function defaultAnnotation(sessionId) {
  return {
    version: 1,
    session_id: sessionId,
    updated_at: null,
    session_details: {
      total_matches: "",
      notes: "",
    },
    segments: [],
    match_stats: [],
    extra: {},
  };
}

function readAnnotation(sessionId) {
  const filePath = annotationPath(sessionId);
  if (!filePath || !fs.existsSync(filePath)) {
    return defaultAnnotation(sessionId);
  }
  return {
    ...defaultAnnotation(sessionId),
    ...JSON.parse(fs.readFileSync(filePath, "utf8")),
  };
}

function writeAnnotation(sessionId, annotation) {
  const filePath = annotationPath(sessionId);
  if (!filePath) {
    throw new Error("Invalid session id");
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const value = {
    ...defaultAnnotation(sessionId),
    ...annotation,
    session_id: sessionId,
    version: Number(annotation.version || 1),
    updated_at: new Date().toISOString(),
  };
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tempPath, filePath);
  return value;
}

function listFrames(framesPath) {
  return fs
    .readdirSync(framesPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(jpe?g|png)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function safeFramePath(session, frameName) {
  if (!/^[A-Za-z0-9._-]+\.(jpe?g|png)$/i.test(frameName)) return null;
  const framesRoot = path.resolve(session.frames_path);
  const framePath = path.resolve(framesRoot, frameName);
  if (!framePath.startsWith(`${framesRoot}${path.sep}`)) return null;
  if (!framePath.startsWith(path.resolve(RAW_ROOT))) return null;
  return framePath;
}

async function cachedThumbnail(framePath, size = 180) {
  const stat = fs.statSync(framePath);
  const width = Math.min(480, Math.max(80, Number(size) || 180));
  const key = crypto
    .createHash("sha1")
    .update(`${framePath}:${stat.mtimeMs}:${stat.size}:${width}`)
    .digest("hex");
  const thumbPath = path.join(THUMB_CACHE_ROOT, `${key}.jpg`);
  if (!fs.existsSync(thumbPath)) {
    fs.mkdirSync(THUMB_CACHE_ROOT, { recursive: true });
    const tempPath = `${thumbPath}.tmp-${process.pid}`;
    await sharp(framePath)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .jpeg({ quality: 55, mozjpeg: true })
      .toFile(tempPath);
    fs.renameSync(tempPath, thumbPath);
  }
  return thumbPath;
}

function summarizeSession(session) {
  const annotation = readAnnotation(session.session_id);
  return {
    session_id: session.session_id,
    collection_folder: session.collection_folder,
    relative_path: session.relative_path,
    frame_count: session.frame_count,
    app_run_count: session.app_runs.length,
    segment_count: annotation.segments.length,
    match_stat_count: annotation.match_stats.length,
    total_matches: annotation.session_details?.total_matches || "",
    updated_at: annotation.updated_at,
  };
}

app.use(express.json({ limit: "4mb" }));

app.get("/api/manifest", (_req, res) => {
  const manifest = readManifest();
  res.json({
    manifest_version: manifest.manifest_version,
    generated_at: manifest.generated_at,
    session_count: manifest.sessions.length,
    app_run_count: manifest.sessions.reduce(
      (sum, session) => sum + session.app_runs.length,
      0,
    ),
    frame_count: manifest.sessions.reduce((sum, session) => sum + session.frame_count, 0),
  });
});

app.get("/api/sessions", (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  let sessions = readManifest().sessions.map(summarizeSession);
  if (q) {
    sessions = sessions.filter((session) =>
      [session.session_id, session.relative_path, session.collection_folder]
        .join(" ")
        .toLowerCase()
        .includes(q),
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
  res.json({ session, annotation: readAnnotation(session.session_id) });
});

app.get("/api/sessions/:sessionId/frames", (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const offset = Math.max(0, Number(req.query.offset || 0));
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 72)));
  const frames = listFrames(session.frames_path);
  res.json({
    offset,
    limit,
    total: frames.length,
    frames: frames.slice(offset, offset + limit).map((name, index) => ({
      name,
      index: offset + index,
      url: `/api/sessions/${encodeURIComponent(
        session.session_id,
      )}/frames/${encodeURIComponent(name)}`,
      thumb_url: `/api/sessions/${encodeURIComponent(
        session.session_id,
      )}/frames/${encodeURIComponent(name)}/thumb`,
    })),
  });
});

app.get("/api/sessions/:sessionId/frames/:frameName/thumb", async (req, res) => {
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

  try {
    const thumbPath = await cachedThumbnail(framePath, req.query.size);
    res.set("Cache-Control", "public, max-age=86400");
    res.type("jpg");
    res.sendFile(thumbPath);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
  res.set("Cache-Control", "public, max-age=3600");
  res.sendFile(framePath);
});

app.put("/api/annotations/:sessionId", (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  try {
    const annotation = writeAnnotation(session.session_id, req.body || {});
    res.json({ annotation });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

const distPath = path.resolve(__dirname, "../dist");
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Dataset annotator running on http://0.0.0.0:${PORT}`);
  console.log(`Manifest: ${MANIFEST_PATH}`);
  console.log(`Annotations: ${ANNOTATIONS_ROOT}`);
});
