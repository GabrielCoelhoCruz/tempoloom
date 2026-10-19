// Sharing a link: the share menu (copy, email, social networks), website
// embeds and their redirect modes. Spec: booking-links-sharing.md rules 23-26;
// booking-links-booking-page.md rules 17 and 25-26.
//
// Ways this can fail:
//  1. Copy URL, the email draft or a social network's share page gets another
//     URL, or a share link opens in the same tab.                            (rule 23)
//  2. An embed format gives code that does not load the booking page, or
//     the URL format gives something else than the plain URL.                (rule 24)
//  3. The script embed does not resize its frame to the page.                (rule 24)
//  4. A booking made inside an embed does not reach the calendar.
//  5. The embedded page ignores the link's branding.                         (rule 26)
//  6. Redirect modes: "disabled" redirects; "top page" leaves the host page;
//     "frame" moves the host page instead of the frame.                      (rule 25)
//  7. The last redirect mode is not remembered.                              (rule 25)
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { at, BASE_URL, blockUntil, eventually, expect, test } from "./fixtures.ts";
import { addLink, allEvents, claimPage, slot, visitor, W } from "./helpers.ts";
import { editLink, saveLink } from "./link-helpers.ts";
import { openTeam } from "./team-helpers.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const AFTER = "https://after.tempoloom.test/done";

