// Personal API keys (docs/specs/integrations-api-keys-zapier.md rules 1-5). A
// request with a valid key acts as the key's user. Only a hash of the secret
// is stored, so the secret shows once, at creation or regeneration.
import { randomInt, randomUUID } from "node:crypto";
import { hashToken, type User } from "./accounts.ts";
import { all, type Db, one, run } from "./db.ts";

const DAY = 86_400_000;
export const EXPIRIES = { "30d": 30, "90d": 90, "1y": 365, never: null } as const;
export type Expiry = keyof typeof EXPIRIES;

export interface ApiKey {
  id: string;
  name: string;
  expires_at: number | null;
  created_at: number;
  last_used_at: number | null;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const group = () => Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
/** Four groups of letters and digits joined by hyphens, about 124 random bits. */
const newSecret = () => `tl-${group()}-${group()}-${group()}-${group()}`;

export function createApiKey(
  db: Db,
  userId: string,
  input: { name: string; expires: Expiry },
  now: number,
): { id: string; secret: string } {
  const days = EXPIRIES[input.expires];
  const id = randomUUID();
  const secret = newSecret();
  run(
    db,
    "INSERT INTO api_keys (id, user_id, name, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    id,
    userId,
    input.name,
    hashToken(secret),
    days === null ? null : now + days * DAY,
    now,
  );
  return { id, secret };
}

/** Replaces the secret; the old one stops working at once (rule 4). The expiry stays. */
export function regenerateApiKey(db: Db, userId: string, id: string): string | undefined {
  const secret = newSecret();
  const { changes } = db
    .prepare("UPDATE api_keys SET token_hash = ? WHERE id = ? AND user_id = ?")
    .run(hashToken(secret), id, userId);
  return changes ? secret : undefined;
}

export function deleteApiKey(db: Db, userId: string, id: string): boolean {
  return (
    db.prepare("DELETE FROM api_keys WHERE id = ? AND user_id = ?").run(id, userId).changes > 0
  );
}

export const listApiKeys = (db: Db, userId: string) =>
  all<ApiKey>(
    db,
    "SELECT id, name, expires_at, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at",
    userId,
  );

/** The user of an `Authorization: Bearer <key>` header, or undefined (rule 5). */
export function apiKeyUser(db: Db, header: string | undefined, now: number): User | undefined {
  const secret = /^Bearer (\S+)$/.exec(header ?? "")?.[1];
  if (!secret) return undefined;
  const row = one<User & { key_id: string }>(
    db,
    `SELECT u.id, u.email, u.name, u.time_zone, k.id AS key_id FROM api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.token_hash = ? AND (k.expires_at IS NULL OR k.expires_at > ?) AND u.deactivated_at IS NULL`,
    hashToken(secret),
    now,
  );
  if (!row) return undefined;
  run(db, "UPDATE api_keys SET last_used_at = ? WHERE id = ?", now, row.key_id);
  const { key_id: _, ...user } = row;
  return user;
}
