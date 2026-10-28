import { defineConfig } from "@playwright/test";

// E2E tests run against a real calendar backend, one test at a time, because
// they share one calendar account. See tests/e2e/README.md.
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
    baseURL: `http://localhost:${process.env.TEMPOLOOM_E2E_PORT ?? 8788}`,
    channel: "chrome",
    timezoneId: "Europe/Berlin",
    locale: "en-GB",
    viewport: { width: 1440, height: 900 },
    // The app's motion is off in E2E: boxes are where they end up on the first frame.
    // tests/e2e/motion.spec.ts turns it on.
    reducedMotion: "reduce",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // Never record traces or video: they can contain session tokens.
    trace: "off",
    video: "off",
    screenshot: "on",
  },
});
