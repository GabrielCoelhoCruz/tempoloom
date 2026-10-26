import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { trustedSet } from "./client-address.ts";

const schema = z
  .object({
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
    /** Seconds of failed deliveries after which an endpoint is suspended (24 hours). */
    WEBHOOK_SUSPEND_AFTER_SECONDS: z.coerce.number().int().min(1).default(86_400),
    /** SMTP server for outgoing email, for example smtps://user:pass@mail.example.com:465. */
    SMTP_URL: z.string().min(1).optional(),
    MAIL_FROM: z.string().default("Tempoloom <noreply@localhost>"),
    /** The weekly report email (analytics-weekly-reports.md); "off" stops the server sending it. */
    WEEKLY_REPORTS: z.enum(["on", "off"]).default("on"),
    /** Tests only: the server clock starts at this ISO instant and runs on from there. */
    TEST_CLOCK_START: z.iso.datetime().optional(),
    /** Must be 1 for TEST_CLOCK_START, so that no real server starts with a moved clock. */
    TEMPOLOOM_TEST_MODE: z.stringbool().default(false),
    /** Default most members per team; the operator can set it per team with the CLI. */
    TEAM_SEAT_LIMIT: z.coerce.number().int().min(1).optional(),
    /** Seconds between reads of calendars attached through a grant, before first sign-in. */
    GRANT_REFRESH_SECONDS: z.coerce.number().int().min(5).default(86_400),
    /** People created (or calendars attached) per minute by paced provisioning. */
    PROVISION_PER_MINUTE: z.coerce.number().int().min(1).max(6000).default(60),
    /** Seconds between full reconciles of the calendar mirroring copies (twice a day). */
    MIRROR_RECONCILE_SECONDS: z.coerce.number().int().min(5).default(43_200),
    /** Directory with the built web client. */
    WEB_DIST: z.string().default("./dist/web"),
    /**
     * Comma-separated addresses of reverse proxies in front of this server. Only a
     * request from one of them has its client address read from X-Forwarded-For.
     */
    TRUSTED_PROXIES: z
      .string()
      .default("")
      .transform((v) =>
        v
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.union([z.ipv4(), z.ipv6()])))
      .transform(trustedSet),
    /** false: AI tools (MCP clients) may read but not stage changes (plans-feature-inventory.md). */
    MCP_WRITE_ENABLED: z.stringbool().default(true),
    /** Where users ask for help, shown on the help page (support-troubleshooting.md rule 4). */
    SUPPORT_URL: z.url({ protocol: /^https?$/ }).optional(),
    /** Days a one-off booking link works after it is made (booking-links-sharing.md rule 14). */
    ONEOFF_LINK_DAYS: z.coerce.number().int().min(0).max(365).default(30),
    /**
     * Assistant chat (assistant-chat.md): an OpenAI-compatible endpoint, for
     * example https://host/v1. Not set: the chat panel says the assistant is
     * not configured. The key is sent as a bearer token when set.
     */
    TEMPOLOOM_LLM_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
    TEMPOLOOM_LLM_API_KEY: z.string().min(1).optional(),
    TEMPOLOOM_LLM_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
    /** Milliseconds one model call may take. */
    TEMPOLOOM_LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60_000),
    /**
     * Milliseconds one chat turn (all its model calls and tools) may take. Keep
     * it below the read timeout of a reverse proxy in front (often 60 s).
     */
    TEMPOLOOM_LLM_TURN_MS: z.coerce.number().int().min(1000).default(55_000),
  })
  .refine((c) => !c.TEST_CLOCK_START || c.TEMPOLOOM_TEST_MODE, {
    path: ["TEST_CLOCK_START"],
    message: "TEST_CLOCK_START needs TEMPOLOOM_TEST_MODE=1 (tests only)",
  });

export type Config = z.infer<typeof schema> & { dbPath: string };

/**
 * The server clock: Date.now, or with TEST_CLOCK_START a clock that starts at
 * that instant and runs on from there. Pass it as `now`; Date.now stays real.
 */
export function clockOf(config: Pick<Config, "TEST_CLOCK_START">): () => number {
  if (!config.TEST_CLOCK_START) return Date.now;
  const offset = Date.parse(config.TEST_CLOCK_START) - Date.now();
  return () => Date.now() + offset;
}

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
