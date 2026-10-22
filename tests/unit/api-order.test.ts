// The order of load answers in the web client (src/web/lib/api.ts): a page
// reads its data again after each change (a live update, its own save), and
// the answers may come back in any order.
//
// Ways it can fail:
// 1. An older GET answer that comes last overwrites the newer one, so the page
//    shows the data from before a change (and an edit starts from it).
// 2. A newer GET that fails on the network or with a 5xx takes the older
//    answer down with it; a newer 401 or 404 loses to an older 200.
// 3. An older GET waits for a newer one, so a burst of polls stalls the page.
// 4. Other requests (writes) or other URLs wait for or take another answer.
// 5. The page keeps an entry for each URL it ever read.
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, getsInFlight } from "../../src/web/lib/api.ts";

/** A fetch whose answers the test sends, in any order. */
function fakeFetch() {
  const calls: { url: string; answer: (status: number, body: unknown) => void }[] = [];
  vi.stubGlobal(
    "fetch",
    (url: string) =>
      new Promise<Response>((resolve) => {
        calls.push({
          url,
          answer: (status, body) => resolve(Response.json(body, { status })),
        });
      }),
  );
  return calls;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.unstubAllGlobals());

describe("GET answers out of order", () => {
  it("gives the newest answer to an older GET of the same URL that comes last", async () => {
    const calls = fakeFetch();
    const before = api<{ n: number }>("GET", "/api/meetings");
    const after = api<{ n: number }>("GET", "/api/meetings");
    await tick();
    calls[1]?.answer(200, { n: 2 });
    expect(await after).toEqual({ n: 2 });
    calls[0]?.answer(200, { n: 1 });
    expect(await before).toEqual({ n: 2 });
  });

  it("does not wait for a newer GET that is still on its way", async () => {
    const calls = fakeFetch();
    const before = api<{ n: number }>("GET", "/api/meetings");
    const after = api<{ n: number }>("GET", "/api/meetings");
    await tick();
    calls[0]?.answer(200, { n: 1 });
    expect(await before).toEqual({ n: 1 });
    calls[1]?.answer(200, { n: 2 });
    expect(await after).toEqual({ n: 2 });
  });

  it("gives a newer 404 to an older GET that answers 200 after it", async () => {
    const calls = fakeFetch();
    const before = api("GET", "/api/me");
    const after = api("GET", "/api/me");
    await tick();
    calls[1]?.answer(404, {});
    await expect(after).rejects.toThrow("API error 404");
    calls[0]?.answer(200, { n: 1 });
    await expect(before).rejects.toThrow("API error 404");
  });

  it("keeps no entry for a URL once its GETs ended", async () => {
    const calls = fakeFetch();
    const a = api("GET", "/api/planner/events?from=1");
    const b = api("GET", "/api/planner/events?from=1");
    const c = api("GET", "/api/planner/events?from=2");
    await tick();
    expect(getsInFlight()).toBe(2);
    calls[1]?.answer(200, { n: 2 });
    await b;
    // The older GET of the first URL still needs the newer answer.
    expect(getsInFlight()).toBe(2);
    calls[0]?.answer(200, { n: 1 });
    expect(await a).toEqual({ n: 2 });
    calls[2]?.answer(500, {});
    await expect(c).rejects.toThrow("API error 500");
    expect(getsInFlight()).toBe(0);
  });

  it("keeps the older answer when the newer GET fails with a 5xx", async () => {
    const calls = fakeFetch();
    const before = api<{ n: number }>("GET", "/api/meetings");
    const after = api<{ n: number }>("GET", "/api/meetings");
    await tick();
    calls[1]?.answer(500, {});
    await expect(after).rejects.toThrow("API error 500");
    calls[0]?.answer(200, { n: 1 });
    expect(await before).toEqual({ n: 1 });
  });

  it("leaves writes and other URLs alone", async () => {
    const calls = fakeFetch();
    const list = api<{ n: number }>("GET", "/api/habits");
    const other = api<{ n: number }>("GET", "/api/meetings");
    const write = api<{ ok: boolean }>("PATCH", "/api/habits/h1", { title: "A" });
    await tick();
    calls[1]?.answer(200, { n: 2 });
    calls[2]?.answer(200, { ok: true });
    calls[0]?.answer(200, { n: 1 });
    expect(await list).toEqual({ n: 1 });
    expect(await other).toEqual({ n: 2 });
    expect(await write).toEqual({ ok: true });
  });
});
