import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type HbProject, type Project } from "../api/client";

export function ProjectsPage({ onLogout }: { onLogout: () => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closed, setClosed] = useState<Project[]>([]);
  const [showClosed, setShowClosed] = useState(false);
  // Homebuilder Ops link: null = still loading / not reachable
  const [hb, setHb] = useState<{ configured: boolean; projects: HbProject[]; error?: string } | null>(null);

  const [offline, setOffline] = useState(false);

  useEffect(() => {
    // The list is saved on the phone every time it loads, so opening the app
    // in a dead zone still shows your projects and lets you start a
    // walkthrough (recording itself is fully offline — see src/offline).
    api
      .listProjects()
      .then((list) => {
        setProjects(list);
        setOffline(false);
        saveCachedProjects(list);
      })
      .catch((e) => {
        const cached = loadCachedProjects();
        if (cached) {
          setProjects(cached);
          setOffline(true);
        } else {
          setError(`No connection, and this phone hasn't saved your project list yet. Open the app once with signal. (${String(e)})`);
        }
      });
    api.listClosedProjects().then(setClosed).catch(() => {});
    api
      .homebuilderProjects()
      .then(setHb)
      .catch((e) => setHb({ configured: true, projects: [], error: String(e) }));
  }, []);

  async function linkHomebuilder(project: Project, value: string) {
    setError(null);
    try {
      const updated = await api.linkHomebuilder(project.id, value ? Number(value) : null);
      setProjects((prev) => prev?.map((p) => (p.id === updated.id ? updated : p)) ?? prev);
    } catch (e) {
      setError(String(e));
    }
  }

  async function closeOut(project: Project) {
    setError(null);
    let openNote = "";
    try {
      const { open } = await api.openItemCount(project.id);
      if (open > 0) openNote = `\n\nHeads up: ${open} item(s) are still open. Their text stays, but their photos go.`;
    } catch {
      // count is just a courtesy warning
    }
    const confirmed = window.confirm(
      `Close out "${project.name}"?\n\nThis deletes all of its photos, video and audio from the server. Item text, dates and trades are kept as the record. Photo links already sent to Homebuilder Ops will stop working. This can't be undone.${openNote}`
    );
    if (!confirmed) return;
    setClosingId(project.id);
    try {
      await api.closeOutProject(project.id);
      setProjects((prev) => prev?.filter((p) => p.id !== project.id) ?? prev);
      setClosed((prev) => [{ ...project, closed_at: new Date().toISOString() }, ...prev]);
    } catch (e) {
      setError(String(e));
    } finally {
      setClosingId(null);
    }
  }

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const project = await api.createProject(name.trim(), address.trim() || undefined);
      setProjects((prev) => {
        const next = prev ? [project, ...prev] : [project];
        saveCachedProjects(next);
        return next;
      });
      setName("");
      setAddress("");
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  async function deleteProject(project: Project) {
    const confirmed = window.confirm(
      `Delete "${project.name}"? This permanently removes it and everything in it — walkthroughs, photos, items. This can't be undone.`
    );
    if (!confirmed) return;
    setDeletingId(project.id);
    setError(null);
    try {
      await api.deleteProject(project.id);
      setProjects((prev) => prev?.filter((p) => p.id !== project.id) ?? prev);
    } catch (e) {
      setError(String(e));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Punch List</h1>
        <div className="list-row-actions">
          <Link className="link-button" to="/today">
            Today
          </Link>
          <button type="button" className="secondary small" onClick={onLogout}>
            Log out
          </button>
        </div>
      </header>

      {offline && (
        <div className="card">
          <p>
            <strong>No signal</strong> — showing the project list saved on this phone. You can
            start a walkthrough; it uploads once you're back in service. New projects need a
            connection.
          </p>
        </div>
      )}

      <form className="card" onSubmit={createProject}>
        <h2>New project</h2>
        <input
          placeholder="Project name (e.g. Stamper House)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          placeholder="Address (optional)"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <button type="submit" disabled={creating || !name.trim()}>
          {creating ? "Creating…" : "Create project"}
        </button>
        {error && <p className="error">{error}</p>}
      </form>

      <h2>Your projects</h2>
      {projects === null && <p>Loading…</p>}
      {projects?.length === 0 && <p>No projects yet — create one above.</p>}
      <ul className="list">
        {projects?.map((p) => (
          <li key={p.id} className="list-row">
            <div>
              <strong>{p.name}</strong>
              {p.address && <div className="muted">{p.address}</div>}
              {hb?.configured && (
                <label className="hb-link">
                  <span className="muted">Sends to Homebuilder Ops:</span>
                  <select
                    value={p.homebuilder_project_id ?? ""}
                    disabled={!!hb.error && !p.homebuilder_project_id}
                    onChange={(e) => void linkHomebuilder(p, e.target.value)}
                  >
                    <option value="">— not linked —</option>
                    {hb.projects.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name}
                      </option>
                    ))}
                    {p.homebuilder_project_id &&
                      !hb.projects.some((h) => h.id === p.homebuilder_project_id) && (
                        <option value={p.homebuilder_project_id}>
                          Project #{p.homebuilder_project_id}
                        </option>
                      )}
                  </select>
                  {hb.error && <span className="muted">Couldn't reach Homebuilder Ops right now.</span>}
                </label>
              )}
            </div>
            <div className="list-row-actions">
              <Link className="link-button" to={`/projects/${p.id}/record`}>
                Start walkthrough
              </Link>
              <button
                type="button"
                className="secondary small"
                disabled={closingId === p.id}
                onClick={() => void closeOut(p)}
              >
                {closingId === p.id ? "Closing…" : "Close out"}
              </button>
              <button
                type="button"
                className="danger small"
                disabled={deletingId === p.id}
                onClick={() => deleteProject(p)}
              >
                {deletingId === p.id ? "Deleting…" : "Delete"}
              </button>
            </div>
          </li>
        ))}
      </ul>

      {closed.length > 0 && (
        <>
          <button
            type="button"
            className="secondary small"
            onClick={() => setShowClosed((v) => !v)}
          >
            {showClosed ? "Hide" : "Show"} closed-out projects ({closed.length})
          </button>
          {showClosed && (
            <ul className="list">
              {closed.map((p) => (
                <li key={p.id} className="list-row">
                  <div>
                    <strong>{p.name}</strong>
                    <div className="muted">
                      Closed out {p.closed_at?.slice(0, 10)} · photos/video deleted
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <p className="build-stamp">Axxo LLC · Punch List · build {__BUILD_STAMP__}</p>
    </div>
  );
}

const CACHE_KEY = "punchlist.projects.v1";

function saveCachedProjects(list: Project[]) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(list));
  } catch {
    // storage full or blocked — offline list just won't be available
  }
}

function loadCachedProjects(): Project[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Project[]) : null;
  } catch {
    return null;
  }
}