/** A website on another origin than Tempoloom, serving the pages a test puts in. */
async function website(): Promise<{
  origin: string;
  put: (path: string, body: string) => void;
  server: Server;
}> {
  const pages = new Map<string, string>();
  const server = createServer((req, res) => {
    const body = pages.get(req.url ?? "");
    res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(body ?? "not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    put: (path, html) =>
      pages.set(path, `<!doctype html><html><body><h1>Host site</h1>${html}</body></html>`),
    server,
  };
}

async function openShare(p: Page, title: string): Promise<void> {
  await p.getByRole("link", { name: "Booking links" }).click();
  await p.locator(`[data-link-title="${title}"]`).getByRole("button", { name: "Share" }).click();
  await expect(p.getByTestId("share-panel")).toBeVisible();
}

const embedCode = async (p: Page, format: string) => {
  const panel = p.getByTestId("share-panel");
  await panel.getByLabel(format, { exact: true }).check();
  return (await panel.getByLabel("Embed code").inputValue()).trim();
};

async function bookInFrame(v: Page, start: number, name: string): Promise<void> {
  const f = v.frameLocator("iframe");
  await f.locator(`[data-testid="times"] button[data-start="${start}"]`).click();
  await f.getByLabel("Your name").fill(name);
  await f.getByLabel("Your email").fill(`${name.toLowerCase()}@example.com`);
  await f.getByRole("button", { name: "Book" }).click();
  await expect(f.getByTestId("booked")).toBeVisible();
}

test("the share menu copies the URL and opens an email draft and the social networks' share pages with it (sharing rule 23)", async ({
  page,
  signIn,
}) => {
  await signIn();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await claimPage(page, "sia");
  await addLink(page, { title: "Chat", durations: "30" });
  const url = `${BASE_URL}/book/sia/chat`;
  await openShare(page, "Chat");
  const panel = page.getByTestId("share-panel");
  await panel.getByRole("button", { name: "Copy URL" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(url);

  const mail = new URL(
    (await panel.getByRole("link", { name: "Email" }).getAttribute("href")) ?? "",
  );
  expect(mail.protocol).toBe("mailto:");
  expect(mail.searchParams.get("subject")).toBe("Chat");
  expect(mail.searchParams.get("body")).toBe(`Book a time with me: ${url}`);

  await page
    .context()
    .route(/^https:\/\/(www\.linkedin\.com|x\.com|www\.facebook\.com)\//, (r) =>
      r.fulfill({ contentType: "text/html", body: "<h1>Share stub</h1>" }),
    );
  for (const [name, prefix] of [
    ["LinkedIn", "https://www.linkedin.com/sharing/share-offsite/?url="],
    ["X", "https://x.com/intent/post?url="],
    ["Facebook", "https://www.facebook.com/sharer/sharer.php?u="],
  ] as const) {
    const link = panel.getByRole("link", { name, exact: true });
    await expect(link).toHaveAttribute("target", "_blank");
    const [popup] = await Promise.all([page.context().waitForEvent("page"), link.click()]);
    await popup.waitForLoadState();
    expect(popup.url().startsWith(`${prefix}${encodeURIComponent(url)}`)).toBe(true);
    await popup.close();
  }
  await page.reload();
  await openShare(page, "Chat");
  await expect(page.getByTestId("share-panel").getByRole("link", { name: "Email" })).toBeVisible();
});

test("website embeds: script, object, iframe and URL load the booking page with its branding on another site; the script resizes its frame; a booking in the embed reaches the calendar (sharing rules 24, 26)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await openTeam(page);
  const br = page.getByTestId("team-branding");
  await br
    .getByLabel(/^Logo/)
    .setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await expect(br.getByTestId("logo-preview")).toBeVisible();
  await br.getByLabel("Homepage URL").fill("https://example.com/home");
  await br.getByRole("button", { name: "Save branding" }).click();
  await expect(br.getByTestId("branding-saved")).toBeVisible();
  await claimPage(page, "tia");
  await addLink(page, { title: "Chat", durations: "30" });
  await editLink(page, "Chat");
  await page.getByTestId("link-editor").getByLabel("Branding").selectOption("custom");
  await saveLink(page);

  const site = await website();
  try {
    await openShare(page, "Chat");
    const script = await embedCode(page, "Script");
    expect(script).toContain(`<script src="${BASE_URL}/embed.js"`);
    expect(script).toContain(`${BASE_URL}/book/tia/chat?embed=1`);
    const object = await embedCode(page, "Object");
    expect(object).toMatch(/^<object /);
    const iframe = await embedCode(page, "iframe");
    expect(iframe).toMatch(/^<iframe /);
    expect(await embedCode(page, "URL")).toBe(`${BASE_URL}/book/tia/chat`);
    site.put("/script.html", script);
    site.put("/object.html", object);
    site.put("/iframe.html", iframe);

    // Script: the frame shows the branded page and grows to its height.
    const v = await visitor(browser);
    await v.goto(`${site.origin}/script.html`);
    const frame = v.frameLocator(".tempoloom-embed iframe");
    await expect(frame.getByTestId("booking-page")).toContainText("Chat");
    await expect(frame.getByTestId("brand-logo")).toBeVisible();
    await expect(frame.getByTestId("brand-home")).toHaveAttribute(
      "href",
      "https://example.com/home",
    );
    await expect
      .poll(() =>
        v.locator(".tempoloom-embed iframe").evaluate((e) => e.getBoundingClientRect().height),
      )
      .toBeGreaterThan(700);
    await bookInFrame(v, at(W, "10:00"), "Embe");
    await eventually(
      () => allEvents(cal),
      (l) => expect(l.find((e) => e.summary === "Chat with Embe")).toBeDefined(),
    );
    await v.reload();
    await expect(frame.getByTestId("times")).toBeVisible();
    await expect(frame.locator(`button[data-start="${at(W, "10:00")}"]`)).toHaveCount(0);
    await expect(frame.locator(`button[data-start="${at(W, "10:30")}"]`)).toBeVisible();

    // Object and iframe load the same page.
    for (const path of ["/object.html", "/iframe.html"]) {
      await v.goto(`${site.origin}${path}`);
      await expect
        .poll(async () => {
          const f = v.frames().find((x) => x.url().startsWith(`${BASE_URL}/book/tia/chat?embed=1`));
          return f ? f.getByTestId("booking-page").isVisible() : false;
        })
        .toBe(true);
    }
    // URL: the plain booking page.
    await v.goto(await embedCode(page, "URL"));
    await expect(slot(v, at(W, "10:30"))).toBeVisible();
  } finally {
    site.server.close();
  }
});

test("embed redirect modes: none stays, top page sends the whole page to the redirect URL, frame moves only the frame; the last mode is remembered (sharing rule 25)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await claimPage(page, "una");
  await addLink(page, { title: "Chat", durations: "30" });
  const ed = await editLink(page, "Chat");
  await ed.getByLabel(/^Redirect after booking/).fill(AFTER);
  await saveLink(page);
  const site = await website();
  try {
    await openShare(page, "Chat");
    const panel = page.getByTestId("share-panel");
    const mode = panel.getByLabel("After a booking in the embed");
    await expect(mode).toHaveValue("disabled");
    site.put("/none.html", await embedCode(page, "iframe"));
    await mode.selectOption("topPage");
    site.put("/top.html", await embedCode(page, "iframe"));
    await mode.selectOption("frame");
    site.put("/frame.html", await embedCode(page, "iframe"));

    const stub = (p: Page) =>
      p
        .context()
        .route(`${AFTER}**`, (r) =>
          r.fulfill({ contentType: "text/html", body: "<h1>After booking</h1>" }),
        );
    const none = await visitor(browser);
    await stub(none);
    await none.goto(`${site.origin}/none.html`);
    await bookInFrame(none, at(W, "09:00"), "Nia");

    // Top page: the whole page leaves the host site.
    const top = await visitor(browser);
    await stub(top);
    await top.goto(`${site.origin}/top.html`);
    await bookInFrame(top, at(W, "10:00"), "Tom");
    await top.waitForURL(AFTER, { timeout: 20_000 });
    await expect(top.getByRole("heading")).toHaveText("After booking");

    // More than 7 seconds later, "disabled" is still on the host page with the confirmation.
    expect(none.url()).toBe(`${site.origin}/none.html`);
    await expect(none.frameLocator("iframe").getByTestId("booked")).toBeVisible();

    // Frame: only the frame goes to the redirect URL.
    const fr = await visitor(browser);
    await stub(fr);
    await fr.goto(`${site.origin}/frame.html`);
    await bookInFrame(fr, at(W, "11:00"), "Fay");
    await expect
      .poll(() => fr.frames().some((f) => f.url() === AFTER), { timeout: 20_000 })
      .toBe(true);
    expect(fr.url()).toBe(`${site.origin}/frame.html`);
    await expect(fr.frameLocator("iframe").getByRole("heading")).toHaveText("After booking");

    await eventually(
      () => allEvents(cal),
      (l) => {
        for (const n of ["Nia", "Tom", "Fay"])
          expect(l.find((e) => e.summary === `Chat with ${n}`)).toBeDefined();
      },
    );
    await page.reload();
    await openShare(page, "Chat");
    await expect(
      page.getByTestId("share-panel").getByLabel("After a booking in the embed"),
    ).toHaveValue("frame");
  } finally {
    site.server.close();
  }
});
