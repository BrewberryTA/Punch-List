import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Walkthrough } from "../api/client";
import { getDb, type LocalWalkthrough } from "../offline/db";
import { onSyncChange, syncAll } from "../offline/sync";

export function WalkthroughPage() {
  const { id } = useParams<{ id: string }>();
  const [local, setLocal] = useState<LocalWalkthrough | null>(null);
  const [localPhotoCount, setLocalPhotoCount] = useState(0);
  const [server, setServer] = useState<Walkthrough | null>(null);
  const [notFoundYet, setNotFoundYet] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [finalizing, setFinalizing] = useState(false);

  const refreshLocal = useCallback(async () => {
    if (!id) return;
    const db = await getDb();
    const wt = await db.get("walkthroughs", id);
    setLocal(wt ?? null);
    const media = await db.getAllFromIndex("media", "by-walkthrough", id);
    setLocalPhotoCount(media.length);
  }, [id]);

  const refreshServer = useCallback(async () => {
    if (!id) return;
    try {
      const wt = await api.getWalkthrough(id);
      setServer(wt);
      setNotFoundYet(false);
    } catch {
      setNotFoundYet(true);
    }
  }, [id]);

  useEffect(() => {
    void refreshLocal();
    void refreshServer();
    const unsub = onSyncChange(() => {
      void refreshLocal();
      void refreshServer();
    });
    const interval = window.setInterval(() => {
      void refreshServer();
    }, 3000);
    return () => {
      unsub();
      window.clearInterval(interval);
    };
  }, [refreshLocal, refreshServer]);

  async function updateField(
    itemId: string,
    field: "room" | "description" | "trade",
    value: string
  ) {
    await api.updateItem(itemId, { [field]: value } as never);
    void refreshServer();
  }

  async function updateCommitmentDate(itemId: string, value: string) {
    await api.updateItem(itemId, { commitmentDate: value } as never);
    void refreshServer();
  }

  async function finalize() {
    if (!id) return;
    setFinalizing(true);
    setFinalizeError(null);
    try {
      const wt = await api.finalizeWalkthrough(id);
      setServer(wt);
    } catch (e) {
      setFinalizeError(e instanceof Error ? e.message : String(e));
    } finally {
      setFinalizing(false);
    }
  }

  // --- Local-only states: not synced to the server yet ---
  if (!server && local) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Walkthrough</h1>
        </header>
        <div className="card">
          <p>
            <strong>{localPhotoCount}</strong> photo/video item(s) captured.
          </p>
          {local.status === "transcribing" && (
            <>
              <p>Transcribing on-device… {local.transcriptionProgress ?? 0}%</p>
              <p className="muted">
                Runs locally (no cloud speech-to-text) — the first walkthrough on
                this device pauses here while the speech model downloads once;
                every walkthrough after that transcribes fully offline.
              </p>
            </>
          )}
          {local.status === "ready_to_sync" && (
            <>
              <p>
                {local.transcript !== undefined
                  ? "Transcribed on-device — waiting for a connection to upload."
                  : "Saved on this device — preparing to transcribe."}
              </p>
              <button className="secondary" onClick={() => void syncAll()}>
                Try syncing now
              </button>
            </>
          )}
          {local.status === "syncing" && <p>Uploading…</p>}
          {local.status === "error" && (
            <>
              <p className="error">Last upload attempt failed: {local.lastError}</p>
              <button className="secondary" onClick={() => void syncAll()}>
                Retry
              </button>
            </>
          )}
        </div>
        <Link className="link-button" to="/">
          ← Projects
        </Link>
      </div>
    );
  }

  if (!server && notFoundYet && !local) {
    return (
      <div className="page">
        <p>Couldn't find that walkthrough on this device or the server.</p>
        <Link className="link-button" to="/">
          ← Projects
        </Link>
      </div>
    );
  }

  if (!server) {
    return (
      <div className="page">
        <p>Loading…</p>
      </div>
    );
  }

  // --- Server-tracked states ---
  if (server.status === "queued" || server.status === "processing") {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Walkthrough</h1>
        </header>
        <div className="card">
          <p>Turning your walkthrough into a punch list…</p>
          <p className="muted">
            {server.status === "queued"
              ? "Uploaded — waiting to process."
              : server.ai_configured
                ? "Claude is drafting items from your on-device transcript…"
                : "Drafting placeholder items (no ANTHROPIC_API_KEY configured on the server yet — see server/.env.example)."}
          </p>
        </div>
      </div>
    );
  }

  const items = server.items;
  const missingCommitment = items.filter((i) => !i.commitment_date);

  return (
    <div className="page">
      <header className="page-header">
        <h1>Review</h1>
      </header>

      {server.status === "finalized" && (
        <div className="card success">
          <p>✅ Finalized{server.finalized_at ? ` — ${server.finalized_at}` : ""}.</p>
          <p className="muted">
            Homebuilder Ops push is a TODO in the server stub — see the plan doc.
          </p>
        </div>
      )}

      <ul className="list">
        {items.map((item) => {
          const media = server.media.filter((m) => m.item_id === item.id);
          return (
            <li key={item.id} className="item-card">
              {media.map((m) => (
                <img
                  key={m.id}
                  className="item-photo"
                  src={`/uploads/${m.file_path}`}
                  alt=""
                />
              ))}
              <label>
                Room
                <input
                  defaultValue={item.room ?? ""}
                  disabled={server.status === "finalized"}
                  onBlur={(e) => void updateField(item.id, "room", e.target.value)}
                />
              </label>
              {item.transcript_snippet && (
                <p className="muted">"{item.transcript_snippet}"</p>
              )}
              <label>
                Description
                <textarea
                  defaultValue={item.description}
                  disabled={server.status === "finalized"}
                  onBlur={(e) =>
                    void updateField(item.id, "description", e.target.value)
                  }
                />
              </label>
              <label>
                Trade / assigned to
                <input
                  defaultValue={item.trade ?? ""}
                  disabled={server.status === "finalized"}
                  onBlur={(e) => void updateField(item.id, "trade", e.target.value)}
                />
              </label>
              <label>
                Commitment date{" "}
                {!item.commitment_date && (
                  <span className="required">required before finalizing</span>
                )}
                <input
                  type="date"
                  defaultValue={item.commitment_date ?? ""}
                  disabled={server.status === "finalized"}
                  onChange={(e) =>
                    void updateCommitmentDate(item.id, e.target.value)
                  }
                />
              </label>
              {item.status === "complete" && (
                <p className="muted">✓ marked complete</p>
              )}
            </li>
          );
        })}
      </ul>

      {server.status !== "finalized" && (
        <div className="card">
          {missingCommitment.length > 0 && (
            <p className="error">
              {missingCommitment.length} item(s) still need a commitment date.
            </p>
          )}
          {finalizeError && <p className="error">{finalizeError}</p>}
          <button
            className="primary big"
            disabled={missingCommitment.length > 0 || finalizing}
            onClick={finalize}
          >
            {finalizing ? "Finalizing…" : "Finalize & send"}
          </button>
        </div>
      )}

      <Link className="link-button" to="/">
        ← Projects
      </Link>
    </div>
  );
}
