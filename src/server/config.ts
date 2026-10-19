import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default("127.0.0.1"),
  /** Public origin of this server, used for OAuth redirects and booking links. */
  BASE_URL: z.url().default("http://localhost:8787"),
  DATA_DIR: z.string().default("./data"),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  /** JSON key of a Google service account (operator-connected calendars). */
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().min(1).optional(),
  /** 32 random bytes, base64. Encrypts OAuth tokens at rest. */
  SECRET_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "SECRET_KEY must be 32 bytes, base64"),
  /** Seconds between calendar polls for each connected account. */
  SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(30),
  /** Allow webhook URLs on http, localhost and private addresses (self-hosted receivers). */
  WEBHOOK_ALLOW_PRIVATE: z.stringbool().default(false),
  /** First retry delay for failed webhook deliveries; it doubles up to one hour. */
  WEBHOOK_RETRY_BASE_MS: z.coerce.number().int().min(10).default(30_000),
  /** SMTP server for outgoing email, for example smtps://user:pass@mail.example.com:465. */
  SMTP_URL: z.string().min(1).optional(),
  MAIL_FROM: z.string().default("Tempoloom <noreply@localhost>"),
  /** Default most members per team; the operator can set it per team with the CLI. */
  TEAM_SEAT_LIMIT: z.coerce.number().int().min(1).optional(),
  /** Seconds between reads of calendars attached through a grant, before first sign-in. */
  GRANT_REFRESH_SECONDS: z.coerce.number().int().min(5).default(86_400),
  /** People created (or calendars attached) per minute by paced provisioning. */
  PROVISION_PER_MINUTE: z.coerce.number().int().min(1).max(6000).default(60),
  /** Directory with the built web client. */
  WEB_DIST: z.string().default("./dist/web"),
  /** false: AI tools (MCP clients) may read but not stage changes (plans-feature-inventory.md). */
  MCP_WRITE_ENABLED: z.stringbool().default(true),
});

export type Config = z.infer<typeof schema> & { dbPath: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An empty value (for example `GOOGLE_CLIENT_ID=` in .env) means "not set".
  const parsed = schema.safeParse(
    Object.fromEntries(Object.entries(env).filter(([, v]) => v !== "")),
  );
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const dataDir = resolve(parsed.data.DATA_DIR);
  mkdirSync(dataDir, { recursive: true });
  return { ...parsed.data, DATA_DIR: dataDir, dbPath: join(dataDir, "tempoloom.db") };
}
