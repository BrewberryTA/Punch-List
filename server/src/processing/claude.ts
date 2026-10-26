/**
 * Real AI drafting pass — the second half of the pipeline. By the time this
 * runs, transcription has already happened on the phone (see
 * client/src/transcribe/whisper.ts). This step turns that transcript plus
 * the photos/clips into structured punch-list items and decides which
 * photo belongs to which item.
 *
 * How photos get matched (the part that used to go wrong):
 *  1. TIMELINE — the phone uploads the transcript as timestamped segments
 *     (ms from the start of the recording), and every photo/clip carries a
 *     timestamp on the same clock. We interleave them into one timeline, so
 *     Claude sees exactly what was being said when each shot was taken.
 *  2. LOOKING — each photo is also sent as a small image, so Claude can
 *     check the match (a "caulk the tub" item shouldn't get a photo of an
 *     outlet) and correct it.
 * Walkthroughs uploaded before timestamps existed fall back to the plain
 * transcript + photo times.
 *
 * Requires ANTHROPIC_API_KEY. Without it, routes/walkthroughs.ts uses
 * processing/stub.ts instead.
 */
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { db } from "../db.js";
import { uploadsDir } from "../paths.js";

const MODEL = "claude-sonnet-5";
// Photos are shrunk to this long edge before Claude sees them: plenty to
// tell a tub from an outlet, ~300 image tokens each (≈$0.0006 per photo).
const PHOTO_LONG_EDGE = 640;

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
  file_path: string;
  captured_at_ms: number;
}

interface Chunk {
  text: string;
  start: number;
  end: number;
}

interface DraftedItem {
  room: string | null;
  description: string;
  transcript_snippet: string | null;
  photos: string[];
}

const DRAFT_TOOL_NAME = "draft_punch_list_items";

function clock(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Short labels (P1, P2… / V1, V2…) are what Claude sees and returns; we map
// them back to real ids, so a typo can't attach the wrong file.
function labelMedia(media: MediaRow[]) {
  let p = 0;
  let v = 0;
  return media.map((m) => ({
    ...m,
    label: m.kind === "video" ? `V${++v}` : `P${++p}`,
  }));
}

function buildTimeline(chunks: Chunk[], media: (MediaRow & { label: string })[]) {
  const events: { at: number; order: number; line: string }[] = [];
  for (const c of chunks) {
    const text = c.text.trim();
    if (text) events.push({ at: c.start, order: 0, line: `[${clock(c.start)}] SAID: ${text}` });
  }
  for (const m of media) {
    events.push({
      at: m.captured_at_ms,
      order: 1,
      line: `[${clock(m.captured_at_ms)}] >>> ${m.kind === "video" ? "VIDEO CLIP" : "PHOTO"} ${m.label} taken`,
    });
  }
  events.sort((a, b) => a.at - b.at || a.order - b.order);
  return events.map((e) => e.line).join("\n");
}

async function photoBlock(m: MediaRow): Promise<Anthropic.ImageBlockParam | null> {
  const file = path.join(uploadsDir, path.basename(m.file_path));
  if (!fs.existsSync(file)) return null;
  try {
    const buf = await sharp(file)
      .rotate()
      .resize({ width: PHOTO_LONG_EDGE, height: PHOTO_LONG_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
    return {
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") },
    };
  } catch {
    return null; // unreadable image — Claude still has its timestamp
  }
}

const SYSTEM =
  "You turn a construction-site walkthrough into a structured punch list. The person walked " +
  "the site narrating what they saw and took photos (and sometimes short video clips) along " +
  "the way.\n\n" +
  "ITEMS: Split the narration into distinct, actionable items — one per issue or task. For " +
  "each: the room/area if stated or clearly implied, a clear description of what needs doing, " +
  "and the transcript snippet it came from. Do not invent work that wasn't mentioned. If there " +
  "is nothing actionable, return an empty items array.\n\n" +
  "PHOTOS — getting these right matters most:\n" +
  "- You get a TIMELINE interleaving what was said with when each photo/clip was taken " +
  "(P1, P2… for photos, V1, V2… for clips), and then each photo itself.\n" +
  "- People usually take the photo while describing the issue or right before/after — so a " +
  "photo belongs to the item being talked about at or around that moment. Look at the speech " +
  "both just before AND just after each photo.\n" +
  "- Then LOOK at the photo and check it actually shows that item (e.g. an outlet, a tub, a " +
  "baseboard). If the image clearly fits a different item from the same stretch of the " +
  "walkthrough better, assign it there instead.\n" +
  "- One photo goes to at most one item; an item can have several photos. If a photo doesn't " +
  "clearly fit any item, leave it unassigned rather than guessing.\n" +
  "- Video clips can't be viewed — place them by timing alone.\n\n" +
  "MIS-HEARINGS: The transcript comes from a small on-phone speech model on noisy job sites, " +
  "so it often mis-hears construction terms. In the room and description you write, silently " +
  "fix words that are clearly mis-heard trade vocabulary when the intended term is obvious " +
  "from context (and the photo can help) — e.g. 'dry wall' → drywall, 'pee trap' → P-trap, " +
  "'j channel' → J-channel, 'soffet' → soffit, 'base board' → baseboard, 'g f c i' → GFCI, " +
  "'caulk' misheard as other words, 'jamb', 'shim', 'reveal', 'escutcheon', 'knock down' " +
  "texture, 'hose bib', 'flashing'. Normalise room names ('master bath', 'powder room', " +
  "'great room'). Keep transcript_snippet exactly as transcribed. If a word is garbled and " +
  "the meaning is NOT clear, keep it and add '(unclear)' rather than guessing.";

async function draftItemsWithClaude(
  transcript: string,
  chunks: Chunk[] | null,
  media: MediaRow[]
): Promise<{ items: DraftedItem[]; labelToId: Map<string, string> }> {
  const anthropic = getClient();
  const labeled = labelMedia(media);
  const labelToId = new Map(labeled.map((m) => [m.label, m.id]));

  const intro =
    chunks && chunks.length
      ? `TIMELINE (minutes:seconds from the start of the recording):\n${buildTimeline(chunks, labeled)}`
      : // older uploads: no timestamps on the speech, only on the photos
        `TRANSCRIPT (no timing available):\n"""\n${transcript || "(empty — no speech was transcribed)"}\n"""\n\n` +
        `PHOTOS/CLIPS, with when they were taken:\n` +
        (labeled.map((m) => `- ${m.label} (${m.kind}) at ${clock(m.captured_at_ms)}`).join("\n") ||
          "(none)");

  const content: Anthropic.ContentBlockParam[] = [{ type: "text", text: intro }];
  const photos = labeled.filter((m) => m.kind === "photo");
  if (photos.length) {
    content.push({ type: "text", text: "\nTHE PHOTOS:" });
    for (const m of photos) {
      const img = await photoBlock(m);
      content.push({
        type: "text",
        text: `${m.label} — taken at ${clock(m.captured_at_ms)}${img ? ":" : " (image unavailable)"}`,
      });
      if (img) content.push(img);
    }
  }

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system: SYSTEM,
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
                  photos: {
                    type: "array",
                    items: { type: "string" },
                    description: "Labels (P1, V2…) of the photos/clips that belong to this item; empty if none",
                  },
                },
                required: ["description", "photos"],
              },
            },
          },
          required: ["items"],
        },
      },
    ],
    tool_choice: { type: "tool", name: DRAFT_TOOL_NAME },
    messages: [{ role: "user", content }],
  });

  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolUse) {
    throw new Error("Claude did not return structured items");
  }
  const parsed = toolUse.input as { items?: DraftedItem[] };
  return { items: parsed.items ?? [], labelToId };
}

