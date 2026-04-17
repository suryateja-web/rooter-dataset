import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

const PORT = Number(process.env.PORT || 4300);
const DATASET_ROOT = process.env.DATASET_ROOT || "/home/ec2-user/dataset";
const MANIFEST_PATH =
  process.env.MANIFEST_PATH || path.join(DATASET_ROOT, "manifest.json");
const RAW_ROOT = process.env.RAW_ROOT || path.join(DATASET_ROOT, "raw_data");
const THUMB_CACHE_ROOT =
  process.env.THUMB_CACHE_ROOT || path.join(DATASET_ROOT, ".cache", "thumbnails");
const ANNOTATIONS_ROOT =
  process.env.ANNOTATIONS_ROOT || path.join(DATASET_ROOT, "annotations");
const MLFLOW_TRACKING_URI =
  process.env.MLFLOW_TRACKING_URI || "http://127.0.0.1:5000";
const MLFLOW_ARTIFACT_ROOT =
  process.env.MLFLOW_ARTIFACT_ROOT || "/home/ec2-user/mlflow_server/mlartifacts";

let manifestCache = null;
let manifestMtimeMs = 0;
const rawDetectionCache = new Map();
const stateResolutionCache = new Map();

function readJsonIfExists(filePath, fallback = null) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

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

function annotationPath(sessionId) {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId || "")) return null;
  return path.join(ANNOTATIONS_ROOT, `${sessionId}.json`);
}

function readAnnotation(sessionId) {
  return (
    readJsonIfExists(annotationPath(sessionId), null) || {
      version: 1,
      session_id: sessionId,
      session_details: { total_matches: "", notes: "" },
      segments: [],
      match_stats: [],
      extra: {},
    }
  );
}

