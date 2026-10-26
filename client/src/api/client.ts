// Thin fetch wrapper for the online-only reads/writes (project list, review
// screen, today's digest). Recording itself never touches this file — that
// all goes through src/offline so it works with zero signal.

export interface Project {
  id: string;
  name: string;
  address: string | null;
  created_at: string;
  archived_at: string | null;
  homebuilder_project_id: number | null;
  closed_at: string | null;
  media_deleted_at: string | null;
}

export interface HbProject {
  id: number;
  name: string;
  address: string | null;
  status: string | null;
}

export interface Item {
  id: string;
  walkthrough_id: string;
  project_id: string;
  room: string | null;
  description: string;
  transcript_snippet: string | null;
  trade: string | null;
  commitment_date: string | null;
  status: "open" | "complete";
  completed_at: string | null;
  created_at: string;
  homebuilder_item_id: number | null;
}

export interface Media {
  id: string;
  item_id: string | null;
  walkthrough_id: string;
  kind: "photo" | "video";
  file_path: string;
  captured_at_ms: number;
  confirmed: number;
}

export interface Walkthrough {
  id: string;
  project_id: string;
  status: "recording" | "queued" | "processing" | "review" | "finalized";
  audio_path: string | null;
  transcript: string | null;
  recorded_at: string | null;
  created_at: string;
  finalized_at: string | null;
  items: Item[];
  media: Media[];
  // Whether the server has ANTHROPIC_API_KEY configured — true means items
  // were drafted by the real Claude pass, false means the placeholder stub.
  ai_configured: boolean;
  homebuilder_configured: boolean;
  homebuilder_project_id: number | null;
  pushed_to_homebuilder_ops_at: string | null;
  homebuilder_push_error: string | null;
}

export interface TodaySite {
  projectId: string;
  projectName: string;
  projectAddress: string | null;
  items: Item[];
}

async function json<T>(res: Response): Promise<T> {
  if (res.status === 401) window.dispatchEvent(new Event("pl-signed-out"));
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export interface SessionUser {
  hb_user_id: number;
  username: string;
  display_name: string | null;
  role: string | null;
}

export const api = {
  me: () => fetch("/api/auth/me"),

  login: async (username: string, password: string) => {
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const body = (await r.json().catch(() => null)) as (SessionUser & { error?: string }) | null;
    if (!r.ok) throw new Error(body?.error ?? `${r.status} ${r.statusText}`);
    return body as SessionUser;
  },

  logout: () => fetch("/api/auth/logout", { method: "POST" }),

  listProjects: () => fetch("/api/projects").then((r) => json<Project[]>(r)),

  createProject: (name: string, address?: string) =>
    fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, address }),
    }).then((r) => json<Project>(r)),

  // Permanently deletes the project and everything in it (walkthroughs,
  // items, photos/video). Used to clear out test projects — there's no undo.
  deleteProject: (id: string) =>
    fetch(`/api/projects/${id}`, { method: "DELETE" }).then(
      async (r) => {
        if (!r.ok) {
          const body = (await r.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `${r.status} ${r.statusText}`);
        }
        return r.json() as Promise<{ ok: true }>;
      }
    ),

  listClosedProjects: () =>
    fetch("/api/projects/closed").then((r) => json<Project[]>(r)),

  openItemCount: (id: string) =>
    fetch(`/api/projects/${id}/open-count`).then((r) => json<{ open: number }>(r)),

  // Deletes the project's photos/video/audio from the server, keeps item
  // text, moves the project to "Closed out". No undo.
  closeOutProject: (id: string) =>
    fetch(`/api/projects/${id}/close-out`, { method: "POST" }).then((r) =>
      json<{ ok: true; filesDeleted: number }>(r)
    ),

  homebuilderProjects: () =>
    fetch("/api/homebuilder/projects").then(
      (r) =>
        r.json() as Promise<{ configured: boolean; projects: HbProject[]; error?: string }>
    ),

  linkHomebuilder: (id: string, homebuilderProjectId: number | null) =>
    fetch(`/api/projects/${id}/homebuilder`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ homebuilderProjectId }),
    }).then((r) => json<Project>(r)),

  moveMedia: (walkthroughId: string, mediaId: string, itemId: string | null) =>
    fetch(`/api/walkthroughs/${walkthroughId}/media/${mediaId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId }),
    }).then(async (r) => {
      if (r.status === 401) window.dispatchEvent(new Event("pl-signed-out"));
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `${r.status} ${r.statusText}`);
      }
      return r.json() as Promise<Walkthrough>;
    }),

  pushToHomebuilder: (walkthroughId: string) =>
    fetch(`/api/walkthroughs/${walkthroughId}/push`, { method: "POST" }).then((r) =>
      json<Walkthrough>(r)
    ),

  listWalkthroughs: (projectId: string) =>
    fetch(`/api/walkthroughs?projectId=${projectId}`).then((r) =>
      json<Walkthrough[]>(r)
    ),

  getWalkthrough: (id: string) =>
    fetch(`/api/walkthroughs/${id}`).then((r) => json<Walkthrough>(r)),

  updateItem: (
    id: string,
    fields: Partial<
      Pick<Item, "room" | "description" | "trade" | "commitment_date">
    > & { commitmentDate?: string }
  ) =>
    fetch(`/api/items/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    }).then((r) => json<Item>(r)),

  completeItem: (id: string) =>
    fetch(`/api/items/${id}/complete`, { method: "PATCH" }).then((r) =>
      json<Item>(r)
    ),

  reopenItem: (id: string) =>
    fetch(`/api/items/${id}/reopen`, { method: "PATCH" }).then((r) =>
      json<Item>(r)
    ),

  finalizeWalkthrough: (id: string) =>
    fetch(`/api/walkthroughs/${id}/finalize`, { method: "POST" }).then(
      async (r) => {
        if (!r.ok) {
          const body = (await r.json()) as { error: string };
          throw new Error(body.error);
        }
        return r.json() as Promise<Walkthrough>;
      }
    ),

  today: (date?: string) =>
    fetch(`/api/today${date ? `?date=${date}` : ""}`).then((r) =>
      json<{ asOf: string; sites: TodaySite[] }>(r)
    ),
};
