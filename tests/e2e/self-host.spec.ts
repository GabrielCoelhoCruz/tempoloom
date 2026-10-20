// Self-hosting (ADR 0001, README "With Docker"): the Docker image runs as one
// process with one SQLite file in one data volume. The test runs the
// documented setup: `docker compose up -d` with the repository's compose.yaml
// and a .env file, the image defaults for HOST and PORT, the published port
// and the named data volume. Only the host side of the port changes (a
// loopback port per run), and the image name. The app reaches the loopback
// Radicale by its container name on the compose network. The test signs in
// through the UI, adds a task, restarts the container, then replaces it with
// a new container on the same volume, and checks that the session, the task
// and its calendar event are kept.
//
// Ways this can fail, and the step that catches each:
// - the image does not build or does not start (build, health wait)
// - the image does not listen on the published port with its defaults, for
//   example HOST=127.0.0.1 (health wait: Tempoloom must answer on the port)
// - the container runs more than the app process (process list)
// - the database is not in the data volume, so a new container starts empty
//   (task row and session after the container is replaced)
// - the data volume holds more than the one SQLite file (file list)
// - a restart loses the link between the task and its event, so the planner
//   writes the event again (same event id after each restart)
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASE_URL,
  test as base,
  blockUntil,
  EMAIL,
  eventually,
  expect,
  managed,
  PORT,
} from "./fixtures.ts";
import { addTask, allEvents, titled, W } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "../..");
const SERVICE = "tempoloom";
const RADICALE = process.env.TEMPOLOOM_CALDAV_CONTAINER ?? "tempoloom-e2e-radicale";
// Names follow the Radicale container, so parallel runs with their own
// TEMPOLOOM_CALDAV_CONTAINER do not share a project, network, volume or image.
const PROJECT = `${RADICALE}-app`.toLowerCase().replace(/[^a-z0-9_-]/g, "-");

const docker = (...args: string[]) =>
  execFileSync("docker", args, { cwd: ROOT, encoding: "utf8", stdio: "pipe" }).trim();
const quiet = (...args: string[]) => {
  try {
    docker(...args);
  } catch {}
};

interface SelfHost {
  /** The CalDAV URL of the loopback Radicale, as the app container reaches it. */
  caldavUrl: string;
  /** `docker compose up -d`; with `replace`, a new container on the same volume. */
  up: (replace?: boolean) => void;
  restart: () => void;
  /** Waits until Tempoloom answers on the published port and the container runs. */
  healthy: () => Promise<void>;
  /** Command lines of the processes in the app container, without the HEALTHCHECK. */
  processes: () => string[];
  /** Files in the data volume. */
  files: () => string[];
}

