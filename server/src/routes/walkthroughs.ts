import { Router } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { uploadsDir } from "../paths.js";
import { buildPunchListPdf, pdfFilename } from "../pdf.js";
import { deleteWalkthroughCompletely } from "../media.js";
import { pushWalkthrough, homebuilderConfigured } from "../homebuilder.js";
import { db } from "../db.js";
import { processWalkthroughStub } from "../processing/stub.js";
import { processWalkthroughWithClaude } from "../processing/claude.js";


const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (_req, file, cb) => {
      cb(null, `${randomUUID()}-${file.originalname}`);
    },
  }),
});

export const walkthroughsRouter = Router();

function getWalkthroughFull(id: string) {
  const walkthrough = db
    .prepare("SELECT * FROM walkthroughs WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  if (!walkthrough) return null;
  const items = db
    .prepare("SELECT * FROM items WHERE walkthrough_id = ? ORDER BY created_at ASC")
    .all(id);
  const media = db
    .prepare("SELECT * FROM media WHERE walkthrough_id = ? ORDER BY captured_at_ms ASC")
    .all(id);
  // Lets the client tell the difference between "real Claude drafting" and
  // "placeholder stub" without guessing from the item text.
  const aiConfigured = Boolean(process.env.ANTHROPIC_API_KEY);
  const project = db
    .prepare("SELECT homebuilder_project_id FROM projects WHERE id = ?")
    .get(walkthrough.project_id) as { homebuilder_project_id: number | null } | undefined;
  return {
    ...walkthrough,
    items,
    media,
    ai_configured: aiConfigured,
    homebuilder_configured: homebuilderConfigured(),
    homebuilder_project_id: project?.homebuilder_project_id ?? null,
  };
}

// Start a new walkthrough (offline-first: the client can create this locally
// and sync it later — the server id just needs to be reconcilable, so the
// client is expected to pass its own locally-generated id).
walkthroughsRouter.post("/", (req, res) => {
  const { projectId, clientId } = req.body ?? {};
  if (!projectId) return res.status(400).json({ error: "projectId is required" });
  const id = clientId || randomUUID();
  // INSERT OR IGNORE: the offline sync queue may retry this call after a
  // dropped connection, so creating the same walkthrough twice must be safe.
  db.prepare(
    "INSERT OR IGNORE INTO walkthroughs (id, project_id, status) VALUES (?, ?, 'recording')"
  ).run(id, projectId);
  res.status(201).json(getWalkthroughFull(id));
});

walkthroughsRouter.get("/", (req, res) => {
  const { projectId } = req.query;
  const rows = projectId
    ? db
        .prepare(
          "SELECT * FROM walkthroughs WHERE project_id = ? ORDER BY created_at DESC"
        )
        .all(projectId as string)
    : db.prepare("SELECT * FROM walkthroughs ORDER BY created_at DESC").all();
  res.json(rows);
});

walkthroughsRouter.get("/:id", (req, res) => {
  const full = getWalkthroughFull(req.params.id);
  if (!full) return res.status(404).json({ error: "not found" });
  res.json(full);
});

// Upload the full audio recording once the walkthrough is done (this is what
// the offline sync queue calls once the device is back online). The
// transcript rides along here too — it was already produced on-device (see
// client/src/transcribe/whisper.ts) before this upload ever happens, so the
// server never needs to run its own speech-to-text.
walkthroughsRouter.post(
  "/:id/audio",
  upload.single("audio"),
  (req, res) => {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: "audio file required" });
    const transcript = typeof req.body?.transcript === "string" ? req.body.transcript : null;
    // Timestamped segments ([{text,start,end}], ms from recording start —
    // same clock as each photo's capturedAtMs). Validated, then stored as
    // JSON; drafting uses them to tie photos to what was being said.
    let chunks: string | null = null;
    if (typeof req.body?.transcriptChunks === "string") {
      try {
        const parsed = JSON.parse(req.body.transcriptChunks);
        if (Array.isArray(parsed)) {
          chunks = JSON.stringify(
            parsed
              .filter((c) => c && typeof c.text === "string")
              .map((c) => ({ text: c.text, start: Number(c.start) || 0, end: Number(c.end) || 0 }))
          );
        }
      } catch {
        // bad JSON — fall back to the plain transcript
      }
    }
    // Store just the filename (served under /uploads/<filename>), not the
    // absolute disk path — the client needs a URL it can actually load.
    db.prepare(
      "UPDATE walkthroughs SET audio_path = ?, transcript = ?, transcript_chunks = ?, status = 'queued', recorded_at = datetime('now') WHERE id = ?"
    ).run(req.file.filename, transcript, chunks, id);
    res.json(getWalkthroughFull(id));
  }
);

