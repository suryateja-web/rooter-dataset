import React, { useEffect, useMemo, useState } from "react";

const API =
  import.meta.env.VITE_API_BASE ||
  (window.location.port === "5174"
    ? `${window.location.protocol}//${window.location.hostname}:4200`
    : window.location.origin);
const PAGE_SIZE = 72;

async function fetchJson(path, options) {
  const response = await fetch(`${API}${path}`, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `${response.status} ${response.statusText}`);
  }
  return response.json();
}

function number(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function emptySegment(matchIndex = 1, frameIndex = 0) {
  return {
    id: makeId("segment"),
    type: "match",
    match_id: `match_${String(matchIndex).padStart(3, "0")}`,
    start_frame: frameIndex,
    end_frame: frameIndex,
    notes: "",
    extra: {},
  };
}

function emptyMatchStat(matchIndex = 1) {
  return {
    id: makeId("match"),
    match_id: `match_${String(matchIndex).padStart(3, "0")}`,
    kills: "",
    assists: "",
    is_alive: "",
    notes: "",
    extra: {},
  };
}

function normalizeAnnotation(annotation, sessionId) {
  return {
    version: 1,
    session_id: sessionId,
    updated_at: null,
    session_details: { total_matches: "", notes: "" },
    segments: [],
    match_stats: [],
    extra: {},
    ...(annotation || {}),
  };
}

function App() {
  const [manifest, setManifest] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [query, setQuery] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [session, setSession] = useState(null);
  const [annotation, setAnnotation] = useState(null);
  const [frames, setFrames] = useState({ total: 0, offset: 0, frames: [] });
  const [frameOffset, setFrameOffset] = useState(0);
  const [selectedFrame, setSelectedFrame] = useState(null);
  const [fullImage, setFullImage] = useState(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetchJson("/api/manifest")
      .then(setManifest)
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    fetch(`${API}/api/sessions?${params}`, { signal: controller.signal })
      .then((response) => response.json())
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
  }, [query, selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) return;
    let live = true;
    setStatus("Loading session");
    setFrameOffset(0);
    setSelectedFrame(null);
    fetchJson(`/api/sessions/${encodeURIComponent(selectedSessionId)}`)
      .then((data) => {
        if (!live) return;
        setSession(data.session);
        setAnnotation(normalizeAnnotation(data.annotation, data.session.session_id));
      })
      .catch((err) => {
        if (live) setError(err.message);
      })
      .finally(() => {
        if (live) setStatus("");
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

  const selectedFrameUrl = selectedFrame
    ? `${API}${selectedFrame.url}`
    : frames.frames[0]
      ? `${API}${frames.frames[0].url}`
      : "";

  const sortedSegments = useMemo(() => {
    return [...(annotation?.segments || [])].sort(
      (a, b) => Number(a.start_frame || 0) - Number(b.start_frame || 0),
    );
  }, [annotation]);

  function updateAnnotation(patch) {
    setAnnotation((current) => ({ ...current, ...patch }));
  }

  function updateDetails(key, value) {
    setAnnotation((current) => ({
      ...current,
      session_details: {
        ...current.session_details,
        [key]: value,
      },
    }));
  }

  function addSegment() {
    const nextIndex = (annotation?.segments || []).length + 1;
    const frameIndex = selectedFrame?.index || frameOffset;
    updateAnnotation({
      segments: [...annotation.segments, emptySegment(nextIndex, frameIndex)],
    });
  }

  function updateSegment(id, key, value) {
    updateAnnotation({
      segments: annotation.segments.map((segment) =>
        segment.id === id ? { ...segment, [key]: value } : segment,
      ),
    });
  }

  function removeSegment(id) {
    updateAnnotation({
      segments: annotation.segments.filter((segment) => segment.id !== id),
    });
  }

  function addMatchStat() {
    const nextIndex = (annotation?.match_stats || []).length + 1;
    updateAnnotation({
      match_stats: [...annotation.match_stats, emptyMatchStat(nextIndex)],
    });
  }

  function updateMatchStat(id, key, value) {
    updateAnnotation({
      match_stats: annotation.match_stats.map((match) =>
        match.id === id ? { ...match, [key]: value } : match,
      ),
    });
  }

  function removeMatchStat(id) {
    updateAnnotation({
      match_stats: annotation.match_stats.filter((match) => match.id !== id),
    });
  }

  async function save() {
    if (!session || !annotation) return;
    setSaving(true);
    setError("");
    try {
      const data = await fetchJson(
        `/api/annotations/${encodeURIComponent(session.session_id)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(annotation),
        },
      );
      setAnnotation(normalizeAnnotation(data.annotation, session.session_id));
      setStatus("Saved");
      setTimeout(() => setStatus(""), 1400);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main>
      <header className="topbar">
        <div>
          <h1>Dataset Annotator</h1>
          <p>
            {manifest
              ? `${number(manifest.session_count)} sessions, ${number(
                  manifest.frame_count,
                )} frames`
              : "Loading"}
          </p>
        </div>
        <div className="meta">
          <span>{annotation?.updated_at ? `Updated ${annotation.updated_at}` : ""}</span>
          <span>{saving ? "Saving" : status || "Ready"}</span>
          <button onClick={save} disabled={!annotation || saving}>
            Save
          </button>
        </div>
      </header>

      {error ? <div className="error">{error}</div> : null}

      <section className="filters">
        <label>
          Search sessions
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="folder or session id"
          />
        </label>
        <div className="hint">Ground truth only. Predictions stay in MLflow.</div>
      </section>

      <div className="layout">
        <section className="sessions">
          <div className="section-title">
            <h2>Sessions</h2>
            <span>{number(sessions.length)}</span>
          </div>
          <div className="table-wrap sessions-table">
            <table>
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Frames</th>
                  <th>Seg</th>
                  <th>Stats</th>
                  <th>Matches</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((item) => (
                  <tr
                    key={item.session_id}
                    className={item.session_id === selectedSessionId ? "active" : ""}
                    onClick={() => setSelectedSessionId(item.session_id)}
                  >
                    <td title={item.relative_path}>{item.relative_path}</td>
                    <td>{number(item.frame_count)}</td>
                    <td>{item.segment_count}</td>
                    <td>{item.match_stat_count}</td>
                    <td>{item.total_matches}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="workspace">
          {session && annotation ? (
            <>
              <div className="section-title">
                <h2>{session.relative_path}</h2>
                <span>{session.session_id}</span>
              </div>

              <section className="panel">
                <div className="panel-head">
                  <h3>Session Details</h3>
                  <span>{number(session.frame_count)} frames</span>
                </div>
                <div className="details-grid">
                  <label>
                    Total matches
                    <input
                      value={annotation.session_details.total_matches}
                      onChange={(event) =>
                        updateDetails("total_matches", event.target.value)
                      }
                      placeholder="e.g. 3"
                    />
                  </label>
                  <label className="wide">
                    Notes
                    <input
                      value={annotation.session_details.notes}
                      onChange={(event) => updateDetails("notes", event.target.value)}
                      placeholder="session-level notes"
                    />
                  </label>
                </div>
              </section>

              <section className="panel">
                <div className="panel-head">
                  <h3>Timeline</h3>
                  <span>
                    selected frame {selectedFrame ? selectedFrame.index : "none"}
                  </span>
                </div>
                <div className="timeline">
                  {sortedSegments.map((segment) => {
                    const total = Math.max(1, session.frame_count);
                    const start = Math.max(0, Number(segment.start_frame || 0));
                    const end = Math.max(start, Number(segment.end_frame || start));
                    const left = (start / total) * 100;
                    const width = Math.max(0.3, ((end - start + 1) / total) * 100);
                    return (
                      <div
                        key={segment.id}
                        className="timeline-segment"
                        style={{ left: `${left}%`, width: `${width}%` }}
                        title={`${segment.match_id} ${start}-${end}`}
                      >
                        {segment.match_id}
                      </div>
                    );
                  })}
                  {selectedFrame ? (
                    <div
                      className="timeline-cursor"
                      style={{
                        left: `${(selectedFrame.index / Math.max(1, session.frame_count)) * 100}%`,
                      }}
                    />
                  ) : null}
                </div>
              </section>

              <div className="edit-layout">
                <section className="panel">
                  <div className="panel-head">
                    <h3>Segments</h3>
                    <button onClick={addSegment}>Add Segment</button>
                  </div>
                  <div className="segment-list">
                    {annotation.segments.map((segment) => (
                      <div className="segment-row" key={segment.id}>
                        <input
                          value={segment.match_id}
                          onChange={(event) =>
                            updateSegment(segment.id, "match_id", event.target.value)
                          }
                          title="match id"
                        />
                        <select
                          value={segment.type}
                          onChange={(event) =>
                            updateSegment(segment.id, "type", event.target.value)
                          }
                        >
                          <option value="match">match</option>
                          <option value="lobby">lobby</option>
                          <option value="scoreboard">scoreboard</option>
                          <option value="loading">loading</option>
                          <option value="other">other</option>
                        </select>
                        <input
                          type="number"
                          value={segment.start_frame}
                          onChange={(event) =>
                            updateSegment(segment.id, "start_frame", event.target.value)
                          }
                        />
                        <button
                          onClick={() =>
                            updateSegment(
                              segment.id,
                              "start_frame",
                              selectedFrame?.index || 0,
                            )
                          }
                        >
                          Start
                        </button>
                        <input
                          type="number"
                          value={segment.end_frame}
                          onChange={(event) =>
                            updateSegment(segment.id, "end_frame", event.target.value)
                          }
                        />
                        <button
                          onClick={() =>
                            updateSegment(
                              segment.id,
                              "end_frame",
                              selectedFrame?.index || 0,
                            )
                          }
                        >
                          End
                        </button>
                        <input
                          value={segment.notes || ""}
                          onChange={(event) =>
                            updateSegment(segment.id, "notes", event.target.value)
                          }
                          placeholder="notes"
                        />
                        <button onClick={() => removeSegment(segment.id)}>Del</button>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="panel">
                  <div className="panel-head">
                    <h3>Match Stats</h3>
                    <button onClick={addMatchStat}>Add Match</button>
                  </div>
                  <div className="match-list">
                    {annotation.match_stats.map((match) => (
                      <div className="match-row" key={match.id}>
                        <input
                          value={match.match_id}
                          onChange={(event) =>
                            updateMatchStat(match.id, "match_id", event.target.value)
                          }
                        />
                        <input
                          type="number"
                          value={match.kills}
                          onChange={(event) =>
                            updateMatchStat(match.id, "kills", event.target.value)
                          }
                          placeholder="kills"
                        />
                        <input
                          type="number"
                          value={match.assists}
                          onChange={(event) =>
                            updateMatchStat(match.id, "assists", event.target.value)
                          }
                          placeholder="assists"
                        />
                        <select
                          value={match.is_alive}
                          onChange={(event) =>
                            updateMatchStat(match.id, "is_alive", event.target.value)
                          }
                        >
                          <option value="">alive?</option>
                          <option value="true">alive</option>
                          <option value="false">not alive</option>
                        </select>
                        <input
                          value={match.notes || ""}
                          onChange={(event) =>
                            updateMatchStat(match.id, "notes", event.target.value)
                          }
                          placeholder="notes"
                        />
                        <button onClick={() => removeMatchStat(match.id)}>Del</button>
                      </div>
                    ))}
                  </div>
                </section>
              </div>

              <section className="panel frames-panel">
                <div className="panel-head">
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

                <div className="preview-row">
                  {selectedFrameUrl ? (
                    <img
                      src={selectedFrameUrl}
                      alt="selected frame"
                      onClick={() => setFullImage(selectedFrameUrl)}
                    />
                  ) : null}
                  <div>
                    <strong>
                      {selectedFrame
                        ? `${selectedFrame.index} ${selectedFrame.name}`
                        : "Select a frame"}
                    </strong>
                    <p>Click the preview or any thumbnail to open full size.</p>
                  </div>
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
            <div className="empty">Select a session</div>
          )}
        </section>
      </div>

      {fullImage ? (
        <div className="modal" onClick={() => setFullImage(null)}>
          <button onClick={() => setFullImage(null)}>Close</button>
          <img src={fullImage} alt="full size frame" />
        </div>
      ) : null}
    </main>
  );
}

export default App;

