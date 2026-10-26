import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type Item, type Media, type Walkthrough } from "../api/client";
import { getDb, type LocalWalkthrough } from "../offline/db";
import { onSyncChange, syncAll } from "../offline/sync";

export function WalkthroughPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const [local, setLocal] = useState<LocalWalkthrough | null>(null);
  const [localPhotoCount, setLocalPhotoCount] = useState(0);
  const [server, setServer] = useState<Walkthrough | null>(null);
  const [notFoundYet, setNotFoundYet] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const [pushing, setPushing] = useState(false);
  // Share-as-PDF. iPhone only opens the share sheet straight from a tap, and
  // building the PDF takes a moment — so if the first tap's permission has
  // lapsed by the time the file arrives, the file is kept and a second
  // "Share now" tap sends it instantly.
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

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

  // Two-step on purpose: the button asks, then a confirm box spells out
  // what goes, so a stray tap can't wipe a walkthrough.
  async function deleteThisWalkthrough() {
    if (!id) return;
    const pushed = server?.items.some((i) => i.homebuilder_item_id);
    const n = server?.items.length ?? 0;
    const ok = window.confirm(
      `Delete this walkthrough?\n\n` +
        (server
          ? `This permanently removes its ${n} item(s), photos, video and recording.`
          : `This permanently removes the recording and photos saved on this phone.`) +
        (pushed ? `\n\nItems already sent to Homebuilder Ops will stay there — delete them in Homebuilder Ops if needed.` : "") +
        `\n\nThis can't be undone.`
    );
    if (!ok) return;
    setDeleting(true);
    try {
      if (server) await api.deleteWalkthrough(id);
      const db = await getDb();
      const media = await db.getAllFromIndex("media", "by-walkthrough", id);
      for (const m of media) await db.delete("media", m.id);
      await db.delete("walkthroughs", id);
      navigate("/");
    } catch (e) {
      setFinalizeError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  }

  const deleteButton = (
    <button
      type="button"
      className="danger small delete-walk"
      disabled={deleting}
      onClick={() => void deleteThisWalkthrough()}
    >
      {deleting ? "Deleting…" : "Delete walkthrough"}
    </button>
  );

  const [reprocessing, setReprocessing] = useState(false);
  async function reprocess(skipAi: boolean) {
    if (!id) return;
    setReprocessing(true);
    try {
      setServer(await api.processWalkthrough(id, skipAi));
    } catch {
      void refreshServer(); // the error text arrives with the walkthrough
    } finally {
      setReprocessing(false);
    }
  }

  async function moveMedia(mediaId: string, target: string) {
    if (!id) return;
    try {
      setServer(await api.moveMedia(id, mediaId, target === "" ? null : target));
    } catch (e) {
      setFinalizeError(e instanceof Error ? e.message : String(e));
    }
  }

  async function sharePdf() {
    if (!id) return;
    setPdfError(null);
    let file = pdfFile;
    if (!file) {
      setPdfBusy(true);
      try {
        const r = await fetch(`/api/walkthroughs/${id}/pdf`);
        if (r.status === 401) window.dispatchEvent(new Event("pl-signed-out"));
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        const cd = r.headers.get("Content-Disposition") ?? "";
        const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? "Punch-List.pdf";
        file = new File([await r.blob()], name, { type: "application/pdf" });
      } catch (e) {
        setPdfError(
          e instanceof TypeError
            ? "No connection — sharing needs signal to build the PDF."
            : `Couldn't build the PDF: ${e instanceof Error ? e.message : String(e)}`
        );
        setPdfBusy(false);
        return;
      }
      setPdfBusy(false);
    }
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: file.name });
        setPdfFile(null);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          setPdfFile(null); // they closed the share sheet
        } else {
          setPdfFile(file); // permission lapsed while building — offer "Share now"
        }
      }
    } else {
      // No share sheet (e.g. desktop browser): open the PDF to save/print it.
      window.open(URL.createObjectURL(file), "_blank");
    }
  }

  async function retryPush() {
    if (!id) return;
    setPushing(true);
    try {
      setServer(await api.pushToHomebuilder(id));
    } catch (e) {
      setFinalizeError(e instanceof Error ? e.message : String(e));
    } finally {
      setPushing(false);
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
          {deleteButton}
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
    const failed = server.status === "queued" && server.process_error;
    return (
      <div className="page">
        <header className="page-header">
          <h1>Walkthrough</h1>
        </header>
        <div className="card">
          {!failed && (
            <>
              <p>Turning your walkthrough into a punch list…</p>
              <p className="muted">
                {server.status === "queued"
                  ? "Uploaded — waiting to process."
                  : server.ai_configured
                    ? "Claude is drafting items from your transcript and photos…"
                    : "Drafting placeholder items (no ANTHROPIC_API_KEY on the server)."}
              </p>
            </>
          )}
          {local?.status === "error" && local.lastError && (
            <p className="error">
              Upload from this phone stopped: {local.lastError}
              <br />
              <span className="muted">
                {server.media.length} of {localPhotoCount} photo/video item(s) reached the server.
              </span>
            </p>
          )}
          {failed && (
            <>
              <p className="error">Drafting failed: {server.process_error}</p>
              <p className="muted">
                Nothing is lost — the recording and photos are saved. Try again, or skip the AI
                and write the items yourself (you'll get one blank item per photo).
              </p>
            </>
          )}
          {(failed || server.status === "queued") && (
            <div className="list-row-actions">
              <button className="primary" disabled={reprocessing} onClick={() => void reprocess(false)}>
                {reprocessing ? "Working…" : "Try again"}
              </button>
              <button className="secondary" disabled={reprocessing} onClick={() => void reprocess(true)}>
                Skip AI
              </button>
            </div>
          )}
          {deleteButton}
        </div>
      </div>
    );
  }

  const items = server.items;
  const missingCommitment = items.filter((i) => !i.commitment_date);
  const itemIds = new Set(items.map((i) => i.id));
  const unassigned = server.media.filter((m) => !m.item_id || !itemIds.has(m.item_id));

  return (
    <div className="page">
      <header className="page-header">
        <h1>Review</h1>
        {items.length > 0 && (
          <button
            type="button"
            className="secondary small"
            disabled={pdfBusy}
            onClick={() => void sharePdf()}
          >
            {pdfBusy ? "Building PDF…" : pdfFile ? "Share now" : "Share PDF"}
          </button>
        )}
      </header>
      {pdfFile && !pdfBusy && (
        <p className="muted">PDF ready — tap <strong>Share now</strong> to send it.</p>
      )}
      {pdfError && <p className="error">{pdfError}</p>}

      {server.status === "finalized" && (
        <div className="card success">
          <p>✅ Finalized{server.finalized_at ? ` — ${server.finalized_at}` : ""}.</p>
          {(() => {
            const pushedCount = server.items.filter((i) => i.homebuilder_item_id).length;
            const allPushed = server.items.length > 0 && pushedCount === server.items.length;
            if (!server.homebuilder_configured) {
              return <p className="muted">Homebuilder Ops sending isn't switched on yet.</p>;
            }
            if (!server.homebuilder_project_id) {
              return (
                <>
                  <p className="muted">
                    Not sent to Homebuilder Ops — this project isn't linked to one. Link it on
                    the Projects screen, then come back and tap Send.
                  </p>
                  <button className="secondary" disabled={pushing} onClick={() => void retryPush()}>
                    {pushing ? "Sending…" : "Send to Homebuilder Ops"}
                  </button>
                </>
              );
            }
            if (allPushed) {
              return <p className="muted">📤 Sent to Homebuilder Ops ({pushedCount} punch item{pushedCount === 1 ? "" : "s"}).</p>;
            }
            return (
              <>
                {server.homebuilder_push_error && (
                  <p className="error">Couldn't send to Homebuilder Ops: {server.homebuilder_push_error}</p>
                )}
                <p className="muted">
                  {pushedCount} of {server.items.length} item(s) sent to Homebuilder Ops.
                </p>
                <button className="secondary" disabled={pushing} onClick={() => void retryPush()}>
                  {pushing ? "Sending…" : "Retry sending"}
                </button>
              </>
            );
          })()}
        </div>
      )}

      <ul className="list">
        {items.map((item) => {
          const media = server.media.filter((m) => m.item_id === item.id);
          return (
            <li key={item.id} className="item-card">
              {media.map((m) => (
                <MediaWithMove
                  key={m.id}
                  media={m}
                  items={items}
                  currentItemId={item.id}
                  locked={server.status === "finalized"}
                  onMove={(target) => void moveMedia(m.id, target)}
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

      {unassigned.length > 0 && (
        <div className="card">
          <h2>Unassigned photos</h2>
          <p className="muted">
            These didn't clearly match an item. Pick where each one goes, or leave it out.
          </p>
          {unassigned.map((m) => (
            <MediaWithMove
              key={m.id}
              media={m}
              items={items}
              currentItemId={null}
              locked={server.status === "finalized"}
              onMove={(target) => void moveMedia(m.id, target)}
            />
          ))}
        </div>
      )}

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

      <div className="walk-footer">
        <Link className="link-button" to="/">
          ← Projects
        </Link>
        {deleteButton}
      </div>
    </div>
  );
}

// A photo (or clip) with a "Move to…" picker underneath, for when the
// automatic match put it on the wrong item.
function MediaWithMove({
  media,
  items,
  currentItemId,
  locked,
  onMove,
}: {
  media: Media;
  items: Item[];
  currentItemId: string | null;
  locked: boolean;
  onMove: (targetItemId: string) => void;
}) {
  const src = `/uploads/${media.file_path}`;
  return (
    <div className="media-move">
      {media.kind === "video" ? (
        <video className="item-photo" src={src} controls playsInline preload="metadata" />
      ) : (
        <img className="item-photo" src={src} alt="" />
      )}
      {!locked && (
        <label className="move-label">
          {currentItemId ? "Move this photo to" : "Put this photo on"}
          <select value={currentItemId ?? ""} onChange={(e) => onMove(e.target.value)}>
            <option value="">— no item (leave out) —</option>
            {items.map((it, i) => (
              <option key={it.id} value={it.id}>
                {`#${i + 1} ${it.room ? it.room + ": " : ""}${it.description}`.slice(0, 70)}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
