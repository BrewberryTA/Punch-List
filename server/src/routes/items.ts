import { Router } from "express";
import { db } from "../db.js";

export const itemsRouter = Router();

const EDITABLE_FIELDS = ["room", "description", "trade", "commitment_date"] as const;

itemsRouter.patch("/:id", (req, res) => {
  const { id } = req.params;
  const updates: string[] = [];
  const values: unknown[] = [];

  for (const field of EDITABLE_FIELDS) {
    // accept camelCase from the client, map to snake_case column
    const camel = field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (req.body && camel in req.body) {
      updates.push(`${field} = ?`);
      values.push(req.body[camel]);
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: "no editable fields provided" });
  }

  values.push(id);
  db.prepare(`UPDATE items SET ${updates.join(", ")} WHERE id = ?`).run(
    ...values
  );
  res.json(db.prepare("SELECT * FROM items WHERE id = ?").get(id));
});

// Simple checkbox mark-complete, per the plan (no photo-proof requirement).
itemsRouter.patch("/:id/complete", (req, res) => {
  db.prepare(
    "UPDATE items SET status = 'complete', completed_at = datetime('now') WHERE id = ?"
  ).run(req.params.id);
  res.json(db.prepare("SELECT * FROM items WHERE id = ?").get(req.params.id));
});

itemsRouter.patch("/:id/reopen", (req, res) => {
  db.prepare(
    "UPDATE items SET status = 'open', completed_at = NULL WHERE id = ?"
  ).run(req.params.id);
  res.json(db.prepare("SELECT * FROM items WHERE id = ?").get(req.params.id));
});
