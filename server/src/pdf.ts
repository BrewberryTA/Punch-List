import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { db } from "./db.js";
import { uploadsDir } from "./paths.js";

// The shareable punch list: one walkthrough, every item, with its photos.
// Built here (not on the phone) because the photos live on the server; the
// phone fetches the finished file and hands it to the share sheet.
//
// Visual language borrows Homebuilder Ops' blueprint ink (#1f3fa8) so a sub
// receiving it sees the same "Axxo" look as everything else.

const COMPANY = "Axxo LLC";
const INK = "#1f3fa8";
const TEXT = "#152c7a";
const MUTED = "#5b6b9e";
const RULE = "#b9c3e6";
const BAD = "#b0322c";

interface Item {
  id: string;
  room: string | null;
  description: string;
  trade: string | null;
  commitment_date: string | null;
  status: string;
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(
    iso.length === 10 ? iso + "T12:00:00" : iso.includes("T") ? iso : iso.replace(" ", "T") + "Z"
  );
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Phoenix",
  });
}

export function pdfFilename(walkthroughId: string) {
  const row = db
    .prepare(
      `SELECT p.name, w.recorded_at, w.created_at FROM walkthroughs w
         JOIN projects p ON p.id = w.project_id WHERE w.id = ?`
    )
    .get(walkthroughId) as { name: string; recorded_at: string | null; created_at: string } | undefined;
  if (!row) return "punch-list.pdf";
  const date = (row.recorded_at || row.created_at || "").slice(0, 10);
  const safe = row.name.replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "-") || "project";
  return `Punch-List-${safe}-${date}.pdf`;
}

