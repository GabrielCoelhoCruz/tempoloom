import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { SecretBox } from "./crypto.ts";
import { openDb } from "./db.ts";
import type { OAuthClient } from "./google/oauth.ts";
import { parseServiceAccountKey } from "./google/service-account.ts";
import { SyncService } from "./sync/service.ts";
import { WebhookWorker } from "./webhooks.ts";

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
const serviceKey = config.GOOGLE_SERVICE_ACCOUNT_JSON
  ? parseServiceAccountKey(config.GOOGLE_SERVICE_ACCOUNT_JSON)
  : undefined;

const sync = new SyncService({
  db,
  box,
  oauth,
  serviceKey,
  now: Date.now,
  intervalMs: config.SYNC_INTERVAL_SECONDS * 1000,
  baseUrl: config.BASE_URL,
});
const webhooks = new WebhookWorker({
  db,
  box,
  allowPrivate: config.WEBHOOK_ALLOW_PRIVATE,
  retryBaseMs: config.WEBHOOK_RETRY_BASE_MS,
  now: Date.now,
});
const app = createApp({ db, config, box, oauth, sync, webhooks });

const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
  console.log(`tempoloom listening on http://${info.address}:${info.port}`);
});
sync.start();
webhooks.start();

// Stop taking requests, let queued calendar writes finish, then exit.
async function shutdown() {
  server.close();
  await sync.stop();
  await webhooks.stop();
  db.close();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
