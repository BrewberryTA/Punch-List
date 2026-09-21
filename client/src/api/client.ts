// Thin fetch wrapper for the online-only reads/writes (project list, review
// screen, today's digest). Recording itself never touches this file — that
// all goes through src/offline so it works with zero signal.

export interface Project {
  id: string;
  name: string;
  address: string | null;
  created_at: string;
  archived_at: string | null;
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
  recorded_at: string | null;
  created_at: string;
  finalized_at: string | null;
  items: Item[];
  media: Media[];
}

export interface TodaySite {
  projectId: string;
  projectName: string;
  projectAddress: string | null;
  items: Item[];
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export const api = {
  listProjects: () => fetch("/api/projects").then((r) => json<Project[]>(r)),

  createProject: (name: string, address?: string) =>
    fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, address }),
    }).then((r) => json<Project>(r)),

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
