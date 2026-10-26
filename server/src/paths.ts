import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Where the database and uploaded media live. One definition, used by db.ts,
// index.ts and every route that touches files.
//
// Render wipes a service's own filesystem on every redeploy, restart or
// spin-down — only files under an attached persistent disk survive. So:
//   1. DATA_DIR env var, if set, wins.
//   2. Otherwise, if a Render disk is mounted at /var/data (the mount path
//      DEPLOY.md tells you to use), use it automatically — no env var needed.
//   3. Otherwise (local dev), the server/ folder, same as before.
const serverRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RENDER_DISK = "/var/data";

export const dataRoot =
  process.env.DATA_DIR ||
  (fs.existsSync(RENDER_DISK) ? RENDER_DISK : serverRoot);

export const dbDir = path.join(dataRoot, "data");
export const uploadsDir = path.join(dataRoot, "uploads");

// Git doesn't track empty folders, and neither better-sqlite3 nor multer will
// create one, so make both on every boot (recursive = harmless if present).
fs.mkdirSync(dbDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

export const persistent = dataRoot !== serverRoot;
