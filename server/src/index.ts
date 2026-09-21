import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./db.js"; // ensure tables exist on boot
import { projectsRouter } from "./routes/projects.js";
import { walkthroughsRouter } from "./routes/walkthroughs.js";
import { itemsRouter } from "./routes/items.js";
import { todayRouter } from "./routes/today.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

// Dev-only: serve uploaded media directly. In production this should move
// to object storage (see plan doc — server-side storage with a delete
// option per project/phase).
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/projects", projectsRouter);
app.use("/api/walkthroughs", walkthroughsRouter);
app.use("/api/items", itemsRouter);
app.use("/api/today", todayRouter);

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
app.listen(PORT, () => {
  console.log(`punch-list-server listening on http://localhost:${PORT}`);
});
