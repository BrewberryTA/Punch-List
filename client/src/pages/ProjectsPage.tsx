import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Project } from "../api/client";

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listProjects()
      .then(setProjects)
      .catch((e) => setError(String(e)));
  }, []);

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const project = await api.createProject(name.trim(), address.trim() || undefined);
      setProjects((prev) => (prev ? [project, ...prev] : [project]));
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
        <Link className="link-button" to="/today">
          Today
        </Link>
      </header>

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
            </div>
            <div className="list-row-actions">
              <Link className="link-button" to={`/projects/${p.id}/record`}>
                Start walkthrough
              </Link>
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
    </div>
  );
}
