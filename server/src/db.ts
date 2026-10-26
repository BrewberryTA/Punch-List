import Database from "better-sqlite3";
import path from "node:path";
import { dbDir } from "./paths.js";

// Location (and the folder-creation it needs on a fresh deploy) lives in
// paths.ts: on Render it must sit on the persistent disk or it is wiped on
// every redeploy.
const dbPath = path.join(dbDir, "punchlist.db");

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    archived_at TEXT
  );

  CREATE TABLE IF NOT EXISTS walkthroughs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    -- lifecycle: recording -> queued -> processing -> review -> finalized
    status TEXT NOT NULL DEFAULT 'recording',
    audio_path TEXT,
    transcript TEXT,
    recorded_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    finalized_at TEXT,
    pushed_to_homebuilder_ops_at TEXT
  );

  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    walkthrough_id TEXT NOT NULL REFERENCES walkthroughs(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    room TEXT,
    description TEXT NOT NULL,
    transcript_snippet TEXT,
    trade TEXT,
    -- required before a walkthrough can be finalized
    commitment_date TEXT,
    status TEXT NOT NULL DEFAULT 'open', -- open | complete
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    item_id TEXT REFERENCES items(id),
    walkthrough_id TEXT NOT NULL REFERENCES walkthroughs(id),
    kind TEXT NOT NULL, -- photo | video
    file_path TEXT NOT NULL,
    captured_at_ms INTEGER NOT NULL, -- offset into the recording, for auto-linking
    confirmed INTEGER NOT NULL DEFAULT 0, -- live-confirm step, per the plan
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_walkthroughs_project ON walkthroughs(project_id);
  CREATE INDEX IF NOT EXISTS idx_items_walkthrough ON items(walkthrough_id);
  CREATE INDEX IF NOT EXISTS idx_items_project ON items(project_id);
  CREATE INDEX IF NOT EXISTS idx_items_commitment ON items(commitment_date);
  CREATE INDEX IF NOT EXISTS idx_media_walkthrough ON media(walkthrough_id);
`);

// Columns added after the first deploy. CREATE TABLE IF NOT EXISTS above does
// nothing to a table that already exists, so new columns are added here.
function addColumnIfMissing(table: string, column: string, def: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`);
  }
}

// Which Homebuilder Ops project this punch-list project pushes into (its
// integer id over there). Null = not linked, finalize pushes nothing.
addColumnIfMissing("projects", "homebuilder_project_id", "homebuilder_project_id INTEGER");
// Close-out: the job is done, its photos/video/audio are deleted from the
// server, the item text stays as the record.
addColumnIfMissing("projects", "closed_at", "closed_at TEXT");
addColumnIfMissing("projects", "media_deleted_at", "media_deleted_at TEXT");
// The punch item this became in Homebuilder Ops, once pushed.
addColumnIfMissing("items", "homebuilder_item_id", "homebuilder_item_id INTEGER");
// Last push failure, shown on the review screen with a Retry button. Cleared
// on success.
addColumnIfMissing("walkthroughs", "homebuilder_push_error", "homebuilder_push_error TEXT");
// Timestamped transcript from the phone ([{text,start,end}] in ms, JSON), so
// drafting can line up what was said with when each photo was taken.
addColumnIfMissing("walkthroughs", "transcript_chunks", "transcript_chunks TEXT");
// Why the last drafting attempt failed (shown on the phone), cleared on success.
addColumnIfMissing("walkthroughs", "process_error", "process_error TEXT");
