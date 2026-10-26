import fs from "node:fs";
import path from "node:path";
import { db } from "./db.js";
import { uploadsDir } from "./paths.js";

// Deletes every photo, video clip and audio recording stored for a project,
// from disk AND from the database (media rows go, walkthrough audio_path is
// cleared). Item text, rooms, trades, dates and completion state are kept.
// Used by close-out (keeps the project as a record) and by delete project.
// Returns how many files were removed.
export function deleteProjectMediaFiles(projectId: string): number {
  const walkthroughIds = (
    db.prepare("SELECT id FROM walkthroughs WHERE project_id = ?").all(projectId) as {
      id: string;
    }[]
  ).map((w) => w.id);
  if (walkthroughIds.length === 0) return 0;

  const placeholders = walkthroughIds.map(() => "?").join(",");
  const mediaFiles = db
    .prepare(`SELECT file_path FROM media WHERE walkthrough_id IN (${placeholders})`)
    .all(...walkthroughIds) as { file_path: string }[];
  const audioFiles = db
    .prepare(
      `SELECT audio_path FROM walkthroughs WHERE id IN (${placeholders}) AND audio_path IS NOT NULL`
    )
    .all(...walkthroughIds) as { audio_path: string }[];

  let removed = 0;
  for (const f of [
    ...mediaFiles.map((m) => m.file_path),
    ...audioFiles.map((w) => w.audio_path),
  ]) {
    // basename: the DB only ever stores a bare filename, but never let a bad
    // row point a delete outside the uploads folder.
    try {
      fs.unlinkSync(path.join(uploadsDir, path.basename(f)));
      removed++;
    } catch {
      // already gone, or never existed — fine
    }
  }

  db.transaction(() => {
    db.prepare(`DELETE FROM media WHERE walkthrough_id IN (${placeholders})`).run(
      ...walkthroughIds
    );
    db.prepare(
      `UPDATE walkthroughs SET audio_path = NULL WHERE id IN (${placeholders})`
    ).run(...walkthroughIds);
  })();

  return removed;
}

// Deletes one walkthrough completely: its photo/video/audio files on disk,
// its media rows, its items and the walkthrough itself. No undo.
export function deleteWalkthroughCompletely(walkthroughId: string): boolean {
  const wt = db
    .prepare("SELECT audio_path FROM walkthroughs WHERE id = ?")
    .get(walkthroughId) as { audio_path: string | null } | undefined;
  if (!wt) return false;
  const files = (
    db.prepare("SELECT file_path FROM media WHERE walkthrough_id = ?").all(walkthroughId) as {
      file_path: string;
    }[]
  ).map((m) => m.file_path);
  if (wt.audio_path) files.push(wt.audio_path);
  for (const f of files) {
    try {
      fs.unlinkSync(path.join(uploadsDir, path.basename(f)));
    } catch {
      // already gone — fine
    }
  }
  db.transaction(() => {
    db.prepare("DELETE FROM media WHERE walkthrough_id = ?").run(walkthroughId);
    db.prepare("DELETE FROM items WHERE walkthrough_id = ?").run(walkthroughId);
    db.prepare("DELETE FROM walkthroughs WHERE id = ?").run(walkthroughId);
  })();
  return true;
}
