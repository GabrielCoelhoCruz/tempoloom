// Personal API keys (docs/specs/integrations-api-keys-zapier.md rules 3-5).
// The E2E suite covers create, use, regenerate and delete through the UI; the
// expiry boundary needs a clock the browser cannot move.
//
// Ways it can fail:
// 1. An expired key still authenticates.
// 2. A key authenticates without the "Bearer" scheme, or with a wrong secret.
// 3. A key of a deactivated user still authenticates.
// 4. "never" expires.
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { apiKeyUser, createApiKey } from "../../src/server/api-keys.ts";
import { openDb, run } from "../../src/server/db.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-19T08:00:00Z");

function setup() {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", T0);
  return { db, user };
}

describe("API key authentication", () => {
  it("accepts a 30-day key until it expires, and refuses it after", () => {
    const { db, user } = setup();
    const { secret } = createApiKey(db, user.id, { name: "Zap", expires: "30d" }, T0);
    expect(apiKeyUser(db, `Bearer ${secret}`, T0 + 29 * DAY)?.id).toBe(user.id);
    expect(apiKeyUser(db, `Bearer ${secret}`, T0 + 30 * DAY + 1)).toBeUndefined();
  });

  it("keeps a key without expiry valid", () => {
    const { db, user } = setup();
    const { secret } = createApiKey(db, user.id, { name: "Raycast", expires: "never" }, T0);
    expect(apiKeyUser(db, `Bearer ${secret}`, T0 + 3650 * DAY)?.id).toBe(user.id);
  });

  it("refuses a missing scheme, a wrong secret and a deactivated user", () => {
    const { db, user } = setup();
    const { secret } = createApiKey(db, user.id, { name: "Zap", expires: "never" }, T0);
    expect(apiKeyUser(db, secret, T0)).toBeUndefined();
    expect(apiKeyUser(db, `Bearer ${secret}x`, T0)).toBeUndefined();
    expect(apiKeyUser(db, undefined, T0)).toBeUndefined();
    run(db, "UPDATE users SET deactivated_at = ? WHERE id = ?", T0, user.id);
    expect(apiKeyUser(db, `Bearer ${secret}`, T0)).toBeUndefined();
  });
});
