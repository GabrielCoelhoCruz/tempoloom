import { defineConfig } from "@playwright/test";

// E2E tests run against a real Google Calendar test account, one at a time,
// because they share that account's calendar. See tests/e2e/README.md.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: ".e2e/report", open: "never" }],
    ["json", { outputFile: ".e2e/results.json" }],
  ],
  outputDir: ".e2e/test-results",
  use: {
    // Never record traces or video: they can contain session tokens.
    trace: "off",
    video: "off",
    screenshot: "on",
    viewport: { width: 1440, height: 900 },
  },
});
