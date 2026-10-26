import { db } from "./db.js";

// Push finalized punch lists into Homebuilder Ops (separate app, separate
// Render service). Homebuilder Ops exposes two key-protected routes for this
// (see integrations.js in the homebuilder-app repo):
//   GET  /api/integrations/punch-list/projects
//   POST /api/integrations/punch-list/items
// Items land as kind 'punch' on that project's work list. One-way and
// one-time per item, per the plan: not a live sync.
//
// Configuration (Render → this service → Environment):
//   HOMEBUILDER_OPS_KEY  same value as PUNCHLIST_INTEGRATION_KEY on the
//                        Homebuilder Ops service. Unset = push turned off.
//   HOMEBUILDER_OPS_URL  optional; defaults to the live Homebuilder Ops URL.
const DEFAULT_URL = "https://homebuilder-app.onrender.com";

function baseUrl() {
  return (process.env.HOMEBUILDER_OPS_URL || DEFAULT_URL).replace(/\/+$/, "");
}

export function homebuilderConfigured() {
  return Boolean(process.env.HOMEBUILDER_OPS_KEY);
}

async function call(path: string, init: RequestInit = {}) {
  let res: Response;
  try {
    res = await fetch(baseUrl() + path, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${process.env.HOMEBUILDER_OPS_KEY}`,
        Accept: "application/json",
      },
      // Render services can take ~a minute to wake.
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new Error("couldn't reach Homebuilder Ops (it may be down or waking up) — try again in a minute");
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const msg = body && typeof body.error === "string" ? body.error : res.statusText;
    throw new Error(`Homebuilder Ops said ${res.status}: ${msg}`);
  }
  return body;
}

export interface HbProject {
  id: number;
  name: string;
  address: string | null;
  status: string | null;
}

export async function listHomebuilderProjects(): Promise<HbProject[]> {
  return (await call("/api/integrations/punch-list/projects")) as unknown as HbProject[];
}

interface ItemRow {
  id: string;
  room: string | null;
  description: string;
  trade: string | null;
  commitment_date: string | null;
  homebuilder_item_id: number | null;
}

// Pushes every not-yet-pushed item of a finalized walkthrough. Safe to call
// again (Retry): Homebuilder Ops de-duplicates on the Punch List item id, and
// items already stamped with a homebuilder_item_id are skipped here anyway.
// Never throws — the outcome is recorded on the walkthrough and returned.
export async function pushWalkthrough(
  walkthroughId: string,
  publicBaseUrl: string
): Promise<{ pushed: number; skipped?: string; error?: string }> {
  const wt = db
    .prepare(
      `SELECT w.id, w.status, w.recorded_at, w.created_at, p.homebuilder_project_id, p.name AS project_name
         FROM walkthroughs w JOIN projects p ON p.id = w.project_id WHERE w.id = ?`
    )
    .get(walkthroughId) as
    | {
        id: string;
        status: string;
        recorded_at: string | null;
        created_at: string;
        homebuilder_project_id: number | null;
        project_name: string;
      }
    | undefined;

  if (!wt) return { pushed: 0, error: "walkthrough not found" };
  if (wt.status !== "finalized") return { pushed: 0, skipped: "not finalized" };
  if (!homebuilderConfigured()) return { pushed: 0, skipped: "Homebuilder Ops key not set" };
  if (!wt.homebuilder_project_id) {
    return { pushed: 0, skipped: "project not linked to a Homebuilder Ops project" };
  }

  const items = db
    .prepare(
      "SELECT * FROM items WHERE walkthrough_id = ? AND homebuilder_item_id IS NULL ORDER BY created_at"
    )
    .all(walkthroughId) as ItemRow[];
  if (items.length === 0) {
    db.prepare("UPDATE walkthroughs SET homebuilder_push_error = NULL WHERE id = ?").run(walkthroughId);
    return { pushed: 0 };
  }

  const mediaFor = db.prepare(
    "SELECT file_path, kind FROM media WHERE item_id = ? ORDER BY captured_at_ms"
  );
  const walkDate = (wt.recorded_at || wt.created_at || "").slice(0, 10);

  const payload = items.map((it) => {
    const media = mediaFor.all(it.id) as { file_path: string; kind: string }[];
    const lines = [`From Punch List walkthrough${walkDate ? ` on ${walkDate}` : ""}.`];
    media.forEach((m, i) =>
      lines.push(
        `${m.kind === "video" ? "Video" : "Photo"} ${i + 1}: ${publicBaseUrl}/uploads/${encodeURIComponent(m.file_path)}`
      )
    );
    return {
      source_ref: it.id,
      title: it.description,
      detail: lines.join("\n"),
      location: it.room,
      trade: it.trade,
      due_date: it.commitment_date,
    };
  });

  try {
    const body = (await call("/api/integrations/punch-list/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: wt.homebuilder_project_id, items: payload }),
    })) as { results: { source_ref: string; work_item_id: number }[] };

    const stamp = db.prepare("UPDATE items SET homebuilder_item_id = ? WHERE id = ?");
    db.transaction(() => {
      for (const r of body.results) stamp.run(r.work_item_id, r.source_ref);
      db.prepare(
        "UPDATE walkthroughs SET pushed_to_homebuilder_ops_at = datetime('now'), homebuilder_push_error = NULL WHERE id = ?"
      ).run(walkthroughId);
    })();
    return { pushed: body.results.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.prepare("UPDATE walkthroughs SET homebuilder_push_error = ? WHERE id = ?").run(
      msg,
      walkthroughId
    );
    return { pushed: 0, error: msg };
  }
}