export async function processWalkthroughWithClaude(walkthroughId: string) {
  const walkthrough = db
    .prepare("SELECT * FROM walkthroughs WHERE id = ?")
    .get(walkthroughId) as
    | {
        id: string;
        project_id: string;
        transcript: string | null;
        transcript_chunks: string | null;
      }
    | undefined;

  if (!walkthrough) {
    throw new Error("walkthrough not found");
  }

  const media = db
    .prepare("SELECT * FROM media WHERE walkthrough_id = ? ORDER BY captured_at_ms ASC")
    .all(walkthroughId) as MediaRow[];

  let chunks: Chunk[] | null = null;
  try {
    chunks = walkthrough.transcript_chunks ? (JSON.parse(walkthrough.transcript_chunks) as Chunk[]) : null;
  } catch {
    chunks = null;
  }

  const { items: drafted, labelToId } = await draftItemsWithClaude(
    walkthrough.transcript ?? "",
    chunks,
    media
  );

  const insertItem = db.prepare(`
    INSERT INTO items (id, walkthrough_id, project_id, room, description, transcript_snippet, status, created_at)
    VALUES (@id, @walkthrough_id, @project_id, @room, @description, @transcript_snippet, 'open', datetime('now'))
  `);
  const linkMedia = db.prepare("UPDATE media SET item_id = ? WHERE id = ? AND item_id IS NULL");

  const createdItemIds: string[] = [];

  const insertMany = db.transaction((items: DraftedItem[]) => {
    // Re-processing starts clean: unlink photos from any earlier draft.
    db.prepare("UPDATE media SET item_id = NULL WHERE walkthrough_id = ?").run(walkthroughId);

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
      for (const label of item.photos ?? []) {
        const mediaId = labelToId.get(String(label).trim().toUpperCase());
        // "AND item_id IS NULL": a photo Claude listed twice stays with the first item
        if (mediaId) linkMedia.run(itemId, mediaId);
      }
      createdItemIds.push(itemId);
    }

    // Claude found nothing actionable — still leave something on the review
    // screen rather than an empty list.
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

    db.prepare("UPDATE walkthroughs SET status = 'review' WHERE id = ?").run(walkthroughId);
  });

  insertMany(drafted);

  return { itemIds: createdItemIds };
}
