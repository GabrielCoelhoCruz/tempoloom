// The plain-language buffer filter grammar (docs/specs/buffers-automation.md
// rule 4, Tempoloom decision). Failure modes, each covered below:
//  1. A phrase maps to the wrong condition or the wrong comparison.
//  2. "people" counts and "minutes" lengths are confused ("at least 3 people").
//  3. Hours are not turned into minutes.
//  4. Quoted text loses its case or its spaces, or "and" inside quotes splits it.
//  5. Several people, or a domain, are not all kept.
//  6. Unknown words are dropped silently instead of being reported.
//  7. Filler words ("meetings", "events", "all") are reported as unknown.
import { describe, expect, it } from "vitest";
import { describeEvents } from "../../src/shared/event-description.ts";

describe("describeEvents", () => {
  it("reads people, counts and lengths with their comparisons", () => {
    expect(describeEvents("meetings with ceo@corp.example longer than 30 minutes")).toEqual({
      filter: { people: ["ceo@corp.example"], length: { op: ">", minutes: 30 } },
      unknown: null,
    });
    expect(describeEvents("with 3 or more people").filter).toEqual({
      participants: { op: ">=", value: 3 },
    });
    expect(describeEvents("with at most 2 attendees").filter).toEqual({
      participants: { op: "<=", value: 2 },
    });
    expect(describeEvents("with exactly 2 people").filter).toEqual({
      participants: { op: "=", value: 2 },
    });
    expect(describeEvents("at least 3 people").filter).toEqual({
      participants: { op: ">=", value: 3 },
    });
    expect(describeEvents("at least 45 minutes").filter).toEqual({
      length: { op: ">=", minutes: 45 },
    });
    expect(describeEvents("events shorter than 1 hour").filter).toEqual({
      length: { op: "<", minutes: 60 },
    });
    expect(describeEvents("lasting 1.5 h").filter).toEqual({ length: { op: "=", minutes: 90 } });
  });

  it("keeps several people and domains", () => {
    expect(
      describeEvents(
        "meetings with ceo@corp.example or cfo@corp.example, with anyone at @board.example",
      ).filter,
    ).toEqual({ people: ["ceo@corp.example", "cfo@corp.example", "@board.example"] });
  });

  it("reads titles, text, tags, categories, travel, flights and runs", () => {
    expect(describeEvents('titled "Team standup"').filter).toEqual({ exactTitle: "Team standup" });
    expect(describeEvents('containing "Sync and plan"').filter).toEqual({
      text: { values: ["Sync and plan"], fields: ["title"] },
    });
    expect(describeEvents('mentioning "invoice"').filter).toEqual({
      text: { values: ["invoice"], fields: ["title", "description", "location"] },
    });
    expect(describeEvents("tagged #standup and #daily").filter).toEqual({
      tags: ["#standup", "#daily"],
    });
    expect(describeEvents("external meetings and one-on-ones").filter).toEqual({
      categories: ["external_meeting", "one_on_one"],
    });
    expect(describeEvents("team meetings").filter).toEqual({ categories: ["team_meeting"] });
    expect(describeEvents("events at an address").filter).toEqual({ travel: true });
    expect(describeEvents("flights").filter).toEqual({ flight: true });
    expect(describeEvents("back-to-back meetings longer than 90 minutes in a row").filter).toEqual({
      runLongerThanMinutes: 90,
    });
  });

  it("reports what it does not understand, and accepts filler words", () => {
    expect(describeEvents("meetings on Mars")).toEqual({ filter: {}, unknown: "on Mars" });
    expect(describeEvents("all my events")).toEqual({ filter: {}, unknown: null });
    expect(describeEvents("external meetings with purple people").unknown).toBe(
      "with purple people",
    );
  });
});
