import React, { useEffect, useMemo, useState } from "react";

const API =
  import.meta.env.VITE_API_BASE ||
  (window.location.port === "5175"
    ? `${window.location.protocol}//${window.location.hostname}:4300`
    : window.location.origin);
const PAGE_SIZE = 72;

async function fetchJson(path) {
  const response = await fetch(`${API}${path}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `${response.status} ${response.statusText}`);
  }
  return response.json();
}

function number(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function fmtTime(ms) {
  if (!ms) return "";
  return new Date(Number(ms)).toLocaleString();
}

function boxLabel(det) {
  const label = det?.category?.label || det?.label || "unknown";
  const conf = det?.category?.confidence ?? det?.confidence;
  return conf == null ? label : `${label} ${Number(conf).toFixed(2)}`;
}

function ocrItemsFromDetections(detections) {
  const items = [];
  for (const det of detections) {
    const label = det?.category?.label || det?.label || "unknown";
    if (det?.ocrText) {
      items.push({
        label,
        text: det.ocrText,
        rect: det.boundingBox || det.bbox,
        source: "ocrText",
      });
    }
    if (Array.isArray(det?.ocrBlocks)) {
      for (const block of det.ocrBlocks) {
        if (!block?.text) continue;
        items.push({
          label,
          text: block.text,
          rect: block.rect || det.boundingBox || det.bbox,
          source: "ocrBlocks",
        });
      }
    }
  }
  return items;
}

function getBox(det) {
  const box = det?.boundingBox || det?.bbox || {};
  if (Array.isArray(box)) {
    return { left: box[0], top: box[1], right: box[2], bottom: box[3] };
  }
  return box;
}

function segmentHasRange(segment) {
  return segment.start_frame !== null && segment.start_frame !== "" && segment.end_frame !== null && segment.end_frame !== "";
}

function firstPresent(object, keys) {
  for (const key of keys) {
    if (object && object[key] !== undefined && object[key] !== null) {
      return object[key];
    }
  }
  return "";
}

function renderValue(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function labelsFromRuleChecks(ruleChecks) {
  const labels = new Map();
  for (const check of Object.values(ruleChecks || {})) {
    for (const item of check?.labels || []) {
      labels.set(item.label, item.confidence);
    }
  }
  return [...labels.entries()].map(([label, confidence]) => ({ label, confidence }));
}

function passedLabelsFromRuleChecks(ruleChecks) {
  const passed = {};
  for (const [state, check] of Object.entries(ruleChecks || {})) {
    passed[state] = check?.present_labels || [];
  }
  return passed;
}

function statePassStatus(check) {
  if (!check) return "";
  if (check.base_match) return "base match";
  const reasons = [];
  if (!check.has_all) reasons.push("missing required_all");
  if (!check.has_any) reasons.push("missing required_any");
  if (!check.no_forbidden) reasons.push("forbidden label");
  return reasons.join(", ") || "filtered by run logic";
}

function App() {
  const [experiments, setExperiments] = useState([]);
  const [selectedExperimentId, setSelectedExperimentId] = useState("");
  const [runs, setRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [debugData, setDebugData] = useState(null);
  const [frames, setFrames] = useState({ total: 0, offset: 0, frames: [] });
  const [frameOffset, setFrameOffset] = useState(0);
  const [selectedFrame, setSelectedFrame] = useState(null);
  const [detections, setDetections] = useState([]);
  const [detectionMeta, setDetectionMeta] = useState(null);
  const [frameDataLoaded, setFrameDataLoaded] = useState(false);
  const [showDetections, setShowDetections] = useState(true);
  const [showOcr, setShowOcr] = useState(true);
  const [stateResolution, setStateResolution] = useState(null);
  const [stateResolutionLoaded, setStateResolutionLoaded] = useState(false);
  const [imageSize, setImageSize] = useState({ width: 1, height: 1 });
  const [labelFilter, setLabelFilter] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("Loading");

  useEffect(() => {
    fetchJson("/api/mlflow/experiments")
      .then((data) => {
        const items = data.experiments || [];
        setExperiments(items);
        const postprocessor =
          items.find((item) => item.name === "postprocessor") || items[0];
        if (postprocessor) setSelectedExperimentId(postprocessor.experiment_id);
      })
      .catch((err) => setError(err.message))
      .finally(() => setStatus("Ready"));
  }, []);

  useEffect(() => {
    if (!selectedExperimentId) return;
    setStatus("Loading runs");
    setRuns([]);
    setSelectedRunId("");
    fetchJson(`/api/mlflow/experiments/${selectedExperimentId}/runs`)
      .then((data) => {
        setRuns(data.runs || []);
        if (data.runs?.[0]) setSelectedRunId(data.runs[0].info.run_id);
      })
      .catch((err) => setError(err.message))
      .finally(() => setStatus("Ready"));
  }, [selectedExperimentId]);

  useEffect(() => {
    if (!selectedRunId) return;
    setStatus("Loading run");
    setDebugData(null);
    setFrameOffset(0);
    setSelectedFrame(null);
    setDetections([]);
    fetchJson(`/api/mlflow/runs/${selectedRunId}/debug`)
      .then(setDebugData)
      .catch((err) => setError(err.message))
      .finally(() => setStatus("Ready"));
  }, [selectedRunId]);

  useEffect(() => {
    if (!debugData?.session?.session_id) return;
    fetchJson(
      `/api/sessions/${encodeURIComponent(
        debugData.session.session_id,
      )}/frames?offset=${frameOffset}&limit=${PAGE_SIZE}`,
    )
      .then((data) => {
        setFrames(data);
        if (data.frames?.[0]) setSelectedFrame(data.frames[0]);
      })
      .catch((err) => setError(err.message));
  }, [debugData?.session?.session_id, frameOffset]);

  useEffect(() => {
    setDetections([]);
    setDetectionMeta(null);
    setFrameDataLoaded(false);
    setStateResolution(null);
    setStateResolutionLoaded(false);
    setLabelFilter("");
  }, [selectedRunId, selectedFrame]);

  async function loadDetections() {
    if (!selectedRunId || !selectedFrame) return;
    setStatus("Loading detections");
    try {
      const data = await fetchJson(
        `/api/mlflow/runs/${selectedRunId}/detections?frame=${encodeURIComponent(
          selectedFrame.name,
        )}`,
      );
      setDetections(data.detections || []);
      setDetectionMeta({
        coordinate_space: data.coordinate_space || "",
        source_size: data.source_size || null,
        image_size: data.image_size || null,
      });
      setFrameDataLoaded(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setStatus("Ready");
    }
  }

  async function loadStateResolution() {
    if (!selectedRunId || !selectedFrame) return;
    setStatus("Loading state why");
    try {
      const data = await fetchJson(
        `/api/mlflow/runs/${selectedRunId}/state-resolution?frame=${encodeURIComponent(
          selectedFrame.name,
        )}`,
      );
      setStateResolution(data);
      setStateResolutionLoaded(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setStatus("Ready");
    }
  }

  const selectedExperiment = experiments.find(
    (item) => item.experiment_id === selectedExperimentId,
  );

  const labelOptions = useMemo(() => {
    return [
      ...new Set(
        detections.map((det) => det?.category?.label || det?.label || "unknown"),
      ),
    ].sort();
  }, [detections]);

  const filteredDetections = labelFilter
    ? detections.filter((det) => (det?.category?.label || det?.label) === labelFilter)
    : detections;
  const ocrItems = ocrItemsFromDetections(detections);
  const filteredOcrItems = labelFilter
    ? ocrItems.filter((item) => item.label === labelFilter)
    : ocrItems;

  const gtSegments = debugData?.annotation?.segments || [];
  const gtStats = debugData?.annotation?.match_stats || [];
  const predicted = debugData?.predicted_segments || [];
  const frameCount = debugData?.session?.frame_count || debugData?.summary?.frames_total || 1;
  const frameUrl =
    selectedFrame && debugData?.session
      ? `${API}${selectedFrame.url}`
      : "";
  const frameWhy = stateResolution?.resolution || null;
  const finalState = firstPresent(frameWhy, [
    "final_state",
    "assigned_state",
    "state",
    "resolved_state",
  ]);
  const candidateStates = firstPresent(frameWhy, [
    "candidate_states",
    "candidates",
    "applied_states",
  ]);
  const detectedLabels =
    firstPresent(frameWhy, [
      "labels",
      "detected_labels",
      "label_confidences",
      "labels_by_frame",
    ]) || labelsFromRuleChecks(frameWhy?.rule_checks);
  const passedLabels =
    firstPresent(frameWhy, [
      "passed_labels",
      "labels_passing_threshold",
      "present_labels",
    ]) || passedLabelsFromRuleChecks(frameWhy?.rule_checks);

  return (
    <main>
      <header className="topbar">
        <div>
          <h1>Dataset Debugger</h1>
          <p>MLflow run vs ground truth, with raw detection overlays</p>
        </div>
        <div className="meta">
          <span>{status}</span>
          <span>{selectedExperiment?.name || ""}</span>
        </div>
      </header>

      {error ? <div className="error">{error}</div> : null}

      <section className="selectors">
        <label>
          Experiment
          <select
            value={selectedExperimentId}
            onChange={(event) => setSelectedExperimentId(event.target.value)}
          >
            {experiments.map((experiment) => (
              <option key={experiment.experiment_id} value={experiment.experiment_id}>
                {experiment.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Run
          <select
            value={selectedRunId}
            onChange={(event) => setSelectedRunId(event.target.value)}
          >
            {runs.map((run) => (
              <option key={run.info.run_id} value={run.info.run_id}>
                {run.tags.session_id || run.info.run_name || run.info.run_id}
              </option>
            ))}
          </select>
        </label>
      </section>

      <div className="layout">
        <section className="runs">
          <div className="section-title">
            <h2>Runs</h2>
            <span>{number(runs.length)}</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Run</th>
                  <th>Matches</th>
                  <th>Return</th>
                  <th>Start</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr
                    key={run.info.run_id}
                    className={run.info.run_id === selectedRunId ? "active" : ""}
                    onClick={() => setSelectedRunId(run.info.run_id)}
                  >
                    <td>{run.tags.session_id || ""}</td>
                    <td title={run.info.run_id}>{run.info.run_name || run.info.run_id}</td>
                    <td>{run.metrics.match_count ?? ""}</td>
                    <td>{run.metrics.returncode ?? ""}</td>
                    <td>{fmtTime(run.info.start_time)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="workspace">
          {debugData ? (
            <>
              <div className="section-title">
                <h2>{debugData.session?.relative_path || "No dataset session"}</h2>
                <span>{debugData.run.info.run_id}</span>
              </div>

              <section className="panel facts">
                <div>
                  <strong>{debugData.run.tags.session_id || "-"}</strong>
                  <span>session</span>
                </div>
                <div>
                  <strong>{debugData.run.tags.app_run_id || "-"}</strong>
                  <span>app run</span>
                </div>
                <div>
                  <strong>{number(debugData.summary?.match_count)}</strong>
                  <span>predicted matches</span>
                </div>
                <div>
                  <strong>{number(gtSegments.length)}</strong>
                  <span>truth segments</span>
                </div>
              </section>

              <section className="panel">
                <div className="panel-head">
                  <h3>Segment Timeline</h3>
                  <span>{number(frameCount)} frames</span>
                </div>
                <div className="timeline">
                  {gtSegments.filter(segmentHasRange).map((segment) => {
                    const start = Number(segment.start_frame || 0);
                    const end = Number(segment.end_frame || start);
                    return (
                      <div
                        key={segment.id}
                        className="bar truth"
                        style={{
                          left: `${(start / frameCount) * 100}%`,
                          width: `${Math.max(0.4, ((end - start + 1) / frameCount) * 100)}%`,
                        }}
                        title={`truth ${segment.match_id} ${start}-${end}`}
                      >
                        {segment.match_id}
                      </div>
                    );
                  })}
                  {predicted.filter(segmentHasRange).map((segment) => {
                    const start = Number(segment.start_frame || 0);
                    const end = Number(segment.end_frame || start);
                    return (
                      <div
                        key={segment.id}
                        className="bar pred"
                        style={{
                          left: `${(start / frameCount) * 100}%`,
                          width: `${Math.max(0.4, ((end - start + 1) / frameCount) * 100)}%`,
                        }}
                        title={`pred ${segment.match_id} ${start}-${end}`}
                      >
                        {segment.match_id}
                      </div>
                    );
                  })}
                  {selectedFrame ? (
                    <div
                      className="cursor"
                      style={{ left: `${(selectedFrame.index / frameCount) * 100}%` }}
                    />
                  ) : null}
                </div>
                <div className="legend">
                  <span>black = ground truth</span>
                  <span>white = prediction</span>
                  <span>
                    state_resolution:{" "}
                    {debugData.has_state_resolution ? "available" : "not in this run"}
                  </span>
                </div>
              </section>

              <div className="compare-grid">
                <section className="panel">
                  <div className="panel-head">
                    <h3>Ground Truth</h3>
                    <span>{debugData.annotation?.updated_at || "not annotated"}</span>
                  </div>
                  <div className="table-wrap compact">
                    <table>
                      <thead>
                        <tr>
                          <th>Match</th>
                          <th>Start</th>
                          <th>End</th>
                          <th>Kills</th>
                          <th>Alive</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(gtSegments.length
                          ? gtSegments.map((segment) => {
                              const stat = gtStats.find(
                                (item) => item.match_id === segment.match_id,
                              );
                              return {
                                key: segment.id || segment.match_id,
                                match_id: segment.match_id,
                                start_frame: segment.start_frame,
                                end_frame: segment.end_frame,
                                kills: stat?.kills ?? "",
                                is_alive: stat?.is_alive ?? "",
                              };
                            })
                          : gtStats.map((stat) => ({
                              key: stat.id || stat.match_id,
                              match_id: stat.match_id,
                              start_frame: "",
                              end_frame: "",
                              kills: stat.kills ?? "",
                              is_alive: stat.is_alive ?? "",
                            }))
                        ).map((row) => (
                          <tr key={row.key}>
                            <td>{row.match_id}</td>
                            <td>{row.start_frame}</td>
                            <td>{row.end_frame}</td>
                            <td>{row.kills}</td>
                            <td>{row.is_alive}</td>
                          </tr>
                        ))}
                        {!gtSegments.length && !gtStats.length ? (
                          <tr>
                            <td colSpan="5">No ground truth matches yet</td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="panel">
                  <div className="panel-head">
                    <h3>Prediction</h3>
                    <span>{debugData.artifacts.includes("result.json") ? "result.json" : "no result"}</span>
                  </div>
                  <div className="table-wrap compact">
                    <table>
                      <thead>
                        <tr>
                          <th>Match</th>
                          <th>Start</th>
                          <th>End</th>
                          <th>Kills</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {predicted.map((segment) => (
                          <tr key={segment.id}>
                            <td>{segment.match_id}</td>
                            <td>{segment.start_frame ?? ""}</td>
                            <td>{segment.end_frame ?? ""}</td>
                            <td>{segment.kills}</td>
                            <td>{String(segment.is_alive)}</td>
                          </tr>
                        ))}
                        {!predicted.length ? (
                          <tr>
                            <td colSpan="5">No prediction result loaded</td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>

              <section className="panel">
                <div className="panel-head">
                  <h3>Detections</h3>
                  <div className="pager">
                    <button disabled={!selectedFrame} onClick={loadDetections}>
                      {frameDataLoaded ? "Reload Frame Data" : "Load Frame Data"}
                    </button>
                    <button
                      disabled={!selectedFrame || !debugData.has_state_resolution}
                      onClick={loadStateResolution}
                    >
                      {stateResolutionLoaded ? "Reload State Why" : "Load State Why"}
                    </button>
                    <button
                      className={showDetections ? "toggle active-toggle" : "toggle"}
                      onClick={() => setShowDetections(!showDetections)}
                    >
                      Detections
                    </button>
                    <button
                      className={showOcr ? "toggle active-toggle" : "toggle"}
                      onClick={() => setShowOcr(!showOcr)}
                    >
                      OCR
                    </button>
                    <label>
                      Label
                      <select
                        value={labelFilter}
                        onChange={(event) => setLabelFilter(event.target.value)}
                      >
                        <option value="">All</option>
                        {labelOptions.map((label) => (
                          <option key={label} value={label}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      disabled={frameOffset === 0}
                      onClick={() => setFrameOffset(Math.max(0, frameOffset - PAGE_SIZE))}
                    >
                      Prev
                    </button>
                    <span>
                      {number(frameOffset + 1)}-
                      {number(Math.min(frameOffset + PAGE_SIZE, frames.total))} of{" "}
                      {number(frames.total)}
                    </span>
                    <button
                      disabled={frameOffset + PAGE_SIZE >= frames.total}
                      onClick={() => setFrameOffset(frameOffset + PAGE_SIZE)}
                    >
                      Next
                    </button>
                  </div>
                </div>

                <div className="debug-frame">
                  <div className="image-wrap">
                    {frameUrl ? (
                      <>
                        <img
                          src={frameUrl}
                          alt={selectedFrame?.name || "frame"}
                          onLoad={(event) =>
                            setImageSize({
                              width: event.currentTarget.naturalWidth || 1,
                              height: event.currentTarget.naturalHeight || 1,
                            })
                          }
                        />
                        {showDetections ? filteredDetections.map((det, index) => {
                          const box = getBox(det);
                          const left = (Number(box.left || 0) / imageSize.width) * 100;
                          const top = (Number(box.top || 0) / imageSize.height) * 100;
                          const width =
                            ((Number(box.right || 0) - Number(box.left || 0)) /
                              imageSize.width) *
                            100;
                          const height =
                            ((Number(box.bottom || 0) - Number(box.top || 0)) /
                              imageSize.height) *
                            100;
                          return (
                            <div
                              className="bbox"
                              key={`${boxLabel(det)}_${index}`}
                              style={{
                                left: `${left}%`,
                                top: `${top}%`,
                                width: `${width}%`,
                                height: `${height}%`,
                              }}
                              title={boxLabel(det)}
                            >
                              <span>{boxLabel(det)}</span>
                            </div>
                          );
                        }) : null}
                        {showOcr ? filteredOcrItems.map((item, index) => {
                          const box = getBox({ boundingBox: item.rect });
                          const left = (Number(box.left || 0) / imageSize.width) * 100;
                          const top = (Number(box.top || 0) / imageSize.height) * 100;
                          const width =
                            ((Number(box.right || 0) - Number(box.left || 0)) /
                              imageSize.width) *
                            100;
                          const height =
                            ((Number(box.bottom || 0) - Number(box.top || 0)) /
                              imageSize.height) *
                            100;
                          return (
                            <div
                              className="ocr-box"
                              key={`${item.label}_${item.text}_${index}`}
                              style={{
                                left: `${left}%`,
                                top: `${top}%`,
                                width: `${width}%`,
                                height: `${height}%`,
                              }}
                              title={`${item.label}: ${item.text}`}
                            >
                              <span>{item.text}</span>
                            </div>
                          );
                        }) : null}
                      </>
                    ) : null}
                  </div>

                  <div className="detection-list">
                    <strong>
                      {selectedFrame ? `${selectedFrame.index} ${selectedFrame.name}` : "No frame"}
                    </strong>
                    <span>
                      {number(filteredDetections.length)} detections,{" "}
                      {number(filteredOcrItems.length)} OCR items
                    </span>
                    {detectionMeta?.coordinate_space ? (
                      <span>
                        boxes: {detectionMeta.coordinate_space}
                        {detectionMeta.source_size && detectionMeta.image_size
                          ? ` ${detectionMeta.source_size.width}x${detectionMeta.source_size.height} -> ${detectionMeta.image_size.width}x${detectionMeta.image_size.height}`
                          : ""}
                      </span>
                    ) : null}
                    {!frameDataLoaded ? <div>Click Load Frame Data.</div> : null}
                    {showDetections ? (
                      <>
                        <b>Detections</b>
                        {filteredDetections.slice(0, 80).map((det, index) => (
                          <div key={`det_${index}`}>{boxLabel(det)}</div>
                        ))}
                      </>
                    ) : null}
                    {showOcr ? (
                      <>
                        <b>OCR</b>
                        {filteredOcrItems.slice(0, 120).map((item, index) => (
                          <div key={`ocr_${index}`}>
                            {item.label}: {item.text}
                          </div>
                        ))}
                      </>
                    ) : null}
                  </div>
                </div>

                <div className="state-resolution">
                  <div className="state-summary">
                    <strong>State resolution</strong>
                    <span>
                      {selectedFrame ? selectedFrame.name : "No frame"}{" "}
                      {stateResolutionLoaded ? "" : "- click Load State Why"}
                    </span>
                  </div>
                  {stateResolutionLoaded && !stateResolution?.available ? (
                    <div>No state_resolution.json artifact in this run.</div>
                  ) : null}
                  {stateResolutionLoaded && stateResolution?.available && !frameWhy ? (
                    <div>No state-resolution entry found for this frame.</div>
                  ) : null}
                  {frameWhy ? (
                    <div className="state-grid">
                      <div>
                        <b>Final state</b>
                        <span>{renderValue(finalState)}</span>
                      </div>
                      <div>
                        <b>Candidate states</b>
                        <span>{renderValue(candidateStates)}</span>
                      </div>
                      <div>
                        <b>Passed labels</b>
                        <span>{renderValue(passedLabels)}</span>
                      </div>
                      <div>
                        <b>Detected labels</b>
                        <span>{renderValue(detectedLabels)}</span>
                      </div>
                    </div>
                  ) : null}
                  {frameWhy?.rule_checks ? (
                    <div className="rule-table-wrap">
                      <table className="rule-table">
                        <thead>
                          <tr>
                            <th>State</th>
                            <th>Base</th>
                            <th>All</th>
                            <th>Any</th>
                            <th>Forbidden</th>
                            <th>Why</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(frameWhy.rule_checks).map(([state, check]) => (
                            <tr
                              key={state}
                              className={
                                state === finalState
                                  ? "active"
                                  : frameWhy.candidate_states?.includes(state)
                                    ? "candidate"
                                    : ""
                              }
                            >
                              <td>{state}</td>
                              <td>{check.base_match ? "yes" : "no"}</td>
                              <td>{check.has_all ? "yes" : check.required_all_missing?.join(", ")}</td>
                              <td>{check.has_any ? "yes" : "no"}</td>
                              <td>{check.no_forbidden ? "none" : check.forbidden_present?.join(", ")}</td>
                              <td>{statePassStatus(check)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                  {stateResolution?.target_state_order?.length ? (
                    <div className="state-priority">
                      Priority: {stateResolution.target_state_order.join(" -> ")}
                    </div>
                  ) : null}
                  {frameWhy ? (
                    <details>
                      <summary>Full frame resolution JSON</summary>
                      <pre>{JSON.stringify(frameWhy, null, 2)}</pre>
                    </details>
                  ) : null}
                  {stateResolution?.rules ? (
                    <details>
                      <summary>Rule config</summary>
                      <pre>{JSON.stringify(stateResolution.rules, null, 2)}</pre>
                    </details>
                  ) : null}
                </div>

                <div className="frame-grid">
                  {frames.frames.map((frame) => (
                    <figure
                      key={frame.name}
                      className={selectedFrame?.name === frame.name ? "selected" : ""}
                      onClick={() => setSelectedFrame(frame)}
                    >
                      <img loading="lazy" src={`${API}${frame.url}`} alt={frame.name} />
                      <figcaption>
                        {frame.index} {frame.name}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </section>
            </>
          ) : (
            <div className="empty">Pick an MLflow run</div>
          )}
        </section>
      </div>
    </main>
  );
}

export default App;
