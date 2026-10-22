// The order of load answers in the web client (src/web/lib/api.ts): a page
// reads its data again after each change (a live update, its own save), and
// the answers may come back in any order.
//
// Ways it can fail:
// 1. An older GET answer that comes last overwrites the newer one, so the page
//    shows the data from before a change (and an edit starts from it).
// 2. A newer GET that fails takes the older answer down with it.
// 3. Other requests (writes) or other URLs wait for or take another answer.
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../src/web/lib/api.ts";

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

  it("waits for the newer GET when the older answer comes first", async () => {
    const calls = fakeFetch();
    const before = api<{ n: number }>("GET", "/api/meetings");
    const after = api<{ n: number }>("GET", "/api/meetings");
    await tick();
    calls[0]?.answer(200, { n: 1 });
    calls[1]?.answer(200, { n: 2 });
    expect(await before).toEqual({ n: 2 });
    expect(await after).toEqual({ n: 2 });
  });

  it("keeps the older answer when the newer GET fails", async () => {
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
