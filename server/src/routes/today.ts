import { Router } from "express";
import { db } from "../db.js";

export const todayRouter = Router();

// The daily follow-up digest: "open the app, see what's due." Items with a
// commitment date today or earlier that are still open, grouped by project
// (== job site) so it reads as "go check these N sites."
todayRouter.get("/", (req, res) => {
  const asOf = (req.query.date as string) || new Date().toISOString().slice(0, 10);

  const rows = db
    .prepare(
      `SELECT items.*, projects.name AS project_name, projects.address AS project_address
       FROM items
       JOIN projects ON projects.id = items.project_id
       WHERE items.status = 'open'
         AND items.commitment_date IS NOT NULL
         AND date(items.commitment_date) <= date(?)
       ORDER BY items.commitment_date ASC`
    )
    .all(asOf) as Array<Record<string, unknown>>;

  const byProject = new Map<
    string,
    { projectId: string; projectName: string; projectAddress: string | null; items: unknown[] }
  >();

  for (const row of rows) {
    const projectId = row.project_id as string;
    if (!byProject.has(projectId)) {
      byProject.set(projectId, {
        projectId,
        projectName: row.project_name as string,
        projectAddress: (row.project_address as string) ?? null,
        items: [],
      });
    }
    byProject.get(projectId)!.items.push(row);
  }

  res.json({ asOf, sites: Array.from(byProject.values()) });
});
