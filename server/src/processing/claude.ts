/**
 * Real AI drafting pass — the second half of the pipeline described in the
 * plan doc. By the time this runs, transcription has already happened
 * on-device in the browser (see client/src/transcribe/whisper.ts); this
 * step only reads that transcript plus the media list and asks Claude to
 * turn it into structured punch-list items, matching each item to the
 * media captured nearest the relevant piece of speech.
 *
 * Requires ANTHROPIC_API_KEY to be set (see server/.env.example). If it's
 * not set, routes/walkthroughs.ts falls back to processing/stub.ts instead
 * of calling this — the app still runs end-to-end without a key, just with
 * placeholder items.
 */
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { db } from "../db.js";

const MODEL = "claude-sonnet-5";

let client: Anthropic | null = null;
function getClient() {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set");
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

interface MediaRow {
  id: string;
  kind: string;
  captured_at_ms: number;
}

interface DraftedItem {
  room: string | null;
  description: string;
  transcript_snippet: string | null;
  media_id: string | null;
}

const DRAFT_TOOL_NAME = "draft_punch_list_items";

async function draftItemsWithClaude(
  transcript: string,
  media: MediaRow[]
): Promise<DraftedItem[]> {
  const anthropic = getClient();

  const mediaList = media
    .map((m) => `- ${m.id} (${m.kind}, captured at ${m.captured_at_ms}ms into the recording)`)
    .join("\n") || "(no photos or video captured during this walkthrough)";

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system:
      "You turn a construction-site walkthrough transcript into a structured punch list. " +
      "The person narrated what they saw while walking the site and captured photos/video at " +
      "specific moments. Split the transcript into distinct, actionable to-do items — one per " +
      "issue or task mentioned. For each item: infer the room/area if it's stated or clearly " +
      "implied, write a clear description of what needs to be done, include the relevant " +
      "transcript snippet, and pick the media id whose timestamp falls closest after (or during) " +
      "the speech describing that item — or null if nothing was captured for it. Do not invent " +
      "work that wasn't mentioned. If the transcript is empty or has no actionable content, " +
      "return an empty items array.",
    tools: [
      {
        name: DRAFT_TOOL_NAME,
        description: "Return the structured punch-list items drafted from the walkthrough.",
        input_schema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  room: { type: ["string", "null"], description: "Room or area, if known" },
                  description: { type: "string", description: "The to-do item, clearly stated" },
                  transcript_snippet: {
                    type: ["string", "null"],
                    description: "The exact transcript text this item was drafted from",
                  },
                  media_id: {
                    type: ["string", "null"],
                    description: "id from the media list this item's photo/video belongs to, or null",
                  },
                },
                required: ["description"],
              },
            },
          },
          required: ["items"],
        },
      },
    ],
    tool_choice: { type: "tool", name: DRAFT_TOOL_NAME },
    messages: [
      {
        role: "user",
        content:
          `Transcript:\n"""\n${transcript || "(empty — no speech was transcribed)"}\n"""\n\n` +
          `Media captured during this walkthrough:\n${mediaList}`,
      },
    ],
  });

  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolUse) {
    throw new Error("Claude did not return structured items");
  }
  const parsed = toolUse.input as { items?: DraftedItem[] };
  return parsed.items ?? [];
}

export async function processWalkthroughWithClaude(walkthroughId: string) {
  const walkthrough = db
    .prepare("SELECT * FROM walkthroughs WHERE id = ?")
    .get(walkthroughId) as
    | { id: string; project_id: string; transcript: string | null }
    | undefined;

  if (!walkthrough) {
    throw new Error("walkthrough not found");
  }

  const media = db
    .prepare(
      "SELECT * FROM media WHERE walkthrough_id = ? ORDER BY captured_at_ms ASC"
    )
    .all(walkthroughId) as MediaRow[];

  const drafted = await draftItemsWithClaude(walkthrough.transcript ?? "", media);

  const insertItem = db.prepare(`
    INSERT INTO items (id, walkthrough_id, project_id, room, description, transcript_snippet, status, created_at)
    VALUES (@id, @walkthrough_id, @project_id, @room, @description, @transcript_snippet, 'open', datetime('now'))
  `);
  const linkMedia = db.prepare("UPDATE media SET item_id = ? WHERE id = ?");
  const validMediaIds = new Set(media.map((m) => m.id));

  const createdItemIds: string[] = [];

  const insertMany = db.transaction((items: DraftedItem[]) => {
    for (const item of items) {
      if (!item.description || !item.description.trim()) continue;
      const itemId = randomUUID();
      insertItem.run({
        id: itemId,
        walkthrough_id: walkthroughId,
        project_id: walkthrough.project_id,
        room: item.room ?? null,
        description: item.description.trim(),
        transcript_snippet: item.transcript_snippet ?? null,
      });
      if (item.media_id && validMediaIds.has(item.media_id)) {
        linkMedia.run(itemId, item.media_id);
      }
      createdItemIds.push(itemId);
    }

    // Claude found nothing actionable (or every drafted item was blank) —
    // still leave something on the review screen rather than an empty list.
    if (createdItemIds.length === 0) {
      const itemId = randomUUID();
      insertItem.run({
        id: itemId,
        walkthrough_id: walkthroughId,
        project_id: walkthrough.project_id,
        room: null,
        description:
          "No actionable items were drafted from this walkthrough's transcript — add one manually if needed.",
        transcript_snippet: null,
      });
      createdItemIds.push(itemId);
    }

    db.prepare("UPDATE walkthroughs SET status = 'review' WHERE id = ?").run(
      walkthroughId
    );
  });

  insertMany(drafted);

  return { itemIds: createdItemIds };
}
