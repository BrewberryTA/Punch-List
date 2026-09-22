import { getDb, type LocalWalkthrough } from "./db";
import { transcribeAudioBlob } from "../transcribe/whisper";

type Listener = () => void;
const listeners = new Set<Listener>();
export function onSyncChange(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  listeners.forEach((fn) => fn());
}

let syncing = false;

/**
 * Two passes, run in order:
 *
 *  1. transcribeAll() — on-device Whisper, no network required. Runs even
 *     with zero signal, so a walkthrough recorded at a dead job site starts
 *     turning into text immediately instead of waiting for a connection.
 *  2. uploadAll() — the actual server sync (create walkthrough, upload
 *     audio + transcript + media, kick off the Claude drafting pass).
 *     Network-gated, same idempotent-retry design as before.
 *
 * Safe to call repeatedly — every step is skip-if-already-done.
 */
export async function syncAll() {
  if (syncing) return;
  syncing = true;
  try {
    await transcribeAll();
    if (navigator.onLine) {
      await uploadAll();
    }
  } finally {
    syncing = false;
    notify();
  }
}

async function transcribeAll() {
  const db = await getDb();
  const candidates = [
    ...(await db.getAllFromIndex("walkthroughs", "by-status", "ready_to_sync")),
    ...(await db.getAllFromIndex("walkthroughs", "by-status", "transcribing")),
    ...(await db.getAllFromIndex("walkthroughs", "by-status", "error")),
  ];
  const needsTranscript = candidates.filter((wt) => wt.transcript === undefined);
  for (const wt of needsTranscript) {
    try {
      await ensureTranscript(wt);
    } catch (err) {
      const current = (await db.get("walkthroughs", wt.id)) as LocalWalkthrough;
      await db.put("walkthroughs", {
        ...current,
        status: "error",
        lastError: err instanceof Error ? err.message : String(err),
      });
      notify();
    }
  }
}

async function ensureTranscript(wt: LocalWalkthrough) {
  const db = await getDb();
  await db.put("walkthroughs", { ...wt, status: "transcribing", transcriptionProgress: 0 });
  notify();

  const result = await transcribeAudioBlob(wt.audioBlob ?? new Blob(), (p) => {
    void db.put("walkthroughs", {
      ...wt,
      status: "transcribing",
      transcriptionProgress: Math.round(p.progress),
    });
    notify();
  });

  await db.put("walkthroughs", {
    ...wt,
    status: "ready_to_sync",
    transcript: result.text,
    transcriptChunks: result.chunks,
    transcriptionProgress: 100,
    lastError: undefined,
  });
  notify();
}

async function uploadAll() {
  const db = await getDb();
  const pending = await db.getAllFromIndex("walkthroughs", "by-status", "ready_to_sync");
  const errored = await db.getAllFromIndex("walkthroughs", "by-status", "error");
  for (const wt of [...pending, ...errored]) {
    // Still mid-transcription (or transcription failed and hasn't been
    // retried yet) — nothing to upload yet.
    if (wt.transcript === undefined) continue;
    await syncOne(wt.id);
  }
}

async function syncOne(walkthroughId: string) {
  const db = await getDb();
  let wt = await db.get("walkthroughs", walkthroughId);
  if (!wt) return;

  await db.put("walkthroughs", { ...wt, status: "syncing" });
  notify();

  try {
    // 1. create (idempotent)
    await fetch("/api/walkthroughs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: wt.projectId, clientId: wt.id }),
    }).then(assertOk);

    // 2. audio + the transcript produced on-device
    wt = (await db.get("walkthroughs", walkthroughId)) as LocalWalkthrough;
    if (!wt.audioUploaded && wt.audioBlob) {
      const form = new FormData();
      form.append("audio", wt.audioBlob, `${wt.id}.webm`);
      form.append("transcript", wt.transcript ?? "");
      await fetch(`/api/walkthroughs/${wt.id}/audio`, {
        method: "POST",
        body: form,
      }).then(assertOk);
      await db.put("walkthroughs", { ...wt, audioUploaded: true });
    }

    // 3. media
    const mediaItems = await db.getAllFromIndex(
      "media",
      "by-walkthrough",
      walkthroughId
    );
    for (const m of mediaItems) {
      if (m.uploaded) continue;
      const form = new FormData();
      form.append(
        "file",
        m.blob,
        `${m.id}.${m.kind === "photo" ? "jpg" : "webm"}`
      );
      form.append("kind", m.kind);
      form.append("capturedAtMs", String(m.capturedAtMs));
      form.append("clientId", m.id);
      await fetch(`/api/walkthroughs/${walkthroughId}/media`, {
        method: "POST",
        body: form,
      }).then(assertOk);
      await db.put("media", { ...m, uploaded: true });
    }

    // 4. kick off processing (real Claude drafting pass if the server has
    // an API key configured, otherwise the placeholder stub — see
    // server/src/routes/walkthroughs.ts)
    await fetch(`/api/walkthroughs/${walkthroughId}/process`, {
      method: "POST",
    }).then(assertOk);

    wt = (await db.get("walkthroughs", walkthroughId)) as LocalWalkthrough;
    await db.put("walkthroughs", { ...wt, status: "synced", lastError: undefined });
  } catch (err) {
    const current = (await db.get(
      "walkthroughs",
      walkthroughId
    )) as LocalWalkthrough;
    await db.put("walkthroughs", {
      ...current,
      status: "error",
      lastError: err instanceof Error ? err.message : String(err),
    });
  }
}

async function assertOk(res: Response) {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res;
}

// Try to drain the queue whenever the browser regains connectivity, and once
// on startup in case there's leftover work from a previous offline session.
// (Transcription itself runs regardless of connectivity — see syncAll.)
if (typeof window !== "undefined") {
  window.addEventListener("online", () => void syncAll());
  void syncAll();
  // Also poll every 30s while the tab is open — `online`/`offline` events
  // are unreliable on some mobile browsers.
  setInterval(() => void syncAll(), 30_000);
}
