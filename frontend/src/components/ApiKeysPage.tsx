import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api, ApiError } from "../lib/apiClient";
import type { ApiKey, ApiKeyCreated } from "../types/apiKey";
import { Card } from "../ui/Card";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { CopyButton } from "./CopyButton";
import { IconKey } from "./icons";

const API_KEYS_PATH = "/api/v1/api-keys";

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-GB", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * API Keys — organization-owned ingest credentials. The raw secret is shown
 * exactly once, on creation (the server never returns it again). Everything
 * else is derived from the stored metadata (prefix, status, timestamps); the
 * secret itself is never displayed. All calls resolve the caller's org
 * server-side from the session — the client never sends an organization id.
 */
export function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[] | null>(null); // null = still loading
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<ApiKeyCreated | null>(null);

  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const rows = await api.get<ApiKey[]>(API_KEYS_PATH);
      setKeys(rows);
    } catch (err) {
      setKeys([]);
      setLoadError(err instanceof ApiError ? err.message : "Unable to load API keys.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setCreateError("Give the key a name so you can recognize it later.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const created = await api.post<ApiKeyCreated>(API_KEYS_PATH, { name: trimmed });
      setRevealed(created);
      setName("");
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create the key. Try again.");
    } finally {
      setCreating(false);
    }
  };

  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    setActionError(null);
    try {
      await api.post(`${API_KEYS_PATH}/${revokeTarget.id}/revoke`);
      setRevokeTarget(null);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not revoke the key.");
      setRevokeTarget(null);
    } finally {
      setRevoking(false);
    }
  };

  const loading = keys === null;
  const activeCount = keys?.filter((k) => !k.revoked_at).length ?? 0;

  return (
    <>
      <Card title="Create API key" hint="one key routes events to this workspace">
        <form className="ak-create" onSubmit={create}>
          <div className="ak-create-field">
            <label htmlFor="ak-name">Key name</label>
            <input
              id="ak-name"
              type="text"
              value={name}
              maxLength={255}
              placeholder="e.g. production-web, ingest-worker"
              autoComplete="off"
              disabled={creating}
              onChange={(e) => {
                setName(e.target.value);
                if (createError) setCreateError(null);
              }}
              aria-invalid={createError ? true : undefined}
            />
          </div>
          <button type="submit" className="btn accent ak-create-btn" disabled={creating || name.trim() === ""}>
            {creating ? "Creating…" : "Create key"}
          </button>
        </form>
        {createError ? (
          <p className="ak-inline-error" role="alert">
            {createError}
          </p>
        ) : (
          <p className="metric-definition" style={{ marginTop: 10 }}>
            Send the key as the <code>X-API-Key</code> header on <code>POST /api/v1/events</code>. Events are
            automatically attributed to this workspace.
          </p>
        )}

        {revealed ? (
          <div className="ak-reveal" role="status" aria-live="polite">
            <div className="ak-reveal-head">
              <span className="badge ok">
                <span className="dot" aria-hidden /> Key created
              </span>
              <strong>{revealed.name}</strong>
            </div>
            <p className="ak-reveal-warn">
              Copy this key now — for your security it will <strong>not be shown again</strong>. Store it somewhere
              safe; if you lose it, revoke it and create a new one.
            </p>
            <div className="ak-secret">
              <code className="ak-secret-value mono">{revealed.api_key}</code>
              <CopyButton value={revealed.api_key} className="btn accent" label="Copy key" copiedLabel="Copied" />
            </div>
            <button type="button" className="btn ak-reveal-dismiss" onClick={() => setRevealed(null)}>
              I've saved it — dismiss
            </button>
          </div>
        ) : null}
      </Card>

      <Card
        title="Your API keys"
        hint={loading ? "loading…" : `${activeCount} active · ${keys?.length ?? 0} total`}
      >
        {actionError ? (
          <div className="error-banner" role="alert">
            <span>{actionError}</span>
            <button type="button" className="btn" onClick={() => setActionError(null)}>
              Dismiss
            </button>
          </div>
        ) : null}

        {loadError ? (
          <div className="error-banner" role="alert">
            <span>{loadError}</span>
            <button type="button" className="btn" onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : null}

        {loading ? (
          <div className="ak-skeletons" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton skeleton-text" style={{ height: 40, margin: "8px 0" }} />
            ))}
          </div>
        ) : keys && keys.length > 0 ? (
          <div className="table-scroll">
            <table className="ak-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th className="ak-col-action">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => {
                  const revoked = Boolean(k.revoked_at);
                  return (
                    <tr key={k.id} className={revoked ? "ak-row-revoked" : ""}>
                      <td className="ak-name-cell">{k.name}</td>
                      <td>
                        <span className="mono ak-prefix">{k.key_prefix}…</span>
                      </td>
                      <td>
                        {revoked ? (
                          <span className="badge neutral">Revoked</span>
                        ) : (
                          <span className="badge ok">
                            <span className="dot" aria-hidden /> Active
                          </span>
                        )}
                      </td>
                      <td className="ak-time">{fmtDateTime(k.created_at)}</td>
                      <td className="ak-time">{k.last_used_at ? fmtDateTime(k.last_used_at) : "Never"}</td>
                      <td className="ak-col-action">
                        {revoked ? (
                          <span className="ak-revoked-note">{fmtDateTime(k.revoked_at)}</span>
                        ) : (
                          <button
                            type="button"
                            className="btn danger"
                            onClick={() => setRevokeTarget(k)}
                            aria-label={`Revoke ${k.name}`}
                          >
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <IconKey size={26} />
            <span className="empty-title">No API keys yet</span>
            <span>Create your first key above to start sending events to this workspace.</span>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={revokeTarget !== null}
        title="Revoke this API key?"
        body={
          <>
            <p style={{ margin: "0 0 8px" }}>
              <strong>{revokeTarget?.name}</strong> (<span className="mono">{revokeTarget?.key_prefix}…</span>) will
              stop working immediately. Any application still using it will receive{" "}
              <span className="mono">401 invalid_api_key</span>.
            </p>
            <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>
              This cannot be undone. Existing events already ingested are unaffected.
            </p>
          </>
        }
        confirmLabel="Revoke key"
        busy={revoking}
        onConfirm={confirmRevoke}
        onCancel={() => setRevokeTarget(null)}
      />
    </>
  );
}
