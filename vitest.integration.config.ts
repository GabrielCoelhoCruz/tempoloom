import { defineConfig } from "vitest/config";

// Tests against real backends (Radicale). See scripts/caldav-server.sh.
export default defineConfig({
  test: { include: ["tests/integration/**/*.test.ts"], environment: "node", testTimeout: 30_000 },
});
