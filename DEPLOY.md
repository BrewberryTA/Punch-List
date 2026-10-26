# Deploying so you can use this on your phone

Your phone can only run the client (the installable web app part) — the
server (database, file storage, the Claude drafting pass) has to run
somewhere reachable over the internet. `server/.env` is a **local-testing
file only**; it's gitignored and never reaches a real deployment, so it's
not the answer for phone use.

The whole app deploys as **one URL** — the server serves the built client
directly (see `server/src/index.ts` and `scripts/copy-client-dist.mjs`), so
there's nothing to cross-wire and no separate "API address" to configure.

## Render (same host as Homebuilder Ops)

1. Render dashboard → **New** → **Web Service** → connect the
   `BrewberryTA/Punch-List` GitHub repo.
2. Settings:
   - **Root Directory:** leave blank (repo root)
   - **Runtime:** Node
   - **Build Command:** `npm run build`
   - **Start Command:** `npm start`
3. **Environment** tab on that service → add a variable:
   - `ANTHROPIC_API_KEY` = your key from https://console.anthropic.com
     (billing must be enabled on that account)

   This is the actual replacement for the local `.env` file — Render reads
   this from its own dashboard, not from any file in the repo.
4. Deploy. Render gives you a URL like `https://punch-list-xxxx.onrender.com`.
5. On your phone, open that URL in Safari (iPhone) or Chrome (Android), then:
   - **iPhone:** Share button → "Add to Home Screen"
   - **Android:** Chrome menu → "Install app" (or it may prompt automatically)

   That's what turns it into an app icon instead of a browser tab.

## Data durability — attach a disk

Render wipes a service's own files on every redeploy, restart or spin-down.
Only files on an attached **persistent disk** survive. The app stores its
database and photos on the disk automatically when one is mounted at
`/var/data` (see `server/src/paths.ts`) — no env var needed.

1. The service must be on a paid compute plan (`0.5c-512mb`, $7/mo — the
   free plan can't have a disk).
2. Service → **Disk** → mount path **`/var/data`** → smallest size (1 GB is
   plenty to start; it can grow later but never shrink) → **Add disk**.
3. Check: `https://<your-url>/api/health` should say
   `"storagePersistent": true`.

## Homebuilder Ops push

Finalized lists push onto the linked project's punch list in Homebuilder Ops.
Both services need the same secret:

- **Homebuilder Ops** service → Environment → `PUNCHLIST_INTEGRATION_KEY`
- **Punch-List** service → Environment → `HOMEBUILDER_OPS_KEY` (same value)

Optional: `HOMEBUILDER_OPS_URL` if Homebuilder Ops ever moves off
`https://homebuilder-app.onrender.com`. Then, on the Projects screen, pick
which Homebuilder Ops project each punch-list project sends to. Pushes are
one-way: checking an item off in one app doesn't check it off in the other.

## Logins

The app uses the same usernames and passwords as Homebuilder Ops. Punch List
never stores passwords: it asks Homebuilder Ops to check them (same shared
key as above), then keeps its own 90-day session on the phone. Anyone with a
Homebuilder Ops account can log in and sees all projects. Logging in needs
signal once; after that the app opens and records offline.

## Close out a project

Projects screen → **Close out**: deletes that project's photos, video and
audio from the server, keeps item text/dates/trades, and moves it to
"closed-out projects". Photo links already pushed to Homebuilder Ops stop
working at that point.

## Updating after this deploy

Render can auto-deploy on every push to `main` (toggle in the service
settings), or you redeploy manually from the dashboard. Either way, no
config changes are needed for future pushes — the build command handles
everything.
