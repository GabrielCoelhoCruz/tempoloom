// The body of an edit (src/web/lib/changed.ts; automations-overview.md rule
// 11, decision "an edit sends only the fields it changed").
//
// Ways it can fail:
// 1. A field the form did not change is sent, and writes back an old value.
// 2. A changed field is not sent: a new array order, null against "", a key
//    the first body did not have.
// 3. Half of the hours choice is sent (the mode without its ranges), so the
//    server mixes it with the stored half.
// 4. An invalid number (NaN) equals null in JSON, so it is dropped without the
//    400 the server gives for it.
// 5. A new form (a new key) compares with the body of the form before it.
import { describe, expect, it } from "vitest";
import { changedFields, firstBody } from "../../src/web/lib/changed.ts";

describe("changedFields", () => {
  it("sends only the fields with another value", () => {
    const first = { title: "A", notes: "", days: [1, 2], at: null as string | null };
    expect(changedFields(first, { ...first })).toEqual({});
    expect(changedFields(first, { ...first, title: "B" })).toEqual({ title: "B" });
    expect(changedFields(first, { ...first, days: [2, 1] })).toEqual({ days: [2, 1] });
    expect(changedFields(first, { ...first, at: "" })).toEqual({ at: "" });
    expect(changedFields({ title: "A" }, { title: "A", extra: 1 } as { title: string })).toEqual({
      extra: 1,
    });
  });

  it("sends the hours choice and its ranges together", () => {
    const first: { title: string; hoursMode: string; itemHours?: object } = {
      title: "A",
      hoursMode: "itemSpecific",
      itemHours: { "2": [[540, 600]] },
    };
    expect(changedFields(first, { ...first, itemHours: { "2": [[540, 660]] } })).toEqual({
      hoursMode: "itemSpecific",
      itemHours: { "2": [[540, 660]] },
    });
    // Back to everyone's hours: the ranges are gone, the mode goes alone.
    expect(changedFields(first, { title: "A", hoursMode: "everyone" })).toEqual({
      hoursMode: "everyone",
    });
    expect(changedFields(first, { ...first, title: "B" })).toEqual({ title: "B" });
  });

  it("always sends an invalid number, so the server refuses it", () => {
    const first = { maxPerDay: null as number | null, minutes: 30 };
    expect(changedFields(first, { maxPerDay: Number.NaN, minutes: 30 })).toEqual({
      maxPerDay: Number.NaN,
    });
    expect(JSON.stringify({ maxPerDay: Number.NaN })).toBe('{"maxPerDay":null}');
    expect(changedFields(first, { ...first, minutes: Number.NaN })).toEqual({
      minutes: Number.NaN,
    });
  });
});

describe("firstBody", () => {
  const form = (title: string) => ({ title }) as unknown as HTMLFormElement;
  const read = (f: HTMLFormElement) => ({ title: (f as unknown as { title: string }).title });

  it("keeps the body the form had when it appeared, and reads it again for a new form", () => {
    const first = firstBody<{ title: string }>();
    const a = form("A");
    first.ref(read)(a);
    // Later draws call the ref again; the first body stays.
    first.ref(read)(null);
    (a as unknown as { title: string }).title = "A2";
    first.ref(read)(a);
    expect(first.changed(a, { title: "A" })).toEqual({});
    expect(first.changed(a, { title: "A2" })).toEqual({ title: "A2" });
    const b = form("B");
    first.ref(read)(b);
    expect(first.changed(b, { title: "B" })).toEqual({});
    // A form it never saw sends the whole body.
    expect(first.changed(form("C"), { title: "C" })).toEqual({ title: "C" });
  });
});