const test = base.extend<{ selfHost: SelfHost }>({
  selfHost: async ({ radicale }, use, info) => {
    if (!radicale) {
      info.skip(true, "Runs against the loopback CalDAV server.");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "tempoloom-selfhost-"));
    // The temp dir holds SECRET_KEY: remove it even when the setup fails.
    try {
      let image = process.env.TEMPOLOOM_SELFHOST_IMAGE;
      const built = !image;
      image ??= `${PROJECT}:e2e`;
      // The documented .env (.env.example): the secret and the public URL. No
      // HOST or PORT: the image defaults apply. Mode 600, removed at teardown.
      const envFile = join(dir, ".env");
      writeFileSync(
        envFile,
        [
          `BASE_URL=${BASE_URL}`,
          `SECRET_KEY=${randomBytes(32).toString("base64")}`,
          "SYNC_INTERVAL_SECONDS=5",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      const override = join(dir, "compose.override.yaml");
      const compose = (...args: string[]) =>
        docker("compose", "-p", PROJECT, "-f", "compose.yaml", "-f", override, ...args);
      const writeOverride = (ports: string) =>
        writeFileSync(
          override,
          [
            "services:",
            `  ${SERVICE}:`,
            `    image: ${JSON.stringify(image)}`,
            `    env_file: !override [${JSON.stringify(envFile)}]`,
            ports,
            "",
          ].join("\n"),
        );
      // Keep the container port and the volume of compose.yaml; publish the
      // container port on a loopback host port of this run.
      writeOverride("");
      const config = JSON.parse(compose("config", "--format", "json")) as {
        services: Record<string, { ports?: { target: number }[] }>;
      };
      const target = config.services[SERVICE]?.ports?.[0]?.target;
      expect(target, "compose.yaml publishes a port").toBeTruthy();
      writeOverride(`    ports: !override ["127.0.0.1:${PORT}:${target}"]`);
      const network = `${PROJECT}_default`;
      const volume = `${PROJECT}_tempoloom-data`;
      const container = () => compose("ps", "-q", SERVICE);
      const logs = () => {
        try {
          return compose("logs", "--no-color", SERVICE);
        } catch (err) {
          return String(err);
        }
      };
      const down = () => {
        quiet("network", "disconnect", "-f", network, RADICALE);
        quiet(
          "compose",
          "-p",
          PROJECT,
          "-f",
          "compose.yaml",
          "-f",
          override,
          "down",
          "-v",
          "-t",
          "5",
        );
        quiet("volume", "rm", "-f", volume);
        quiet("network", "rm", network);
      };
      down();
      try {
        if (built) compose("build", "-q", SERVICE);
        const up = (replace = false) => {
          compose("up", "-d", "--no-build", ...(replace ? ["--force-recreate"] : []));
          // The app reaches Radicale by container name on the compose network.
          try {
            docker("network", "connect", network, RADICALE);
          } catch (err) {
            if (!/already exists/.test(String(err))) throw err;
          }
        };
        await use({
          caldavUrl: `http://${RADICALE}:5232/`,
          up,
          restart: () => compose("restart", SERVICE),
          healthy: async () => {
            await eventually(
              async () => {
                let methods: unknown;
                try {
                  // A Tempoloom endpoint, not just any responder on the port.
                  methods = await (await fetch(`${BASE_URL}/auth/methods`)).json();
                } catch {}
                let running = "";
                try {
                  running = docker("inspect", "-f", "{{.State.Running}}", container());
                } catch {}
                return { methods, running };
              },
              (s) =>
                expect(s, `container of ${PROJECT} is healthy:\n${logs()}`).toEqual({
                  methods: { google: false, caldav: true },
                  running: "true",
                }),
              60_000,
            );
          },
          processes: () =>
            docker("top", container(), "-o", "pid,args")
              .split("\n")
              .slice(1)
              .map((l) => l.trim().replace(/^\d+\s+/, ""))
              // The image HEALTHCHECK runs a short `node -e fetch(.../healthz)`
              // every 30 s; it is not a second service.
              .filter((l) => l && !l.includes("/healthz")),
          files: () =>
            docker(
              "run",
              "--rm",
              "-v",
              `${volume}:/data`,
              "--entrypoint",
              "ls",
              image,
              "-A",
              "/data",
            )
              .split("\n")
              .filter(Boolean),
        });
      } finally {
        // Runs on a pass, a failure and a timeout: the fixture owns the cleanup.
        const log = logs();
        await info.attach("container.log", { body: log, contentType: "text/plain" });
        mkdirSync(join(ROOT, ".e2e"), { recursive: true });
        writeFileSync(join(ROOT, ".e2e/self-host-container.log"), log);
        down();
        if (built) quiet("rmi", image);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

test.describe.configure({ timeout: 900_000 });

test("the Docker image keeps the session, a task and its event in one SQLite volume across restarts (X2)", {
  tag: "@self-host",
}, async ({ page, cal, radicale, selfHost }) => {
  if (!radicale) return;
  selfHost.up();
  await selfHost.healthy();
  // One process: the app itself, no supervisor or second service.
  expect(selfHost.processes()).toEqual([expect.stringMatching(/^node src\/server\/main\.ts$/)]);

  await blockUntil(cal, W);
  await page.goto("/");
  const form = page.getByTestId("caldav-form");
  await form.getByLabel("CalDAV server URL").fill(selfHost.caldavUrl);
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
    await selfHost.healthy();
    expect(selfHost.processes(), `${step}: one process`).toHaveLength(1);
    await page.reload();
    await expect(page.getByTestId("app-shell"), `${step}: still signed in`).toBeVisible();
    await page.getByRole("link", { name: "Tasks" }).click();
    await expect(page.locator(`[data-task-title="${title}"]`), `${step}: task kept`).toBeVisible();
    // Plan again, then check across two sync ticks: the event stays the same one.
    const planned = await page.evaluate(() =>
      fetch("/api/planner/sync", { method: "POST" }).then((r) => r.ok),
    );
    expect(planned, `${step}: plan runs`).toBe(true);
    for (const _ of [1, 2]) {
      await page.waitForTimeout(5_500);
      const evs = titled(managed(await allEvents(cal)), title);
      expect(
        evs.map((e) => e.id),
        `${step}: same event`,
      ).toEqual([eventId]);
    }
  };

  selfHost.restart();
  await keeps("after docker compose restart");

  // A new container on the same volume, as after an image upgrade.
  selfHost.up(true);
  await keeps("in a new container");

  const files = selfHost.files();
  expect(files.filter((f) => !/^tempoloom\.db(-wal|-shm)?$/.test(f))).toEqual([]);
  expect(files).toContain("tempoloom.db");
});
