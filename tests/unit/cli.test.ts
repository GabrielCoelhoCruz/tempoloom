// Operator commands (src/server/cli.ts). Ways it can fail:
// 1. weekly-reports --now runs a full tick of the email worker at a moved
//    instant on a real server: it sends other digests due then and moves
//    their next send time.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const cli = (env: Record<string, string>, ...args: string[]) =>
  spawnSync(process.execPath, ["src/server/cli.ts", ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      SECRET_KEY: Buffer.alloc(32, 1).toString("base64"),
      DATA_DIR: mkdtempSync(join(tmpdir(), "tempoloom-cli-")),
      ...env,
    },
    encoding: "utf8",
  });

describe("weekly-reports --now", () => {
  it("is refused without TEMPOLOOM_TEST_MODE=1", () => {
    const r = cli({}, "weekly-reports", "--now", "2026-11-13T08:30:00Z");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--now needs TEMPOLOOM_TEST_MODE=1/);
  });

  it("runs with TEMPOLOOM_TEST_MODE=1", () => {
    const r = cli({ TEMPOLOOM_TEST_MODE: "1" }, "weekly-reports", "--now", "2026-11-13T08:30:00Z");
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("sent 0 reports");
  });

  it("runs at the server clock without --now", () => {
    const r = cli({}, "weekly-reports");
    expect(r.stdout).toContain("sent 0 reports");
  });
});
