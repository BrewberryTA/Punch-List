import { Router } from "express";
import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { deleteProjectMediaFiles } from "../media.js";

export const projectsRouter = Router();

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

// Close out a finished job: deletes every photo, video clip and audio
// recording stored for it (that's the storage that costs money), keeps the
// item text as the record, and moves the project off the main list. Open
// items are allowed — the client warns first — since a job can close with
// warranty items still trailing.
projectsRouter.post("/:id/close-out", (req, res) => {
  const { id } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(id);
  if (!project) return res.status(404).json({ error: "not found" });
  const filesDeleted = deleteProjectMediaFiles(id);
  db.prepare(
    `UPDATE projects
       SET closed_at = COALESCE(closed_at, datetime('now')),
           archived_at = COALESCE(archived_at, datetime('now')),
           media_deleted_at = datetime('now')
     WHERE id = ?`
  ).run(id);
  res.json({ ok: true, filesDeleted });
});

// Closed-out projects, newest first — the record of finished jobs.
projectsRouter.get("/closed", (_req, res) => {
  res.json(
    db
      .prepare(
        "SELECT * FROM projects WHERE closed_at IS NOT NULL ORDER BY closed_at DESC"
      )
      .all()
  );
});

// How many open items a project still has — shown in the close-out warning.
projectsRouter.get("/:id/open-count", (req, res) => {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM items WHERE project_id = ? AND status = 'open'")
    .get(req.params.id) as { n: number };
  res.json({ open: row.n });
});

// Link (or unlink, with null) the Homebuilder Ops project this one pushes
// finalized punch lists into.
projectsRouter.patch("/:id/homebuilder", (req, res) => {
  const { id } = req.params;
  const raw = req.body?.homebuilderProjectId;
  const hbId = raw === null || raw === "" || raw === undefined ? null : Number(raw);
  if (hbId !== null && !Number.isInteger(hbId)) {
    return res.status(400).json({ error: "homebuilderProjectId must be an integer or null" });
  }
  const r = db
    .prepare("UPDATE projects SET homebuilder_project_id = ? WHERE id = ?")
    .run(hbId, id);
  if (r.changes === 0) return res.status(404).json({ error: "not found" });
  res.json(db.prepare("SELECT * FROM projects WHERE id = ?").get(id));
});

// Permanently deletes a project and everything under it (walkthroughs,
// items, media rows, and the actual uploaded photo/video/audio files on
// disk) — e.g. to clear out test projects. This can't be undone, which is
// why the client makes the user confirm before calling it.
projectsRouter.delete("/:id", (req, res) => {
  const { id } = req.params;
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(id);
  if (!project) return res.status(404).json({ error: "not found" });

  deleteProjectMediaFiles(id);
  db.transaction(() => {
    db.prepare("DELETE FROM items WHERE project_id = ?").run(id);
    db.prepare("DELETE FROM walkthroughs WHERE project_id = ?").run(id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  })();

  res.json({ ok: true });
});
