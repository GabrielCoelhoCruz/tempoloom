// The text of an assistant reply in the chat panel (src/web/lib/chat-text.ts;
// assistant-chat.md rule 1): a small safe part of markdown.
//
// Ways it can fail:
// 1. The panel shows the markers ("**", "- ", "`") instead of bold, lists and code.
// 2. A marker in plain text (2*3*4, snake_case, a lone "*") becomes emphasis
//    and the text loses characters.
// 3. A link or HTML in the model's text (it can carry text from other people's
//    invitations) becomes a link or markup.
// 4. Code shows emphasis inside it.
import { describe, expect, it } from "vitest";
import { chatBlocks } from "../../src/web/lib/chat-text.ts";

describe("chatBlocks", () => {
  it("keeps one plain line as one paragraph", () => {
    expect(chatBlocks("Tuesday: Design review at 10:00.")).toEqual([
      { t: "p", lines: [["Tuesday: Design review at 10:00."]] },
    ]);
  });

  it("splits paragraphs at blank lines and keeps single line breaks", () => {
    expect(chatBlocks("One\ntwo\r\n\r\n\nThree")).toEqual([
      { t: "p", lines: [["One"], ["two"]] },
      { t: "p", lines: [["Three"]] },
    ]);
  });

  it("makes lists of '- ', '* ' and '1. ' lines, with the start number", () => {
    expect(
      chatBlocks(
        "Your Wednesday:\n- **Wednesday 4 Nov:** Team standup 09:30-10:00\n* Design review\n\n3. First\n4. Second\nAfter",
      ),
    ).toEqual([
      { t: "p", lines: [["Your Wednesday:"]] },
      {
        t: "ul",
        items: [
          [[{ t: "strong", children: ["Wednesday 4 Nov:"] }, " Team standup 09:30-10:00"]],
          [["Design review"]],
        ],
      },
      { t: "ol", start: 3, items: [[["First"]], [["Second"]]] },
      { t: "p", lines: [["After"]] },
    ]);
  });

  it("adds an indented line after a list item to that item", () => {
    expect(chatBlocks("- Standup\n  at 09:30\n- Lunch")).toEqual([
      { t: "ul", items: [[["Standup"], ["at 09:30"]], [["Lunch"]]] },
    ]);
  });

  it("shows a heading line as a bold line", () => {
    expect(chatBlocks("### Summary\nAll clear")).toEqual([
      { t: "p", lines: [[{ t: "strong", children: ["Summary"] }], ["All clear"]] },
    ]);
  });

  it("parses bold, italic with * or _, and inline code, also nested", () => {
    const [p] = chatBlocks("**Free** after *noon*, _maybe_ `14:00` **then _rest_**");
    expect(p).toEqual({
      t: "p",
      lines: [
        [
          { t: "strong", children: ["Free"] },
          " after ",
          { t: "em", children: ["noon"] },
          ", ",
          { t: "em", children: ["maybe"] },
          " ",
          { t: "code", text: "14:00" },
          " ",
          { t: "strong", children: ["then ", { t: "em", children: ["rest"] }] },
        ],
      ],
    });
  });

  it("keeps markers that do not open and close a span as text", () => {
    for (const plain of [
      "2*3*4 and 2 * 3 * 4",
      "use list_events_today or __init__",
      "**not closed and *not closed",
      "a ** b ** c",
    ])
      expect(chatBlocks(plain)).toEqual([{ t: "p", lines: [[plain]] }]);
  });

  it("shows code as it is: no emphasis inside", () => {
    expect(chatBlocks("Run `a **b** _c_`")).toEqual([
      { t: "p", lines: [["Run ", { t: "code", text: "a **b** _c_" }]] },
    ]);
  });

  it("keeps links, bare URLs and HTML as plain text", () => {
    for (const plain of [
      "See [the agenda](https://evil.example/x?a=1)",
      "Open https://evil.example now",
      '<img src="https://evil.example/p.png"> <b>hi</b>',
      "![logo](https://evil.example/logo.png)",
    ])
      expect(chatBlocks(plain)).toEqual([{ t: "p", lines: [[plain]] }]);
  });
});
