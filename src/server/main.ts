import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { sendDueReminders } from "./booking-mail.ts";
import { clockOf, loadConfig } from "./config.ts";
import { SecretBox } from "./crypto.ts";
import { DailyMailWorker } from "./daily-mail.ts";
import { openDb } from "./db.ts";
import type { OAuthClient } from "./google/oauth.ts";
import { parseServiceAccountKey } from "./google/service-account.ts";
import { createMailer } from "./mail.ts";
import { ProvisionWorker } from "./provisioning.ts";
import { SyncService } from "./sync/service.ts";
import { WebhookWorker } from "./webhooks.ts";

const config = loadConfig();
// One clock for the app and its workers; tests may start it at TEST_CLOCK_START.
const now = clockOf(config);
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
  now,
  intervalMs: config.SYNC_INTERVAL_SECONDS * 1000,
  baseUrl: config.BASE_URL,
  refreshMs: config.GRANT_REFRESH_SECONDS * 1000,
  mirrorReconcileMs: config.MIRROR_RECONCILE_SECONDS * 1000,
});
const mailer = createMailer(config.SMTP_URL, config.MAIL_FROM);
const webhooks = new WebhookWorker({
  db,
  box,
  allowPrivate: config.WEBHOOK_ALLOW_PRIVATE,
  retryBaseMs: config.WEBHOOK_RETRY_BASE_MS,
  suspendAfterMs: config.WEBHOOK_SUSPEND_AFTER_SECONDS * 1000,
  mailer,
  baseUrl: config.BASE_URL,
  now,
});
const provisioning = new ProvisionWorker({
  db,
  box,
  sync,
  perMinute: config.PROVISION_PER_MINUTE,
  now,
});
const app = createApp({ db, config, box, oauth, sync, webhooks, mailer, now });
// Meeting emails, the daily digests and the weekly report, checked on the sync interval.
const dailyMail = new DailyMailWorker({
  db,
  mailer,
  now,
  baseUrl: config.BASE_URL,
  intervalMs: config.SYNC_INTERVAL_SECONDS * 1000,
  weeklyReports: config.WEEKLY_REPORTS === "on",
});

const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
  console.log(`tempoloom listening on http://${info.address}:${info.port}`);
});
sync.start();
webhooks.start();
provisioning.start();
dailyMail.start();
// Booking reminders (booking-links.md rule 21): checked every minute.
const reminders = setInterval(() => {
  sendDueReminders(db, mailer, config.BASE_URL, now()).catch((err) =>
    console.error("booking reminders failed", err),
  );
}, 60_000);

// Stop taking requests, let queued calendar writes finish, then exit.
async function shutdown() {
  server.close();
  clearInterval(reminders);
  await provisioning.stop();
  await dailyMail.stop();
  await sync.stop();
  await webhooks.stop();
  db.close();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