// Attach a photo/video captured mid-recording. capturedAtMs = offset in ms
// from the start of the recording, used to auto-link it to the nearest
// preceding speech once real transcription is wired in.
walkthroughsRouter.post(
  "/:id/media",
  upload.single("file"),
  (req, res) => {
    const { id } = req.params;
    const { kind, capturedAtMs, clientId } = req.body ?? {};
    if (!req.file) return res.status(400).json({ error: "file required" });
    if (!kind || (kind !== "photo" && kind !== "video")) {
      return res.status(400).json({ error: "kind must be 'photo' or 'video'" });
    }
    const mediaId = clientId || randomUUID();
    // INSERT OR IGNORE for the same reason as the walkthrough create above —
    // safe to retry from the offline queue.
    db.prepare(
      `INSERT OR IGNORE INTO media (id, walkthrough_id, kind, file_path, captured_at_ms, confirmed)
       VALUES (?, ?, ?, ?, ?, 0)`
    ).run(mediaId, id, kind, req.file.filename, Number(capturedAtMs) || 0);
    res.status(201).json(
      db.prepare("SELECT * FROM media WHERE id = ?").get(mediaId)
    );
  }
);

// Live-confirm step: the app shows what a photo just got auto-linked to,
// and the user taps to confirm (or will re-tag it — re-tagging endpoint can
// follow once the client needs it).
walkthroughsRouter.patch("/:id/media/:mediaId/confirm", (req, res) => {
  db.prepare("UPDATE media SET confirmed = 1 WHERE id = ?").run(
    req.params.mediaId
  );
  res.json({ ok: true });
});

// Permanently delete a walkthrough and everything in it (items, photos,
// clips, audio). The phone confirms first. Items already pushed to
// Homebuilder Ops stay there — the client warns about that.
walkthroughsRouter.delete("/:id", (req, res) => {
  if (!deleteWalkthroughCompletely(req.params.id)) {
    return res.status(404).json({ error: "not found" });
  }
  res.json({ ok: true });
});

// Move a photo/clip to a different item on the same walkthrough, or to
// "unassigned" (itemId null). Allowed until the list is finalized.
walkthroughsRouter.patch("/:id/media/:mediaId", (req, res) => {
  const { id, mediaId } = req.params;
  const wt = db.prepare("SELECT status FROM walkthroughs WHERE id = ?").get(id) as
    | { status: string }
    | undefined;
  if (!wt) return res.status(404).json({ error: "not found" });
  if (wt.status === "finalized") {
    return res.status(409).json({ error: "This list is finalized — photos can't be moved." });
  }
  const itemId = req.body?.itemId ?? null;
  if (itemId !== null) {
    const item = db
      .prepare("SELECT id FROM items WHERE id = ? AND walkthrough_id = ?")
      .get(itemId, id);
    if (!item) return res.status(400).json({ error: "that item isn't on this walkthrough" });
  }
  const r = db
    .prepare("UPDATE media SET item_id = ?, confirmed = 1 WHERE id = ? AND walkthrough_id = ?")
    .run(itemId, mediaId, id);
  if (r.changes === 0) return res.status(404).json({ error: "photo not found" });
  res.json(getWalkthroughFull(id));
});

