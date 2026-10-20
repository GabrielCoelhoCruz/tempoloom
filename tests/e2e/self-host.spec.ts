// Self-hosting (ADR 0001, README "With Docker"): the Docker image runs as one
// process with one SQLite file in one data volume. The test builds the image
// (or uses TEMPOLOOM_SELFHOST_IMAGE), runs it against the loopback Radicale,
// signs in through the UI, adds a task, restarts the container, then replaces
// it with a new container on the same volume, and checks that the session, the
// task and its calendar event are kept.
//
// Ways this can fail, and the step that catches each:
// - the image does not build or does not start (build, health wait)
// - the database is not in the data volume, so a new container starts empty
//   (task row and session after the container is replaced)
// - the data volume holds more than the one SQLite file (file list)
// - a restart loses the link between the task and its event, so the planner
//   writes the event again (same event id after each restart)
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { blockUntil, EMAIL, eventually, expect, managed, PORT, test } from "./fixtures.ts";
import { addTask, allEvents, titled, W } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "../..");
// Names follow the Radicale container, so parallel runs with their own
// TEMPOLOOM_CALDAV_CONTAINER do not share a container, volume or image.
const NAME = `${process.env.TEMPOLOOM_CALDAV_CONTAINER ?? "tempoloom-e2e-radicale"}-app`;
const VOLUME = `${NAME}-data`;
const docker = (...args: string[]) =>
  execFileSync("docker", args, { cwd: ROOT, encoding: "utf8", stdio: "pipe" }).trim();
const quiet = (...args: string[]) => {
  try {
    docker(...args);
  } catch {}
};

test("the Docker image keeps the session, a task and its event in one SQLite volume across restarts (X2)", {
  tag: "@self-host",
}, async ({ page, cal, radicale }) => {
  test.skip(!radicale, "Runs against the loopback CalDAV server.");
  if (!radicale) return;
  test.setTimeout(900_000);
  let image = process.env.TEMPOLOOM_SELFHOST_IMAGE;
  const built = !image;
  if (!image) {
    image = `${NAME.toLowerCase()}:e2e`;
    execFileSync("docker", ["build", "-q", "-t", image, "."], { cwd: ROOT, stdio: "ignore" });
  }
  const secretKey = randomBytes(32).toString("base64");
  const run = () =>
    docker(
      "run",
      "-d",
      "--name",
      NAME,
      // Host network: the app reaches Radicale on 127.0.0.1 and listens on the E2E port.
      "--network",
      "host",
      "-v",
      `${VOLUME}:/data`,
      "-e",
      "HOST=127.0.0.1",
      "-e",
      `PORT=${PORT}`,
      "-e",
      `BASE_URL=http://localhost:${PORT}`,
      "-e",
      "SYNC_INTERVAL_SECONDS=5",
      "-e",
      "SECRET_KEY",
      image,
    );
  const healthy = async () => {
    await eventually(
      async () => {
        try {
          return (await fetch(`http://localhost:${PORT}/healthz`)).ok;
        } catch {
          return false;
        }
      },
      (ok) => expect(ok, `container ${NAME} is healthy:\n${logs()}`).toBe(true),
      60_000,
    );
  };
  const logs = () => {
    try {
      return execFileSync("docker", ["logs", NAME], { encoding: "utf8", stdio: "pipe" });
    } catch {
      return "";
    }
  };
  quiet("rm", "-f", NAME);
  quiet("volume", "rm", "-f", VOLUME);
  process.env.SECRET_KEY = secretKey;
  try {
    run();
    await healthy();

    await blockUntil(cal, W);
    await page.goto("/");
    const form = page.getByTestId("caldav-form");
    await form.getByLabel("CalDAV server URL").fill(radicale.url);
    await form.getByLabel("User name", { exact: true }).fill(radicale.username);
    await form.getByLabel("Password", { exact: true }).fill(radicale.password);
    await form.getByLabel(/^Email/).fill(EMAIL);
    await form.getByRole("button", { name: /sign in with caldav/i }).click();
    await expect(page.getByTestId("app-shell")).toBeVisible();

    const title = "Self-host task";
    await addTask(page, { title, minutes: 60, split: false, due: "" });
    const placed = await eventually(
      async () => titled(managed(await allEvents(cal)), title),
      (evs) => expect(evs).toHaveLength(1),
    );
    const eventId = placed[0]?.id;

    const keeps = async (step: string) => {
      await healthy();
      await page.reload();
      await expect(page.getByTestId("app-shell"), `${step}: still signed in`).toBeVisible();
      await page.getByRole("link", { name: "Tasks" }).click();
      await expect(
        page.locator(`[data-task-title="${title}"]`),
        `${step}: task kept`,
      ).toBeVisible();
      // Plan again, then wait two sync ticks: the event must stay the same one.
      const planned = await page.evaluate(() =>
        fetch("/api/planner/sync", { method: "POST" }).then((r) => r.ok),
      );
      expect(planned, `${step}: plan runs`).toBe(true);
      await page.waitForTimeout(11_000);
      const evs = titled(managed(await allEvents(cal)), title);
      expect(
        evs.map((e) => e.id),
        `${step}: same event`,
      ).toEqual([eventId]);
    };

    docker("restart", NAME);
    await keeps("after docker restart");

    // A new container on the same volume, as after an image upgrade.
    docker("rm", "-f", NAME);
    run();
    await keeps("in a new container");

    const files = docker(
      "run",
      "--rm",
      "-v",
      `${VOLUME}:/data`,
      "--entrypoint",
      "ls",
      image,
      "-A",
      "/data",
    )
      .split("\n")
      .filter(Boolean);
    expect(files.filter((f) => !/^tempoloom\.db(-wal|-shm)?$/.test(f))).toEqual([]);
    expect(files).toContain("tempoloom.db");
  } finally {
    test.info().attach("container.log", { body: logs(), contentType: "text/plain" });
    delete process.env.SECRET_KEY;
    quiet("rm", "-f", NAME);
    quiet("volume", "rm", "-f", VOLUME);
    if (built) quiet("rmi", image);
  }
});