// Returns null if the walkthrough doesn't exist.
export function buildPunchListPdf(walkthroughId: string): PDFKit.PDFDocument | null {
  const wt = db
    .prepare(
      `SELECT w.*, p.name AS project_name, p.address AS project_address
         FROM walkthroughs w JOIN projects p ON p.id = w.project_id WHERE w.id = ?`
    )
    .get(walkthroughId) as
    | {
        status: string;
        recorded_at: string | null;
        created_at: string;
        finalized_at: string | null;
        project_name: string;
        project_address: string | null;
      }
    | undefined;
  if (!wt) return null;

  const items = db
    .prepare("SELECT * FROM items WHERE walkthrough_id = ? ORDER BY created_at, rowid")
    .all(walkthroughId) as Item[];
  const photosFor = db.prepare(
    "SELECT file_path FROM media WHERE item_id = ? AND kind = 'photo' ORDER BY captured_at_ms"
  );
  const videosFor = db.prepare(
    "SELECT COUNT(*) AS n FROM media WHERE item_id = ? AND kind = 'video'"
  );

  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 54, bottom: 60, left: 54, right: 54 },
    bufferPages: true,
    info: {
      Title: `Punch List — ${wt.project_name}`,
      Author: COMPANY,
    },
  });

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const bottom = () => doc.page.height - doc.page.margins.bottom;

  // ---------- header ----------
  doc.rect(left, 46, width, 3).fill(INK);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(20).text(COMPANY, left, 60);
  doc
    .fillColor(INK)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text("PUNCH LIST", left, 67, { width, align: "right", characterSpacing: 2 });

  doc.moveDown(0.8);
  doc.fillColor(TEXT).font("Helvetica-Bold").fontSize(15).text(wt.project_name, left);
  if (wt.project_address) {
    doc.fillColor(MUTED).font("Helvetica").fontSize(10.5).text(wt.project_address, left);
  }
  const walkDate = fmtDate(wt.recorded_at || wt.created_at);
  const open = items.filter((i) => i.status !== "complete").length;
  const meta = [
    walkDate && `Walkthrough: ${walkDate}`,
    `${items.length} item${items.length === 1 ? "" : "s"}${open !== items.length ? ` (${open} open)` : ""}`,
    wt.status === "finalized" ? null : "DRAFT — not yet finalized",
  ]
    .filter(Boolean)
    .join("    ·    ");
  doc.moveDown(0.3);
  doc
    .fillColor(wt.status === "finalized" ? MUTED : BAD)
    .font("Helvetica")
    .fontSize(9.5)
    .text(meta, left);
  doc.moveDown(0.6);
  doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.75).strokeColor(RULE).stroke();
  doc.moveDown(0.8);

  if (items.length === 0) {
    doc.fillColor(MUTED).font("Helvetica-Oblique").fontSize(11).text("No items on this list.", left);
  }

  // ---------- items ----------
  const PHOTO_W = 168;
  const PHOTO_MAX_H = 126;
  const GAP = 14;

  items.forEach((it, idx) => {
    const photos: { file: string; w: number; h: number }[] = [];
    for (const row of photosFor.all(it.id) as { file_path: string }[]) {
      const file = path.join(uploadsDir, path.basename(row.file_path));
      if (!fs.existsSync(file)) continue;
      try {
        // openImage is real pdfkit API, just missing from its type definitions
        const img = (doc as unknown as { openImage(f: string): { width: number; height: number } }).openImage(file);
        const scale = Math.min(PHOTO_W / img.width, PHOTO_MAX_H / img.height);
        photos.push({ file, w: img.width * scale, h: img.height * scale });
      } catch {
        // unreadable image — leave it out rather than fail the whole PDF
      }
    }
    const videos = (videosFor.get(it.id) as { n: number }).n;
    const hasPhotos = photos.length > 0;
    const textW = hasPhotos ? width - PHOTO_W - GAP - 28 : width - 28;
    const textX = left + 28;

    const title = it.room ? it.room : "General";
    const details = [
      it.trade ? `Trade: ${it.trade}` : null,
      it.commitment_date ? `Due: ${fmtDate(it.commitment_date)}` : null,
      it.status === "complete" ? "COMPLETE" : null,
      videos ? `${videos} video clip${videos === 1 ? "" : "s"} on file` : null,
    ]
      .filter(Boolean)
      .join("    ");

    // measure so an item never splits across pages
    doc.font("Helvetica-Bold").fontSize(11);
    let textH = doc.heightOfString(title, { width: textW }) + 3;
    doc.font("Helvetica").fontSize(10.5);
    textH += doc.heightOfString(it.description, { width: textW }) + 4;
    if (details) {
      doc.font("Helvetica").fontSize(9);
      textH += doc.heightOfString(details, { width: textW });
    }
    const photoH = photos.reduce((sum, p) => sum + p.h + 6, 0);
    const blockH = Math.max(textH, photoH) + 18;

    if (doc.y + Math.min(blockH, bottom() - doc.page.margins.top) > bottom()) {
      doc.addPage();
    }
    const top = doc.y;

    // number bubble
    doc.circle(left + 10, top + 7, 10).lineWidth(1).strokeColor(INK).stroke();
    doc
      .fillColor(INK)
      .font("Helvetica-Bold")
      .fontSize(9)
      .text(String(idx + 1), left, top + 3, { width: 20, align: "center" });

    doc.fillColor(TEXT).font("Helvetica-Bold").fontSize(11).text(title, textX, top, { width: textW });
    doc.moveDown(0.15);
    doc.fillColor("#1d2440").font("Helvetica").fontSize(10.5).text(it.description, textX, doc.y, {
      width: textW,
    });
    if (details) {
      doc.moveDown(0.25);
      doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(details, textX, doc.y, { width: textW });
    }
    const textBottom = doc.y;

    let py = top;
    for (const p of photos) {
      const x = right - p.w;
      doc.image(p.file, x, py, { width: p.w, height: p.h });
      doc.rect(x, py, p.w, p.h).lineWidth(0.5).strokeColor(RULE).stroke();
      py += p.h + 6;
    }

    doc.y = Math.max(textBottom, photos.length ? py - 6 : top) + 9;
    doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.5).strokeColor(RULE).stroke();
    doc.y += 9;
    doc.x = left;
  });

  // ---------- footer on every page ----------
  const range = doc.bufferedPageRange();
  const generated = fmtDate(new Date().toISOString());
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // writing inside the bottom margin would otherwise trigger a new page
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 40;
    doc
      .fillColor(MUTED)
      .font("Helvetica")
      .fontSize(8)
      .text(`${COMPANY}  ·  ${wt.project_name}  ·  Generated ${generated}`, left, y, {
        width: width / 1.4,
        lineBreak: false,
      })
      .text(`Page ${i - range.start + 1} of ${range.count}`, left, y, {
        width,
        align: "right",
        lineBreak: false,
      });
  }

  doc.end();
  return doc;
}
