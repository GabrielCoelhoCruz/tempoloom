import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { SecretBox } from "./crypto.ts";
import { openDb } from "./db.ts";
import type { OAuthClient } from "./google/oauth.ts";
import { SyncService } from "./sync/service.ts";

const config = loadConfig();
const db = openDb(config.dbPath);
const box = new SecretBox(config.SECRET_KEY);
const oauth: OAuthClient | undefined =
  config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET
    ? {
        clientId: config.GOOGLE_CLIENT_ID,
        clientSecret: config.GOOGLE_CLIENT_SECRET,
        redirectUri: new URL("/auth/google/callback", config.BASE_URL).toString(),
      }
    : undefined;

const sync = new SyncService({ db, box, oauth, intervalMs: config.SYNC_INTERVAL_SECONDS * 1000 });

const app = createApp({
  db,
  config,
  box,
  oauth,
  onLogin: (userId, accountId) => sync.onLogin(userId, accountId),
});

const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
  console.log(`tempoloom listening on http://${info.address}:${info.port}`);
});
sync.start();

function shutdown() {
  sync.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
