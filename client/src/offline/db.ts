import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export type LocalWalkthroughStatus =
  | "recording" // still being narrated on-device
  | "ready_to_sync" // recording finished, waiting for network
  | "syncing" // sync in progress
  | "synced" // fully uploaded + processing kicked off
  | "error"; // last sync attempt failed, will retry

export interface LocalWalkthrough {
  id: string; // also used as the server id (offline-first: client mints it)
  projectId: string;
  projectName: string; // denormalized for offline display
  status: LocalWalkthroughStatus;
  audioBlob?: Blob;
  audioUploaded: boolean;
  createdAt: string;
  lastError?: string;
}

export interface LocalMedia {
  id: string;
  walkthroughId: string;
  kind: "photo" | "video";
  blob: Blob;
  capturedAtMs: number;
  uploaded: boolean;
  createdAt: string;
}

interface PunchListDB extends DBSchema {
  walkthroughs: {
    key: string;
    value: LocalWalkthrough;
    indexes: { "by-status": LocalWalkthroughStatus };
  };
  media: {
    key: string;
    value: LocalMedia;
    indexes: { "by-walkthrough": string };
  };
}

let dbPromise: Promise<IDBPDatabase<PunchListDB>> | undefined;

export function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<PunchListDB>("punch-list", 1, {
      upgrade(db) {
        const walkthroughs = db.createObjectStore("walkthroughs", {
          keyPath: "id",
        });
        walkthroughs.createIndex("by-status", "status");

        const media = db.createObjectStore("media", { keyPath: "id" });
        media.createIndex("by-walkthrough", "walkthroughId");
      },
    });
  }
  return dbPromise;
}
