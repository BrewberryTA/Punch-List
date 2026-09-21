import { getDb, type LocalWalkthrough } from "./db";

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
 * Walks every locally-queued walkthrough and pushes whatever hasn't made it
 * to the server yet: create the walkthrough, upload the audio, upload each
 * unsent photo/video, then kick off processing. Safe to call repeatedly —
 * every step is skip-if-already-done, and the server ignores duplicate
 * creates (see the server's INSERT OR IGNORE), so a walkthrough that starts
 * uploading on one property and gets interrupted by another recording just
 * picks back up next time sync runs.
 */
export async function syncAll() {
  if (syncing) return;
  if (!navigator.onLine) return;
  syncing = true;
  try {
    const db = await getDb();
    const pending = await db.getAllFromIndex(
      "walkthroughs",
      "by-status",
      "ready_to_sync"
    );
    const errored = await db.getAllFromIndex(
      "walkthroughs",
      "by-status",
      "error"
    );
    for (const wt of [...pending, ...errored]) {
      await syncOne(wt.id);
    }
  } finally {
    syncing = false;
    notify();
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

    // 2. audio
    wt = (await db.get("walkthroughs", walkthroughId)) as LocalWalkthrough;
    if (!wt.audioUploaded && wt.audioBlob) {
      const form = new FormData();
      form.append("audio", wt.audioBlob, `${wt.id}.webm`);
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

    // 4. kick off (stubbed) processing now that everything is uploaded
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
if (typeof window !== "undefined") {
  window.addEventListener("online", () => void syncAll());
  void syncAll();
  // Also poll every 30s while the tab is open — `online`/`offline` events
  // are unreliable on some mobile browsers.
  setInterval(() => void syncAll(), 30_000);
}
