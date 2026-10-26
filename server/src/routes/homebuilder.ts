import { Router } from "express";
import { homebuilderConfigured, listHomebuilderProjects } from "../homebuilder.js";

export const homebuilderRouter = Router();

// Whether the push to Homebuilder Ops is switched on, and if so the open
// Homebuilder Ops projects a punch-list project can be linked to.
homebuilderRouter.get("/projects", async (_req, res) => {
  if (!homebuilderConfigured()) return res.json({ configured: false, projects: [] });
  try {
    res.json({ configured: true, projects: await listHomebuilderProjects() });
  } catch (e) {
    res.status(502).json({
      configured: true,
      projects: [],
      error: e instanceof Error ? e.message : String(e),
    });
  }
});
