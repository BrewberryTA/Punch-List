/**
 * STUBBED AI processing step.
 *
 * Real pipeline (per the plan doc): send the full audio to a speech-to-text
 * provider (AssemblyAI or Deepgram), then send the transcript + each photo's
 * captured_at_ms to Claude with a prompt that drafts structured line items,
 * matching each item to its nearest preceding piece of speech.
 *
 * This stub skips transcription entirely and instead drafts one placeholder
 * item per photo/video captured during the walkthrough, in recording order,
 * so the record -> review -> commit -> follow-up flow can be built and
 * tested end-to-end before real API keys are wired in.
 *
 * TODO(real pipeline):
 *  1. Transcribe walkthrough.audio_path (AssemblyAI or Deepgram).
 *  2. Call Claude with the transcript + media list (id, captured_at_ms) and
 *     ask it to return { room, description, transcript_snippet, media_id }
 *     per item, choosing the media item whose captured_at_ms falls right
 *     after the relevant piece of speech.
 *  3. Replace the loop below with that result.
 */
import { randomUUID } from "node:crypto";
import { db } from "../db.js";

export function processWalkthroughStub(walkthroughId: string) {
  const walkthrough = db
    .prepare("SELECT * FROM walkthroughs WHERE id = ?")
    .get(walkthroughId) as { id: string; project_id: string } | undefined;

  if (!walkthrough) {
    throw new Error("walkthrough not found");
  }

  const media = db
    .prepare(
      "SELECT * FROM media WHERE walkthrough_id = ? ORDER BY captured_at_ms ASC"
    )
    .all(walkthroughId) as {
    id: string;
    kind: string;
    captured_at_ms: number;
  }[];

  const insertItem = db.prepare(`
    INSERT INTO items (id, walkthrough_id, project_id, room, description, transcript_snippet, status, created_at)
    VALUES (@id, @walkthrough_id, @project_id, @room, @description, @transcript_snippet, 'open', datetime('now'))
  `);
  const linkMedia = db.prepare("UPDATE media SET item_id = ? WHERE id = ?");

  const createdItemIds: string[] = [];

  const insertMany = db.transaction((mediaRows: typeof media) => {
    mediaRows.forEach((m, i) => {
      const itemId = randomUUID();
      insertItem.run({
        id: itemId,
        walkthrough_id: walkthroughId,
        project_id: walkthrough.project_id,
        room: null,
        description: `[STUB] Item ${i + 1} — describe what's happening at this ${m.kind} (real transcription not wired up yet)`,
        transcript_snippet: null,
      });
      linkMedia.run(itemId, m.id);
      createdItemIds.push(itemId);
    });

    // If the walkthrough has narration but no photos yet were attached, still
    // leave at least one blank item so the review screen has something to show.
    if (mediaRows.length === 0) {
      const itemId = randomUUID();
      insertItem.run({
        id: itemId,
        walkthrough_id: walkthroughId,
        project_id: walkthrough.project_id,
        room: null,
        description: "[STUB] No photos were attached to this walkthrough — add one or edit this item directly.",
        transcript_snippet: null,
      });
      createdItemIds.push(itemId);
    }

    db.prepare(
      "UPDATE walkthroughs SET status = 'review' WHERE id = ?"
    ).run(walkthroughId);
  });

  insertMany(media);

  return { itemIds: createdItemIds };
}
