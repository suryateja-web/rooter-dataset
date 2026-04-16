import React, { useEffect, useMemo, useState } from "react";

const API =
  import.meta.env.VITE_API_BASE ||
  (window.location.port === "5173"
    ? `${window.location.protocol}//${window.location.hostname}:4100`
    : window.location.origin);
const PAGE_SIZE = 60;

async function fetchJson(path) {
  const response = await fetch(`${API}${path}`);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

function number(value) {
  return new Intl.NumberFormat("en-US").format(value || 0);
}

function App() {
  const [manifest, setManifest] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [selectedSession, setSelectedSession] = useState(null);
  const [frames, setFrames] = useState({ total: 0, offset: 0, frames: [] });
  const [query, setQuery] = useState("");
  const [collection, setCollection] = useState("");
  const [model, setModel] = useState("");
  const [frameOffset, setFrameOffset] = useState(0);
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setLoading("manifest");
    fetchJson("/api/manifest")
      .then((data) => {
        if (live) setManifest(data);
      })
      .catch((err) => {
        if (live) setError(err.message);
      })
      .finally(() => {
        if (live) setLoading("");
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (collection) params.set("collection", collection);
    if (model) params.set("model", model);

    fetch(`${API}/api/sessions?${params}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status}`);
        return response.json();
      })
      .then((data) => {
        setSessions(data.sessions);
        if (!selectedSessionId && data.sessions.length) {
          setSelectedSessionId(data.sessions[0].session_id);
        }
      })
      .catch((err) => {
        if (err.name !== "AbortError") setError(err.message);
      });

    return () => controller.abort();
  }, [query, collection, model, selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) return;
    let live = true;
    setFrameOffset(0);
    setLoading("session");
    fetchJson(`/api/sessions/${encodeURIComponent(selectedSessionId)}`)
      .then((data) => {
        if (live) setSelectedSession(data.session);
      })
      .catch((err) => {
        if (live) setError(err.message);
      })
      .finally(() => {
        if (live) setLoading("");
      });
    return () => {
      live = false;
    };
  }, [selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) return;
    let live = true;
    fetchJson(
      `/api/sessions/${encodeURIComponent(
        selectedSessionId,
      )}/frames?offset=${frameOffset}&limit=${PAGE_SIZE}`,
    )
      .then((data) => {
        if (live) setFrames(data);
      })
      .catch((err) => {
        if (live) setError(err.message);
      });
    return () => {
      live = false;
    };
  }, [selectedSessionId, frameOffset]);

  const collections = useMemo(
    () => [...new Set(sessions.map((item) => item.collection_folder))].sort(),
    [sessions],
  );

  const models = useMemo(
    () =>
      [
        ...new Set(sessions.flatMap((item) => item.app_run_families || [])),
      ].sort(),
    [sessions],
  );

  return (
    <main>
      <header className="topbar">
        <div>
          <h1>Dataset Visualizer</h1>
          <p>
            {manifest
              ? `${number(manifest.session_count)} sessions, ${number(
                  manifest.app_run_count,
                )} app runs, ${number(manifest.frame_count)} frames`
              : "Loading"}
          </p>
        </div>
        <div className="meta">
          <span>{manifest?.generated_at || ""}</span>
          <span>{loading ? `Loading ${loading}` : "Ready"}</span>
        </div>
      </header>

      {error ? <div className="error">{error}</div> : null}

      <section className="filters">
        <label>
          Search
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="session, folder"
          />
        </label>
        <label>
          Collection
          <select
            value={collection}
            onChange={(event) => setCollection(event.target.value)}
          >
            <option value="">All</option>
            {collections.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label>
          App model
          <select value={model} onChange={(event) => setModel(event.target.value)}>
            <option value="">All</option>
            {models.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      </section>

      <div className="layout">
        <section className="sessions">
          <div className="section-title">
            <h2>Sessions</h2>
            <span>{number(sessions.length)}</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Collection</th>
                  <th>Frames</th>
                  <th>Runs</th>
                  <th>Models</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr
                    key={session.session_id}
                    className={
                      session.session_id === selectedSessionId ? "active" : ""
                    }
                    onClick={() => setSelectedSessionId(session.session_id)}
                  >
                    <td title={session.relative_path}>{session.relative_path}</td>
                    <td>{session.collection_folder}</td>
                    <td>{number(session.frame_count)}</td>
                    <td>{session.app_run_count}</td>
                    <td>{session.app_run_families.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="detail">
          {selectedSession ? (
            <>
              <div className="section-title">
                <h2>{selectedSession.relative_path}</h2>
                <span>{selectedSession.session_id}</span>
              </div>

              <div className="facts">
                <div>
                  <strong>{number(selectedSession.frame_count)}</strong>
                  <span>frames</span>
                </div>
                <div>
                  <strong>{selectedSession.app_runs.length}</strong>
                  <span>app runs</span>
                </div>
                <div>
                  <strong>
                    {selectedSession.annotations?.segments?.length || 0}
                  </strong>
                  <span>segments</span>
                </div>
                <div>
                  <strong>
                    {selectedSession.annotations?.match_stats?.length || 0}
                  </strong>
                  <span>stats</span>
                </div>
              </div>

              <h3>App Runs</h3>
              <div className="table-wrap short">
                <table>
                  <thead>
                    <tr>
                      <th>Run</th>
                      <th>Detector</th>
                      <th>OCR</th>
                      <th>Variant</th>
                      <th>Entries</th>
                      <th>Matched</th>
                      <th>Detections</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedSession.app_runs.map((run) => (
                      <tr key={run.run_id}>
                        <td title={run.raw_json_path}>{run.run_id}</td>
                        <td>{run.detector_model_family}</td>
                        <td>{run.ocr_model_family}</td>
                        <td>{run.algo_variant}</td>
                        <td>{number(run.json_entries)}</td>
                        <td>{number(run.matched_frame_count)}</td>
                        <td>{number(run.total_detections)}</td>
                        <td>{run.error ? "error" : "ok"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="frames-head">
                <h3>Frames</h3>
                <div className="pager">
                  <button
                    disabled={frameOffset === 0}
                    onClick={() =>
                      setFrameOffset(Math.max(0, frameOffset - PAGE_SIZE))
                    }
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

              <div className="frame-grid">
                {frames.frames.map((frame) => (
                  <figure key={frame.name}>
                    <img
                      loading="lazy"
                      src={`${API}${frame.url}`}
                      alt={frame.name}
                    />
                    <figcaption>
                      {frame.index} {frame.name}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </>
          ) : (
            <div className="empty">Select a session</div>
          )}
        </section>
      </div>
    </main>
  );
}

export default App;
