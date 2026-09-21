import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, "..", "data", "punchlist.db");

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
