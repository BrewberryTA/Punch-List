import { Router } from "express";
import { randomUUID } from "node:crypto";
import { db } from "../db.js";

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
