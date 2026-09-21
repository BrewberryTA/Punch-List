# Punch List App

Hands-free voice-narrated construction site punch lists. Walk the site, talk through
what you see, snap photos/video as you go — the app turns the walkthrough into a
structured, photo-backed to-do list with a required commitment date on every item,
plus a daily follow-up view.

Full product plan: see the "Punch List App: Product Plan" doc in your Claude project
(architecture decisions, data model, open questions log with sourced pricing).

## Status (v1 scaffold — build order step 1 of 6)

This is a working end-to-end scaffold covering the **record → offline capture →
review → commitment dates → daily digest** flow, with the AI transcription step
**stubbed** (see `server/src/processing/stub.ts` for exactly what's mocked and
what to swap in). Nothing here has been tried yet on an actual phone — the backend
is fully tested (see below), the client typechecks and builds clean, but the
recording/camera UI needs real hardware (mic + camera) to verify, which this
environment can't do.

What's real and working:
- Create projects, start a walkthrough per project
- Record audio (MediaRecorder) + live camera preview, snap photos and short video
  clips mid-recording without stopping the recording
- Everything is captured to IndexedDB first (offline-first) and synced to the
  server in the background once online — you can start a new walkthrough on a
  different property while an earlier one is still queued
- Stubbed AI drafting turns captured photos into placeholder line items
- Review screen: edit room/description/trade, **commitment date required before
  finalizing** (enforced both client- and server-side)
- Daily digest (`/today`) shows open items whose commitment date is today or
  earlier, grouped by project/site
- Mark items complete

What's stubbed / not yet built:
- Real transcription + AI item-drafting (see the TODO block in
  `server/src/processing/stub.ts` — swap in AssemblyAI/Deepgram + Claude)
- Server-side media storage lifecycle (delete-on-project/phase-close)
- Homebuilder Ops push on finalize (TODO marked in
  `server/src/routes/walkthroughs.ts`)
- Auth / multi-user (out of scope until "product to sell" question resolves)

## Structure

```
client/   React + TypeScript + Vite, installable PWA
server/   Node + TypeScript + Express + SQLite (better-sqlite3)
```

## Running locally

```bash
# terminal 1
cd server
npm install
npm run dev        # http://localhost:4000

# terminal 2
cd client
npm install
npm run dev         # http://localhost:5173, proxies /api and /uploads to :4000
```

Open on a phone on the same network (or via a tunnel) to test the camera/mic flow —
`localhost` in a desktop browser won't have a usable rear camera.

## Note on lockfiles

`package-lock.json` isn't committed (deliberately — they're large and get regenerated
deterministically by `npm install` from `package.json`). Run `npm install` in both
`client/` and `server/` and commit your own lockfiles if you want pinned versions
tracked in git going forward.

## Data model

See `server/src/db.ts` for the SQLite schema: `projects`, `walkthroughs`, `items`,
`media`. Matches the data model in the plan doc.
