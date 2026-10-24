import { Router } from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../db.js";

export const projectsRouter = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.join(__dirname, "..", "..", "uploads");

projectsRouter.get("/", (_req, res) => {
  const projects = db
    .prepare(
      "SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at DESC"
    )
    .all();
  res.json(projects);
});

projectsRouter.post("/", (req, res) => {
  const { name, address } = req.body ?? {};
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }
  const id = randomUUID();
  db.prepare(
    "INSERT INTO projects (id, name, address) VALUES (?, ?, ?)"
  ).run(id, name, address ?? null);
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
  res.status(201).json(project);
});

projectsRouter.patch("/:id/archive", (req, res) => {
  const { id } = req.params;
  db.prepare(
    "UPDATE projects SET archived_at = datetime('now') WHERE id = ?"
  ).run(id);
  res.json({ ok: true });
});

// Permanently deletes a project and everything under it (walkthroughs,
// items, media rows, and the actual uploaded photo/video/audio files on
// disk) — e.g. to clear out test projects. This can't be undone, which is
// why the client makes the user confirm before calling it.
projectsRouter.delete("/:id", (req, res) => {
  const { id } = req.params;

  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(id);
  if (!project) return res.status(404).json({ error: "not found" });

  const walkthroughIds = (
    db
      .prepare("SELECT id FROM walkthroughs WHERE project_id = ?")
      .all(id) as { id: string }[]
  ).map((w) => w.id);

  if (walkthroughIds.length > 0) {
    const placeholders = walkthroughIds.map(() => "?").join(",");

    // Best-effort cleanup of uploaded files on disk — a file that's already
    // missing shouldn't block deleting the database records.
    const mediaFiles = db
      .prepare(
        `SELECT file_path FROM media WHERE walkthrough_id IN (${placeholders})`
      )
      .all(...walkthroughIds) as { file_path: string }[];
    const audioFiles = db
      .prepare(
        `SELECT audio_path FROM walkthroughs WHERE id IN (${placeholders}) AND audio_path IS NOT NULL`
      )
      .all(...walkthroughIds) as { audio_path: string }[];
    for (const f of [
      ...mediaFiles.map((m) => m.file_path),
      ...audioFiles.map((w) => w.audio_path),
    ]) {
      try {
        fs.unlinkSync(path.join(uploadsDir, f));
      } catch {
        // already gone, or never existed — fine
      }
    }

    const deleteAll = db.transaction(() => {
      db.prepare(
        `DELETE FROM media WHERE walkthrough_id IN (${placeholders})`
      ).run(...walkthroughIds);
      db.prepare(
        `DELETE FROM items WHERE walkthrough_id IN (${placeholders})`
      ).run(...walkthroughIds);
      db.prepare(
        `DELETE FROM walkthroughs WHERE id IN (${placeholders})`
      ).run(...walkthroughIds);
      db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    });
    deleteAll();
  } else {
    db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  res.json({ ok: true });
});