// Kick off processing: real Claude drafting pass when ANTHROPIC_API_KEY is
// configured (see processing/claude.ts and server/.env.example), otherwise
// the placeholder stub so the rest of the app still works without a key.
walkthroughsRouter.post("/:id/process", async (req, res) => {
  const { id } = req.params;
  // ?skipAi=1: draft placeholder items (one per photo) without calling
  // Claude — the way out when drafting keeps failing.
  const skipAi = req.query.skipAi === "1";
  const existing = db.prepare("SELECT status FROM walkthroughs WHERE id = ?").get(id) as
    | { status: string }
    | undefined;
  if (!existing) return res.status(404).json({ error: "not found" });
  // Already drafted (e.g. a retry from the phone after it lost the reply):
  // don't draft a second copy of every item.
  if (existing.status === "review" || existing.status === "finalized") {
    return res.json(getWalkthroughFull(id));
  }
  db.prepare("UPDATE walkthroughs SET status = 'processing' WHERE id = ?").run(id);
  try {
    if (process.env.ANTHROPIC_API_KEY && !skipAi) {
      await processWalkthroughWithClaude(id);
    } else {
      processWalkthroughStub(id);
    }
    db.prepare("UPDATE walkthroughs SET process_error = NULL WHERE id = ?").run(id);
  } catch (err) {
    const msg = describeError(err);
    console.error(`[process] walkthrough ${id} failed: ${msg}`);
    db.prepare(
      "UPDATE walkthroughs SET status = 'queued', process_error = ? WHERE id = ?"
    ).run(msg, id);
    return res.status(500).json({ error: msg });
  }
  res.json(getWalkthroughFull(id));
});

// Turns API errors into something readable on a phone screen.
function describeError(err: unknown): string {
  const e = err as { status?: number; message?: string; error?: { error?: { message?: string } } };
  const apiMsg = e?.error?.error?.message;
  const base = apiMsg || e?.message || String(err);
  if (e?.status === 401) return `Anthropic rejected the API key (401). Check ANTHROPIC_API_KEY on Render. ${base}`;
  if (e?.status === 403) return `Anthropic refused the request (403) — the key's workspace may not allow this. ${base}`;
  if (e?.status === 429) return `Anthropic rate or spend limit hit (429) — check the workspace spend limit/credits. ${base}`;
  if (e?.status === 400 && /credit|balance|billing/i.test(base)) return `Anthropic account is out of credit. ${base}`;
  if (e?.status) return `Anthropic error ${e.status}: ${base}`;
  return base;
}

// Finalize: every item must have a commitment date before this is allowed,
// per the plan. Finalizing is also what triggers the (future) Homebuilder
// Ops push.
walkthroughsRouter.post("/:id/finalize", async (req, res) => {
  const { id } = req.params;
  const items = db
    .prepare("SELECT id, commitment_date FROM items WHERE walkthrough_id = ?")
    .all(id) as { id: string; commitment_date: string | null }[];

  const missing = items.filter((i) => !i.commitment_date);
  if (missing.length > 0) {
    return res.status(400).json({
      error: "every item needs a commitment date before this list can be finalized",
      missingItemIds: missing.map((i) => i.id),
    });
  }

  db.prepare(
    "UPDATE walkthroughs SET status = 'finalized', finalized_at = COALESCE(finalized_at, datetime('now')) WHERE id = ?"
  ).run(id);

  // Push onto the linked project's punch list in Homebuilder Ops. A failed
  // push never un-finalizes the list: the error is stored on the walkthrough
  // and the review screen offers Retry (POST /:id/push below).
  await pushWalkthrough(id, publicBase(req));

  res.json(getWalkthroughFull(id));
});

// Retry (or first-time push, if the project was linked after finalizing).
walkthroughsRouter.post("/:id/push", async (req, res) => {
  const result = await pushWalkthrough(req.params.id, publicBase(req));
  const full = getWalkthroughFull(req.params.id);
  if (!full) return res.status(404).json({ error: "not found" });
  res.json({ ...full, push_result: result });
});

// The shareable PDF: every item on this walkthrough, with photos, under the
// Axxo LLC header. The phone hands it to the share sheet (text, email,
// AirDrop) — photos are inside the file, so the person receiving it doesn't
// need a login.
walkthroughsRouter.get("/:id/pdf", (req, res) => {
  const doc = buildPunchListPdf(req.params.id);
  if (!doc) return res.status(404).json({ error: "not found" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `${req.query.download ? "attachment" : "inline"}; filename="${pdfFilename(req.params.id)}"`
  );
  doc.pipe(res);
});

function publicBase(req: import("express").Request) {
  return `${req.protocol}://${req.get("host")}`;
}
