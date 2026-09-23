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

## Data durability — read before relying on this for real job sites

SQLite (`server/data/punchlist.db`) and uploaded photos (`server/uploads/`)
are stored on Render's own disk. On Render's **free tier, that disk is not
persistent** — a redeploy or restart can wipe it. That's fine for testing
this scaffold, but before you're trusting it with real punch lists, this
needs either a paid Render **persistent disk**, or a move to real object
storage — both already noted as open work in the plan doc's "media storage"
question.

## Updating after this deploy

Render can auto-deploy on every push to `main` (toggle in the service
settings), or you redeploy manually from the dashboard. Either way, no
config changes are needed for future pushes — the build command handles
everything.
