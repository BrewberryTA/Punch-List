// Copies the built client (client/dist) into server/public so the Express
// server can serve it as one combined deployment — see DEPLOY.md. Run after
// both `npm run build` in client/ and before `npm run build` in server/
// (order doesn't actually matter between those two, just before the server
// starts). .mjs (not .js) so this works regardless of what "type" the root
// package.json declares.
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const from = path.join(__dirname, "..", "client", "dist");
const to = path.join(__dirname, "..", "server", "public");

if (!existsSync(from)) {
  console.error(
    `client build not found at ${from} — run "npm run build" in client/ first`
  );
  process.exit(1);
}

rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log(`copied ${from} -> ${to}`);
