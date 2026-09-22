import { Router } from "express";
import multer from "multer";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { db } from "../db.js";
import { processWalkthroughStub } from "../processing/stub.js";
import { processWalkthroughWithClaude } from "../processing/claude.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.join(__dirname, "..", "..", "uploads");

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
  return { ...walkthrough, items, media, ai_configured: aiConfigured };
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
    // Store just the filename (served under /uploads/<filename>), not the
    // absolute disk path — the client needs a URL it can actually load.
    db.prepare(
      "UPDATE walkthroughs SET audio_path = ?, transcript = ?, status = 'queued', recorded_at = datetime('now') WHERE id = ?"
    ).run(req.file.filename, transcript, id);
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

// Kick off processing: real Claude drafting pass when ANTHROPIC_API_KEY is
// configured (see processing/claude.ts and server/.env.example), otherwise
// the placeholder stub so the rest of the app still works without a key.
walkthroughsRouter.post("/:id/process", async (req, res) => {
  db.prepare(
    "UPDATE walkthroughs SET status = 'processing' WHERE id = ?"
  ).run(req.params.id);
  try {
    if (process.env.ANTHROPIC_API_KEY) {
      await processWalkthroughWithClaude(req.params.id);
    } else {
      processWalkthroughStub(req.params.id);
    }
  } catch (err) {
    db.prepare(
      "UPDATE walkthroughs SET status = 'queued' WHERE id = ?"
    ).run(req.params.id);
    return res.status(500).json({ error: (err as Error).message });
  }
  res.json(getWalkthroughFull(req.params.id));
});

// Finalize: every item must have a commitment date before this is allowed,
// per the plan. Finalizing is also what triggers the (future) Homebuilder
// Ops push.
walkthroughsRouter.post("/:id/finalize", (req, res) => {
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
    "UPDATE walkthroughs SET status = 'finalized', finalized_at = datetime('now') WHERE id = ?"
  ).run(id);

  // TODO: push items onto this project's existing open-task list in
  // Homebuilder Ops here, then stamp pushed_to_homebuilder_ops_at.

  res.json(getWalkthroughFull(id));
});
