import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { db } from "./db.js";
import { buildPunchListPdf } from "./pdf.js";
import { uploadsDir } from "./paths.js";

// Push finalized punch lists into Homebuilder Ops (separate app, separate
// Render service). Homebuilder Ops exposes two key-protected routes for this
// (see integrations.js in the homebuilder-app repo):
//   GET  /api/integrations/punch-list/projects
//   POST /api/integrations/punch-list/items
//   POST /api/integrations/punch-list/walkthrough          (2026-10-29)
//   POST /api/integrations/punch-list/walkthrough-report   (2026-10-29)
//   POST /api/integrations/punch-list/photo                (2026-10-29)
// Items land as kind 'punch' on that project's work list, grouped under the
// walkthrough they came from, with this walkthrough's PDF report and its
// photos copied across (Steve, 2026-10-29: a pushed list stays tied to the
// job's to-dos, with its report and photos). Photos are COPIED, not linked,
// because close-out here deletes them. One-way, not a live sync; every step
// is safe to repeat — Homebuilder Ops de-duplicates on our ids.
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

async function call(urlPath: string, init: RequestInit = {}) {
  let res: Response;
  try {
    res = await fetch(baseUrl() + urlPath, {
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

// Pushes a finalized walkthrough: the walkthrough itself, every item, the PDF
// report, and every photo. Safe to call again (Retry): Homebuilder Ops
// de-duplicates on the walkthrough, item and photo ids, so a repeat sends
// nothing twice — and a walkthrough pushed before reports and photos existed
// picks them up on its next push. Never throws — the outcome is recorded on
// the walkthrough and returned.
export async function pushWalkthrough(
  walkthroughId: string,
  publicBaseUrl: string
): Promise<{ pushed: number; photos?: number; report?: boolean; skipped?: string; error?: string }> {
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

  // Every item, not just the unpushed ones: Homebuilder Ops returns the ids it
  // already has, and sending them all is what files an older walkthrough's
  // items under it.
  const items = db
    .prepare("SELECT * FROM items WHERE walkthrough_id = ? ORDER BY created_at")
    .all(walkthroughId) as ItemRow[];
  const media = db
    .prepare("SELECT id, item_id, kind, file_path, created_at, homebuilder_photo_id FROM media WHERE walkthrough_id = ? ORDER BY captured_at_ms")
    .all(walkthroughId) as {
      id: string; item_id: string | null; kind: string; file_path: string; created_at: string; homebuilder_photo_id: number | null;
    }[];
  const walkDate = (wt.recorded_at || wt.created_at || "").slice(0, 10);

  try {
    // 1. The walkthrough, so the items can be grouped under it.
    await call("/api/integrations/punch-list/walkthrough", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: wt.homebuilder_project_id,
        source_ref: wt.id,
        walked_on: /^\d{4}-\d{2}-\d{2}$/.test(walkDate) ? walkDate : null,
      }),
    });

    // 2. The items. Photos travel separately (step 4); a video stays a link,
    //    because the photo wall takes pictures.
    let pushed = 0;
    if (items.length) {
      const payload = items.map((it) => {
        const lines = [`From Punch List walkthrough${walkDate ? ` on ${walkDate}` : ""}.`];
        media
          .filter((m) => m.item_id === it.id && m.kind === "video")
          .forEach((m, i) => lines.push(`Video ${i + 1}: ${publicBaseUrl}/uploads/${encodeURIComponent(m.file_path)}`));
        return {
          source_ref: it.id,
          title: it.description,
          detail: lines.join("\n"),
          location: it.room,
          trade: it.trade,
          due_date: it.commitment_date,
        };
      });
      const body = (await call("/api/integrations/punch-list/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: wt.homebuilder_project_id, walkthrough_ref: wt.id, items: payload }),
      })) as { results: { source_ref: string; work_item_id: number; created: boolean }[] };
      const stamp = db.prepare("UPDATE items SET homebuilder_item_id = ? WHERE id = ?");
      db.transaction(() => {
        for (const r of body.results) stamp.run(r.work_item_id, r.source_ref);
      })();
      pushed = body.results.filter((r) => r.created).length;
    }

    // 3. The report — the same PDF the share button makes.
    const pdf = await pdfBuffer(walkthroughId);
    if (pdf) {
      await call(`/api/integrations/punch-list/walkthrough-report?ref=${encodeURIComponent(wt.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: new Uint8Array(pdf),
      });
    }

    // 4. Every photo, resized the way Homebuilder Ops' own camera button
    //    resizes (1600px, JPEG q80), tied to its item.
    let photos = 0;
    const stampPhoto = db.prepare("UPDATE media SET homebuilder_photo_id = ? WHERE id = ?");
    for (const m of media.filter((x) => x.kind === "photo" && !x.homebuilder_photo_id)) {
      const file = path.join(uploadsDir, m.file_path);
      if (!fs.existsSync(file)) continue; // already closed out here; nothing to copy
      const jpeg = await sharp(file).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 }).toBuffer();
      const headers: Record<string, string> = {
        "Content-Type": "image/jpeg",
        "X-Walkthrough-Ref": wt.id,
        "X-Source-Ref": m.id,
        "X-Filename": encodeURIComponent(path.basename(m.file_path)),
      };
      if (m.item_id) headers["X-Item-Ref"] = m.item_id;
      if (m.created_at) headers["X-Taken-At"] = new Date(m.created_at.replace(" ", "T") + "Z").toISOString();
      const r = (await call("/api/integrations/punch-list/photo", { method: "POST", headers, body: new Uint8Array(jpeg) })) as { photo_id: number };
      stampPhoto.run(r.photo_id, m.id);
      photos++;
    }

    db.prepare(
      "UPDATE walkthroughs SET pushed_to_homebuilder_ops_at = datetime('now'), homebuilder_push_error = NULL WHERE id = ?"
    ).run(walkthroughId);
    return { pushed, photos, report: !!pdf };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.prepare("UPDATE walkthroughs SET homebuilder_push_error = ? WHERE id = ?").run(msg, walkthroughId);
    return { pushed: 0, error: msg };
  }
}

// pdf.ts builds a PDFKit document (already ended); collect it into a buffer.
function pdfBuffer(walkthroughId: string): Promise<Buffer | null> {
  const doc = buildPunchListPdf(walkthroughId);
  if (!doc) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    doc.on("data", (c: Buffer) => parts.push(c));
    doc.on("end", () => resolve(Buffer.concat(parts)));
    doc.on("error", reject);
  });
}

// Checks a username/password against Homebuilder Ops, so Punch List uses the
// same logins. Returns the user on success, null on a wrong password, and
// throws if Homebuilder Ops can't be asked at all (key missing, or down).
export async function verifyHomebuilderLogin(
  username: string,
  password: string
): Promise<{
  hb_user_id: number;
  username: string;
  display_name: string | null;
  role: string | null;
} | null> {
  if (!homebuilderConfigured()) {
    throw new Error("Logins aren't set up: HOMEBUILDER_OPS_KEY is missing on the Punch-List service.");
  }
  try {
    const u = (await call("/api/integrations/punch-list/verify-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    })) as { id: number; username: string; display_name: string | null; role: string | null };
    return { hb_user_id: u.id, username: u.username, display_name: u.display_name, role: u.role };
  } catch (e) {
    if (e instanceof Error && e.message.includes(" 401:")) return null;
    throw e;
  }
}