async function mlflowPost(endpoint, body = {}) {
  const response = await fetch(`${MLFLOW_TRACKING_URI}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`MLflow ${endpoint} returned ${response.status}`);
  }
  return response.json();
}

async function mlflowGet(endpoint) {
  const response = await fetch(`${MLFLOW_TRACKING_URI}${endpoint}`);
  if (!response.ok) {
    throw new Error(`MLflow ${endpoint} returned ${response.status}`);
  }
  return response.json();
}

function tagsToObject(tags = []) {
  return Object.fromEntries(tags.map((tag) => [tag.key, tag.value]));
}

function paramsToObject(params = []) {
  return Object.fromEntries(params.map((param) => [param.key, param.value]));
}

function metricsToObject(metrics = []) {
  return Object.fromEntries(metrics.map((metric) => [metric.key, metric.value]));
}

function runArtifactRoot(run) {
  return path.join(MLFLOW_ARTIFACT_ROOT, run.info.experiment_id, run.info.run_id, "artifacts");
}

function listArtifacts(root, relative = "") {
  const dir = path.join(root, relative);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(relative, entry.name);
    if (entry.isDirectory()) return listArtifacts(root, rel);
    return [rel];
  });
}

function readRunArtifact(run, name) {
  const root = runArtifactRoot(run);
  const filePath = path.join(root, name);
  if (!filePath.startsWith(root) || !fs.existsSync(filePath)) return null;
  if (name.endsWith(".json")) return JSON.parse(fs.readFileSync(filePath, "utf8"));
  return fs.readFileSync(filePath, "utf8");
}

function readImageSize(filePath) {
  const buffer = fs.readFileSync(filePath);

  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer.toString("ascii", 1, 4) === "PNG"
  ) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }

      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          width: buffer.readUInt16BE(offset + 7),
          height: buffer.readUInt16BE(offset + 5),
        };
      }
      offset += 2 + length;
    }
  }

  return null;
}

function detectionRunFormat(session, rawJsonPath) {
  const resolvedRawPath = path.resolve(rawJsonPath || "");
  const appRun = session?.app_runs?.find(
    (run) => path.resolve(run.raw_json_path || "") === resolvedRawPath,
  );
  return appRun?.raw_output_format || "";
}

function scaleBox(box, scaleX, scaleY) {
  if (!box) return box;
  if (Array.isArray(box)) {
    return [
      Math.round(Number(box[0] || 0) * scaleX),
      Math.round(Number(box[1] || 0) * scaleY),
      Math.round(Number(box[2] || 0) * scaleX),
      Math.round(Number(box[3] || 0) * scaleY),
    ];
  }

  return {
    ...box,
    left: Math.round(Number(box.left || 0) * scaleX),
    top: Math.round(Number(box.top || 0) * scaleY),
    right: Math.round(Number(box.right || 0) * scaleX),
    bottom: Math.round(Number(box.bottom || 0) * scaleY),
  };
}

function normalizeDetectionBoxes(detections, imageSize, rawOutputFormat) {
  if (!imageSize || rawOutputFormat !== "phone_detection_array_v1") {
    return {
      detections,
      coordinate_space: "raw",
      source_size: null,
      image_size: imageSize,
    };
  }

  const sourceSize = { width: 640, height: 640 };
  const scaleX = imageSize.width / sourceSize.width;
  const scaleY = imageSize.height / sourceSize.height;

  return {
    coordinate_space: "image",
    source_size: sourceSize,
    image_size: imageSize,
    detections: detections.map((detection) => {
      const normalized = { ...detection };
      if (detection.boundingBox) {
        normalized.rawBoundingBox = detection.boundingBox;
        normalized.boundingBox = scaleBox(detection.boundingBox, scaleX, scaleY);
      }
      if (detection.bbox) {
        normalized.rawBbox = detection.bbox;
        normalized.bbox = scaleBox(detection.bbox, scaleX, scaleY);
      }
      if (Array.isArray(detection.ocrBlocks)) {
        normalized.ocrBlocks = detection.ocrBlocks.map((block) => ({
          ...block,
          rawRect: block.rect,
          rect: block.rect ? scaleBox(block.rect, scaleX, scaleY) : block.rect,
        }));
      }
      return normalized;
    }),
  };
}

function normalizePredictedSegments(result) {
  const matches = Array.isArray(result?.matches) ? result.matches : [];
  return matches
    .map((item, index) => {
      const start = item.start_frame ?? item.startFrame ?? item.start ?? null;
      const end = item.end_frame ?? item.endFrame ?? item.end ?? null;
      return {
        id: `prediction_${index + 1}`,
        match_id: item.match_id || `match_${String(item.match || index + 1).padStart(3, "0")}`,
        start_frame: start,
        end_frame: end,
        type: item.type || "match",
        kills: item.kills ?? "",
        assists: item.assists ?? "",
        is_alive: item.is_alive ?? item.status ?? "",
        raw: item,
      };
    });
}

function flattenDetections(raw) {
  if (!Array.isArray(raw)) return { frames: [], byFrame: {} };
  const byFrame = {};
  const frames = [];
  const seen = new Set();

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;

    if (Array.isArray(item.detections)) {
      const fileName = item.fileName || item.image || "";
      const frameName = path.basename(String(fileName));
      if (frameName && !seen.has(frameName)) {
        seen.add(frameName);
        frames.push(frameName);
      }
      if (!frameName) continue;
      byFrame[frameName] ||= [];
      for (const detection of item.detections) {
        if (detection && typeof detection === "object") {
          byFrame[frameName].push(detection);
        }
      }
    } else {
      const frameName = path.basename(String(item.image || item.fileName || ""));
      if (frameName && !seen.has(frameName)) {
        seen.add(frameName);
        frames.push(frameName);
      }
      if (!frameName) continue;
      byFrame[frameName] ||= [];
      byFrame[frameName].push(item);
    }
  }

  frames.sort();
  return { frames, byFrame };
}

function readRawDetections(rawJsonPath) {
  if (!rawJsonPath || !fs.existsSync(rawJsonPath)) return { frames: [], byFrame: {} };
  const stat = fs.statSync(rawJsonPath);
  const key = `${rawJsonPath}:${stat.mtimeMs}`;
  if (!rawDetectionCache.has(key)) {
    rawDetectionCache.clear();
    rawDetectionCache.set(key, flattenDetections(JSON.parse(fs.readFileSync(rawJsonPath, "utf8"))));
  }
  return rawDetectionCache.get(key);
}

function readStateResolution(run) {
  const artifactPath = path.join(
    runArtifactRoot(run),
    "postprocessor_debug",
    "state_resolution.json",
  );
  if (!fs.existsSync(artifactPath)) return null;

  const stat = fs.statSync(artifactPath);
  const key = `${artifactPath}:${stat.mtimeMs}`;
  if (!stateResolutionCache.has(key)) {
    stateResolutionCache.clear();
    stateResolutionCache.set(key, JSON.parse(fs.readFileSync(artifactPath, "utf8")));
  }
  return stateResolutionCache.get(key);
}

function findFrameResolution(stateResolution, frameName) {
  if (!stateResolution || !frameName) return null;

  if (Array.isArray(stateResolution)) {
    return stateResolution.find((item) => item?.frame === frameName) || null;
  }

  const candidates = [
    stateResolution.frames,
    stateResolution.frame_resolution,
    stateResolution.frame_resolutions,
    stateResolution.resolutions,
    stateResolution.per_frame,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const match = candidate.find((item) => item?.frame === frameName);
      if (match) return match;
    }
    if (candidate && typeof candidate === "object" && candidate[frameName]) {
      return candidate[frameName];
    }
  }

  if (stateResolution[frameName]) return stateResolution[frameName];
  return null;
}

function stateRulesFromResolution(stateResolution) {
  if (!stateResolution || typeof stateResolution !== "object") return null;

  const explicitRules =
    stateResolution.rules ||
    stateResolution.rule_config ||
    stateResolution.state_rules;
  if (explicitRules) return explicitRules;

  if (!stateResolution.per_state || typeof stateResolution.per_state !== "object") {
    return null;
  }

  return Object.fromEntries(
    Object.entries(stateResolution.per_state).map(([state, data]) => [
      state,
      data?.rule || { rule_found: Boolean(data?.rule_found) },
    ]),
  );
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

app.use(express.json());

app.get("/api/mlflow/experiments", async (_req, res) => {
  try {
    const data = await mlflowPost("/api/2.0/mlflow/experiments/search", {
      max_results: 200,
    });
    res.json({ experiments: data.experiments || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/mlflow/experiments/:experimentId/runs", async (req, res) => {
  try {
    const data = await mlflowPost("/api/2.0/mlflow/runs/search", {
      experiment_ids: [req.params.experimentId],
      max_results: 100,
      order_by: ["attributes.start_time DESC"],
    });
    const runs = (data.runs || []).map((run) => ({
      info: run.info,
      tags: tagsToObject(run.data?.tags || []),
      params: paramsToObject(run.data?.params || []),
      metrics: metricsToObject(run.data?.metrics || []),
    }));
    res.json({ runs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/mlflow/runs/:runId/debug", async (req, res) => {
  try {
    const data = await mlflowGet(
      `/api/2.0/mlflow/runs/get?run_id=${encodeURIComponent(req.params.runId)}`,
    );
    const run = data.run;
    const artifactNames = listArtifacts(runArtifactRoot(run));
    const runInput = readRunArtifact(run, "run_input.json");
    const result = readRunArtifact(run, "result.json");
    const summary = readRunArtifact(run, "summary.json");
    const runResult = readRunArtifact(run, "run_result.json");
    const tags = tagsToObject(run.data?.tags || []);
    const params = paramsToObject(run.data?.params || []);
    const metrics = metricsToObject(run.data?.metrics || []);
    const sessionId = tags.session_id || runInput?.session_id || "";
    const session = sessionId ? getSession(sessionId) : null;
    const annotation = sessionId ? readAnnotation(sessionId) : null;

    res.json({
      run: { info: run.info, tags, params, metrics },
      artifacts: artifactNames,
      run_input: runInput,
      result,
      summary,
      run_result: runResult,
      session,
      annotation,
      predicted_segments: normalizePredictedSegments(result),
      has_state_resolution: artifactNames.includes(
        "postprocessor_debug/state_resolution.json",
      ),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/mlflow/runs/:runId/detections", async (req, res) => {
  try {
    const data = await mlflowGet(
      `/api/2.0/mlflow/runs/get?run_id=${encodeURIComponent(req.params.runId)}`,
    );
    const tags = tagsToObject(data.run.data?.tags || []);
    const runInput = readRunArtifact(data.run, "run_input.json");
    const rawDetections = readRawDetections(runInput?.raw_json_path);
    const frameName = String(req.query.frame || "");
    const sessionId = tags.session_id || runInput?.session_id || "";
    const session = sessionId ? getSession(sessionId) : null;
    const framePath = session ? safeFramePath(session, frameName) : null;
    const imageSize = framePath && fs.existsSync(framePath) ? readImageSize(framePath) : null;
    const rawOutputFormat = detectionRunFormat(session, runInput?.raw_json_path);
    const normalized = normalizeDetectionBoxes(
      rawDetections.byFrame[frameName] || [],
      imageSize,
      rawOutputFormat,
    );

    res.json({
      frame: frameName,
      detections: normalized.detections,
      coordinate_space: normalized.coordinate_space,
      source_size: normalized.source_size,
      image_size: normalized.image_size,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/mlflow/runs/:runId/state-resolution", async (req, res) => {
  try {
    const data = await mlflowGet(
      `/api/2.0/mlflow/runs/get?run_id=${encodeURIComponent(req.params.runId)}`,
    );
    const stateResolution = readStateResolution(data.run);
    const frameName = String(req.query.frame || "");
    const resolution = findFrameResolution(stateResolution, frameName);

    res.json({
      available: Boolean(stateResolution),
      frame: frameName,
      target_state_order:
        stateResolution?.target_state_order ||
        stateResolution?.target_states ||
        stateResolution?.state_order ||
        [],
      rules: stateRulesFromResolution(stateResolution),
      top_level_keys:
        stateResolution && typeof stateResolution === "object"
          ? Object.keys(stateResolution)
          : [],
      resolution,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
      url: `/api/sessions/${encodeURIComponent(session.session_id)}/frames/${encodeURIComponent(
        name,
      )}`,
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

const distPath = path.resolve(__dirname, "../dist");
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Dataset debugger running on http://0.0.0.0:${PORT}`);
  console.log(`MLflow: ${MLFLOW_TRACKING_URI}`);
});
