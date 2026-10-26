import { Router, type Request, type Response, type NextFunction } from "express";
import crypto from "node:crypto";
import { db } from "./db.js";
import { verifyHomebuilderLogin } from "./homebuilder.js";

// Logins: Punch List uses the same usernames and passwords as Homebuilder
// Ops. It never stores a password — it asks Homebuilder Ops "is this right?"
// (see integrations.js over there), then issues its own session cookie.
//
// Sessions last 90 days and renew on use, so a phone that's been offline at
// a job site for a while still opens straight into the app. Recording never
// needs the server anyway; the session only matters when uploading/syncing.

const SESSION_DAYS = 90;
const COOKIE = "pl_session";

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    hb_user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    display_name TEXT,
    role TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`);

export interface SessionUser {
  hb_user_id: number;
  username: string;
  display_name: string | null;
  role: string | null;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: SessionUser;
  }
}

function hashToken(token: string) {
  // Store only a hash, so a copy of the database can't be used to log in.
  return crypto.createHash("sha256").update(token).digest("hex");
}

function expiry() {
  return new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
}

function readCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i !== -1 && part.slice(0, i).trim() === COOKIE) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return null;
}

function setCookie(req: Request, res: Response, token: string) {
  const attrs = [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_DAYS * 86_400}`,
  ];
  if (req.secure) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

function lookup(req: Request): SessionUser | null {
  const token = readCookie(req);
  if (!token) return null;
  const row = db
    .prepare("SELECT * FROM sessions WHERE token = ?")
    .get(hashToken(token)) as (SessionUser & { expires_at: string }) | undefined;
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(hashToken(token));
    return null;
  }
  // Sliding renewal: using the app keeps you logged in.
  db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(expiry(), hashToken(token));
  return {
    hb_user_id: row.hb_user_id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
  };
}

// Blocks every data route and every uploaded photo/video unless logged in.
// The app shell itself (HTML/JS) stays public — it holds no data, and it has
// to load with no signal for offline recording to work.
export function requireLogin(req: Request, res: Response, next: NextFunction) {
  const user = lookup(req);
  if (!user) return res.status(401).json({ error: "Not signed in." });
  req.user = user;
  next();
}

// Simple brake on password guessing: 10 failed tries per IP per 15 minutes.
const failures = new Map<string, { count: number; until: number }>();
function tooManyFailures(ip: string) {
  const f = failures.get(ip);
  return Boolean(f && f.count >= 10 && f.until > Date.now());
}
function noteFailure(ip: string) {
  const f = failures.get(ip);
  if (!f || f.until < Date.now()) failures.set(ip, { count: 1, until: Date.now() + 15 * 60_000 });
  else f.count++;
}

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  const ip = req.ip || "unknown";
  if (tooManyFailures(ip)) {
    return res.status(429).json({ error: "Too many failed attempts. Try again in 15 minutes." });
  }
  const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
  if (!username || !password) {
    return res.status(400).json({ error: "Enter your username and password." });
  }
  let user: SessionUser | null;
  try {
    user = await verifyHomebuilderLogin(username, password);
  } catch (e) {
    return res.status(503).json({ error: e instanceof Error ? e.message : String(e) });
  }
  if (!user) {
    noteFailure(ip);
    return res.status(401).json({ error: "Incorrect username or password." });
  }
  failures.delete(ip);
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare(
    "INSERT INTO sessions (token, hb_user_id, username, display_name, role, expires_at) VALUES (?,?,?,?,?,?)"
  ).run(hashToken(token), user.hb_user_id, user.username, user.display_name, user.role, expiry());
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
  setCookie(req, res, token);
  res.json(user);
});

authRouter.post("/logout", (req, res) => {
  const token = readCookie(req);
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(hashToken(token));
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  res.json({ ok: true });
});

authRouter.get("/me", (req, res) => {
  const user = lookup(req);
  if (!user) return res.status(401).json({ error: "Not signed in." });
  res.json(user);
});
