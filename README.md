# Punch List App

Hands-free voice-narrated construction site punch lists. Walk the site, talk through
what you see, snap photos/video as you go — the app turns the walkthrough into a
structured, photo-backed to-do list with a required commitment date on every item,
plus a daily follow-up view.

Full product plan: see the "Punch List App: Product Plan" doc in your Claude project
(architecture decisions, data model, open questions log with sourced pricing).

## Status (v1 scaffold — build order step 2 of 6, in progress)

This is a working end-to-end scaffold covering the **record → on-device transcribe →
offline capture → review → commitment dates → daily digest** flow.

What's real and working:
- Create projects, start a walkthrough per project
- Record audio (MediaRecorder) + live camera preview, snap photos and short video
  clips mid-recording without stopping the recording
- Everything is captured to IndexedDB first (offline-first) and synced to the
  server in the background once online — you can start a new walkthrough on a
  different property while an earlier one is still queued
- **Speech-to-text runs on-device, in the browser**, via an open-source Whisper
  model (WebAssembly, `@huggingface/transformers`) — no cloud STT vendor, no
  subscription, fully offline after the model's one-time download. See
  `client/src/transcribe/`.
- **Real AI item-drafting via the Claude API** (`server/src/processing/claude.ts`)
  when `ANTHROPIC_API_KEY` is configured — reads the on-device transcript + photo
  timestamps and drafts structured line items. Falls back to a placeholder stub
  (`server/src/processing/stub.ts`) when no key is set, so the app still runs
  end-to-end without one.
- Review screen: edit room/description/trade, **commitment date required before
  finalizing** (enforced both client- and server-side)
- Daily digest (`/today`) shows open items whose commitment date is today or
  earlier, grouped by project/site
- Mark items complete

What's stubbed / not yet built:
- Server-side media storage lifecycle (delete-on-project/phase-close)
- Homebuilder Ops push on finalize (TODO marked in
  `server/src/routes/walkthroughs.ts`)
- Auth / multi-user (out of scope until "product to sell" question resolves)

Nothing here has been tried yet on an actual phone — the backend is fully tested
(curl-verified end to end), the client typechecks and production-builds clean, but
the recording/camera UI and on-device transcription both need real hardware (mic,
camera, and — for transcription — enough CPU to run a Whisper model) to verify,
which this environment can't do.

## Why on-device transcription instead of a cloud STT API

The original plan used a cloud speech-to-text vendor (AssemblyAI/Deepgram). That
was swapped for an on-device Whisper model running in the browser, specifically so
the app isn't dependent on a fast-moving commercial STT market and doesn't need a
subscription just to transcribe. Trade-off: a heavier client bundle, and a one-time
model download (~70MB) the first time the app runs — after that, transcription
works with zero signal. See the plan doc's Technical Approach section for the full
writeup.

The Claude API is still used, but only for the second half of the pipeline —
turning an already-transcribed script into structured line items — which is text
in, text out, and needs an `ANTHROPIC_API_KEY` (see below).

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
cp .env.example .env   # fill in ANTHROPIC_API_KEY, or leave blank to use the stub
npm run dev             # http://localhost:4000

# terminal 2
cd client
npm install
npm run dev              # http://localhost:5173, proxies /api and /uploads to :4000
```

Open on a phone on the same network (or via a tunnel) to test the camera/mic/
transcription flow — `localhost` in a desktop browser won't have a usable rear
camera, and the on-device model's real-world speed on a phone hasn't been
benchmarked yet.

### Getting an Anthropic API key

`server/.env.example` shows what's needed. Create a key at
https://console.anthropic.com (billing must be enabled on the account). Without
it, `POST /api/walkthroughs/:id/process` falls back to the placeholder stub —
the rest of the app (recording, offline sync, review, commitment dates, daily
digest) works identically either way, so this can be added later without
touching anything else.

### A note on WASM threading

The bundled ONNX runtime (`onnxruntime-web`) ships a SIMD + multi-threaded WASM
build. Multi-threading needs `Cross-Origin-Opener-Policy` /
`Cross-Origin-Embedder-Policy` response headers to actually use
`SharedArrayBuffer`; without them it should fall back to single-threaded
execution automatically, but this hasn't been confirmed on a real phone yet.
If on-device transcription is slower than expected once tested, adding those
two headers on the server (or wherever the client is hosted) is the first
thing to try.

## Note on lockfiles

`package-lock.json` isn't committed (deliberately — they're large and get regenerated
deterministically by `npm install` from `package.json`). Run `npm install` in both
`client/` and `server/` and commit your own lockfiles if you want pinned versions
tracked in git going forward.

## Data model

See `server/src/db.ts` for the SQLite schema: `projects`, `walkthroughs`, `items`,
`media`. Matches the data model in the plan doc.
