import { useEffect, useRef, useState } from "react";
import { EVENT_TYPES, LIMITS, clampDuration, clampRate } from "../lib/eventFactory";
import { Simulator } from "../lib/simulator";
import { api } from "../lib/apiClient";
import { Card } from "../ui/Card";
import { Segmented } from "../ui/Segmented";
import { IconBolt } from "./icons";

/**
 * Event Simulator — a demonstration/client-testing layer on top of the
 * existing public ingestion API. It generates REAL events through the normal
 * pipeline (HTTP → Kafka → workers → Redis/PG → WS → dashboard).
 *
 * Simulator counters represent simulator activity only; they are not
 * analytics. Hard limits (rate ≤ 50 ev/s, duration ≤ 300s, ≤ 5000 events/run)
 * keep demo traffic safe.
 */
export function EventSimulator() {
  const simRef = useRef(null);
  if (simRef.current === null) simRef.current = new Simulator();
  const sim = simRef.current;

  const [stats, setStats] = useState(() => sim.getSnapshot());
  const [planned, setPlanned] = useState(null);
  const [mode, setMode] = useState("sustained");
  const [eventType, setEventType] = useState("random");
  const [source, setSource] = useState("demo-store");
  const [rate, setRate] = useState(10);
  const [duration, setDuration] = useState(30); // "" = continuous

  // API-key selection: "demo" = the shared/Demo fallback (no X-API-Key sent);
  // any other value is the id of one of the user's own keys, whose full secret
  // they paste below (the server never re-exposes it) and which we send as
  // X-API-Key so ingested events are attributed to their workspace.
  const [ownedKeys, setOwnedKeys] = useState([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [keysError, setKeysError] = useState(null);
  const [keyChoice, setKeyChoice] = useState("demo");
  const [secret, setSecret] = useState("");

  useEffect(() => sim.subscribe(setStats), [sim]);

  // Load the user's non-revoked ingest keys for the selector. Non-fatal on
  // failure — the Demo shared-key option always remains available as fallback.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await api.get("/api/v1/api-keys");
        if (cancelled) return;
        setOwnedKeys(Array.isArray(rows) ? rows.filter((k) => !k.revoked_at) : []);
      } catch {
        if (!cancelled) setKeysError("Could not load your API keys — using the Demo shared key.");
      } finally {
        if (!cancelled) setKeysLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // mode presets drive the form; engine limits still clamp everything
  const applyMode = (m) => {
    setMode(m);
    if (m === "burst") {
      setRate(LIMITS.maxRatePerSec);
      setDuration(10);
    } else if (m === "single") {
      setRate(1);
      setDuration(1);
    }
  };

  const startClicked = () => {
    const durationSec =
      mode === "single" ? 1 : continuous ? null : typeof duration === "number" ? duration : 30;
    const effRate = mode === "burst" ? LIMITS.maxRatePerSec : clampRate(rate);
    setPlanned(
      durationSec === null ? LIMITS.maxTotalEvents : Math.min(Math.ceil(durationSec * effRate), LIMITS.maxTotalEvents)
    );
    sim.start({ eventType, source, ratePerSec: rate, durationSec, apiKey: activeApiKey });
    if (mode === "single" && durationSec !== null) {
      // single-event convenience: fire exactly one attempt immediately
      void sim.sendOne({ eventType, source }, activeApiKey);
    }
  };

  const running = stats.running;
  const effectiveRate = clampRate(rate);
  const effectiveDuration = clampDuration(typeof duration === "number" ? duration : null);
  const continuous = duration === "" || effectiveDuration === null;

  // Which credential each event carries (see the key-selection state above).
  const selectedKey = keyChoice === "demo" ? null : ownedKeys.find((k) => k.id === keyChoice) ?? null;
  const usingOwnKey = keyChoice !== "demo";
  const trimmedSecret = secret.trim();
  const prefixMismatch =
    selectedKey !== null && trimmedSecret !== "" && !trimmedSecret.startsWith(selectedKey.key_prefix);
  // The key actually sent with each event: the pasted secret for an owned key,
  // or null for the Demo shared-key fallback.
  const activeApiKey = usingOwnKey ? trimmedSecret : null;
  // Gate traffic until an owned-key selection has a pasted secret matching the
  // key's public prefix (Demo mode is always ready).
  const keyReady = !usingOwnKey || (trimmedSecret !== "" && !prefixMismatch);
  const plannedNote =
    !running
      ? mode === "single"
        ? "sends exactly one event through the public API"
        : continuous
          ? `continuous run · hard-capped at ${LIMITS.maxTotalEvents.toLocaleString()} events`
          : `${effectiveRate * (effectiveDuration ?? 0)} events planned`
      : null;
  const startedAt = stats.startedAt;
  const elapsedS =
    startedAt !== null
      ? Math.round(((running ? Date.now() : (stats.finishedAt ?? Date.now())) - startedAt) / 1000)
      : null;

  return (
    <Card
      title="Traffic Lab"
      id="simulator"
      variant="plane"
      hint={`demo traffic via the public API · max ${LIMITS.maxRatePerSec}/s · ${LIMITS.maxDurationSec}s · ${LIMITS.maxTotalEvents} events/run`}
    >
      <div className="sim-tabs">
        <Segmented
          ariaLabel="Traffic mode"
          value={mode}
          onChange={(m) => applyMode(m)}
          options={[
            { value: "single", label: "Single event" },
            { value: "sustained", label: "Sustained" },
            { value: "burst", label: "Burst (max rate · 10s)" },
          ]}
        />
      </div>
      <div className="sim-form">
        <div className="field">
          <label htmlFor="sim-apikey">API key</label>
          <select
            id="sim-apikey"
            value={keyChoice}
            onChange={(e) => {
              setKeyChoice(e.target.value);
              setSecret("");
            }}
            disabled={running}
          >
            <option value="demo">Demo environment (shared key)</option>
            {ownedKeys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name} — {k.key_prefix}…
              </option>
            ))}
          </select>
        </div>

        {usingOwnKey ? (
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <label htmlFor="sim-apikey-secret">Full API key value</label>
            <input
              id="sim-apikey-secret"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              disabled={running}
              placeholder={`${selectedKey?.key_prefix ?? "psk_"}…`}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={prefixMismatch ? true : undefined}
            />
            <p className="sim-hint" style={prefixMismatch ? { color: "var(--danger)" } : undefined}>
              {prefixMismatch
                ? `That doesn't match the selected key's prefix (${selectedKey?.key_prefix}…). Paste the exact key you saved.`
                : `Keys are shown only once at creation — paste the full value you saved for "${selectedKey?.name ?? "this key"}". Events will be attributed to your workspace.`}
            </p>
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="sim-type">Event type</label>
          <select
            id="sim-type"
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
            disabled={running}
          >
            <option value="random">Random</option>
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="sim-source">Source</label>
          <input
            id="sim-source"
            type="text"
            value={source}
            maxLength={255}
            onChange={(e) => setSource(e.target.value)}
            disabled={running}
            placeholder="demo-store"
          />
        </div>

        <div className="field">
          <label htmlFor="sim-rate">Traffic rate (events/sec, 1–{LIMITS.maxRatePerSec})</label>
          <input
            id="sim-rate"
            type="number"
            min={LIMITS.minRatePerSec}
            max={LIMITS.maxRatePerSec}
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
            disabled={running}
          />
        </div>

        <div className="field">
          <label htmlFor="sim-duration">Duration (seconds, 1–{LIMITS.maxDurationSec}; empty = until Stop)</label>
          <input
            id="sim-duration"
            type="number"
            min={continuous ? undefined : LIMITS.minDurationSec}
            max={LIMITS.maxDurationSec}
            placeholder="empty = continuous"
            value={duration}
            onChange={(e) => {
              const v = e.target.value;
              setDuration(v === "" ? "" : Number(v));
            }}
            disabled={running}
          />
        </div>

        <div className="field field-actions">
          <span className="visually-hidden">Actions</span>
          <button
            type="button"
            className="btn"
            onClick={() => void sim.sendOne({ eventType, source }, activeApiKey)}
            disabled={running || !keyReady}
          >
            Send 1 event
          </button>
          <button
            type="button"
            className="btn accent"
            onClick={startClicked}
            disabled={running || source.trim() === "" || !keyReady}
          >
            Start traffic
          </button>
          <button type="button" className="btn" onClick={() => sim.stop()} disabled={!running}>
            Stop
          </button>
        </div>
      </div>

      {keysError ? (
        <p className="sim-hint" role="status">
          {keysError}
        </p>
      ) : !keysLoading && ownedKeys.length === 0 ? (
        <p className="sim-hint">
          No personal API keys yet — traffic uses the Demo shared key. Create one on the{" "}
          <strong>API Keys</strong> page to attribute events to your workspace.
        </p>
      ) : usingOwnKey ? null : (
        <p className="sim-hint">
          Sending as the <strong>Demo environment</strong> shared key. Pick one of your keys above to
          attribute generated events to your own workspace.
        </p>
      )}

      {!running && plannedNote ? <p className="sim-planned">{plannedNote}</p> : null}

      {running && planned ? (
        <>
          <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuenow={stats.attempted} aria-valuemax={planned}>
            <div className="progress-fill" style={{ width: `${Math.min(100, (stats.attempted / planned) * 100)}%` }} />
          </div>
          <p className="sim-planned">
            {stats.attempted.toLocaleString("en-US")} of {planned.toLocaleString("en-US")} scheduled events sent
          </p>
        </>
      ) : null}

      <div className="sim-stats" aria-live="polite">
        <Stat label="Events attempted" value={stats.attempted} />
        <Stat label="Successful" value={stats.succeeded} tone="ok" />
        <Stat label="Failed" value={stats.failed} tone={stats.failed > 0 ? "danger" : undefined} />
        <Stat
          label="Current rate"
          value={stats.currentRate.toFixed(1)}
          unit="/sec"
        />
        <div className="stat-block">
          <div className="stat-label">State</div>
          <div className="sim-state">
            {running ? (
              <span className="badge ok">
                <span className="dot pulse-dot pulsing" aria-hidden /> Running
              </span>
            ) : stats.attempted > 0 ? (
              <span className="badge neutral">Stopped</span>
            ) : (
              <span className="badge neutral">Idle</span>
            )}
          </div>
        </div>
      </div>

      {stats.lastError && stats.failed > 0 ? (
        <p className="sim-error">Last failure: {stats.lastError}</p>
      ) : null}

      <p className="metric-definition">
        The simulator sends real HTTP requests to <code>POST /api/v1/events</code> — the same
        public API any producer uses — so every event flows through Kafka, the workers,
        PostgreSQL/Redis and appears on the dashboard like genuine traffic. Its counters describe
        simulator activity only and are not analytics metrics.
      </p>
    </Card>
  );
}

function Stat({
  label,
  value,
  unit,
  tone,
}) {
  return (
    <div className="stat-block">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={tone === "ok" ? { color: "var(--ok)" } : tone === "danger" ? { color: "var(--danger)" } : undefined}>
        {value}
        {unit ? <span className="value-unit">{unit}</span> : null}
      </div>
    </div>
  );
}

