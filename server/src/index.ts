import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import "./db.js"; // ensure tables exist on boot
import { uploadsDir, dataRoot, persistent } from "./paths.js";
import { homebuilderRouter } from "./routes/homebuilder.js";
import { authRouter, requireLogin } from "./auth.js";
import { projectsRouter } from "./routes/projects.js";
import { walkthroughsRouter } from "./routes/walkthroughs.js";
import { itemsRouter } from "./routes/items.js";
import { todayRouter } from "./routes/today.js";

// Loads server/.env if present (Node's built-in loader — no extra
// dependency needed on Node 20.6+/22). Nothing in this module reads env
// vars at import time (only inside request handlers, see
// processing/claude.ts), so it's safe for this to run after the imports
// above. Missing in production is fine — Render/etc set env vars directly
// — so this is best-effort, not required.
try {
  process.loadEnvFile();
} catch {
  // no .env file — normal outside local dev
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

// Render sits behind a proxy; this makes req.protocol report https so the
// photo links pushed to Homebuilder Ops are correct.
app.set("trust proxy", true);

// Uploaded media, served from the data dir (the persistent disk on Render —
// see paths.ts). Deleted per project on close-out.
app.use("/uploads", requireLogin, express.static(uploadsDir));

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, storagePersistent: persistent })
);
// Login/logout are open; every other data route needs a session (auth.ts).
app.use("/api/auth", authRouter);
app.use("/api", requireLogin);
app.use("/api/projects", projectsRouter);
app.use("/api/walkthroughs", walkthroughsRouter);
app.use("/api/items", itemsRouter);
app.use("/api/today", todayRouter);
app.use("/api/homebuilder", homebuilderRouter);

// Serves the built client (client/dist, copied here by `npm run build` at
// the repo root — see scripts/copy-client-dist.mjs and DEPLOY.md) so the
// whole app is ONE deployed URL: no separate hosting for the PWA, no CORS,
// nothing to cross-wire. In local dev this folder doesn't exist (each half
// runs on its own via `npm run dev`), so this is a no-op there — guarded by
// the existsSync check below.
const publicDir = path.join(__dirname, "..", "public");
if (fs.existsSync(path.join(publicDir, "index.html"))) {
  app.use(express.static(publicDir));
  // SPA fallback for client-side routes (/projects/:id/record, etc.) —
  // anything that isn't an API or uploads request gets the app shell, and
  // React Router takes it from there.
  app.get(/^(?!\/api|\/uploads).*/, (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
app.listen(PORT, () => {
  console.log(`punch-list-server listening on http://localhost:${PORT}`);
  console.log(
    persistent
      ? `Data stored on persistent disk at ${dataRoot}`
      : `WARNING: data stored at ${dataRoot}, which is NOT persistent on Render — attach a disk at /var/data (see DEPLOY.md).`
  );
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(
      "ANTHROPIC_API_KEY not set — processing walkthroughs with the placeholder stub. See server/.env.example."
    );
  }
});
