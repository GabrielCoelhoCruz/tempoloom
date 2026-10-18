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
  /** Directory with the built web client. */
  WEB_DIST: z.string().default("./dist/web"),
});

export type Config = z.infer<typeof schema> & { dbPath: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const dataDir = resolve(parsed.data.DATA_DIR);
  mkdirSync(dataDir, { recursive: true });
  return { ...parsed.data, DATA_DIR: dataDir, dbPath: join(dataDir, "tempoloom.db") };
}
