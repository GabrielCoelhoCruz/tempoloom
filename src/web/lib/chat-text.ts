// The text of an assistant reply in the chat panel (assistant-chat.md rule 1):
// a small safe part of markdown. Paragraphs and line breaks, "- " / "* " and
// "1. " lists, **bold**, *italic* or _italic_, `code`; a heading line shows
// as a bold line. Links, images and HTML stay plain text: the model's text can
// carry text from other people's invitations. The panel builds elements from
// these blocks, never HTML strings.

export type Inline =
  | string
  | { t: "strong" | "em"; children: Inline[] }
  | { t: "code"; text: string };
/** One line of text. */
export type Line = Inline[];
export type Block =
  | { t: "p"; lines: Line[] }
  | { t: "ul"; items: Line[][] }
  | { t: "ol"; start: number; items: Line[][] };

// Code first: no emphasis inside it. A span needs text right after its
// opening marker and right before its closing one, and a marker inside a word
// (2*3*4, snake_case) is text.
const INLINE =
  /`([^`\n]+)`|\*\*(?=\S)(.+?)(?<=\S)\*\*|(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])|(?<!\w)_(?=[^\s_])(.+?)(?<=[^\s_])_(?!\w)/g;

function inline(text: string): Line {
  const out: Line = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const [all, code, bold, star, under] = m;
    if (m.index > last) out.push(text.slice(last, m.index));
    last = m.index + all.length;
    if (code !== undefined) out.push({ t: "code", text: code });
    else if (bold !== undefined) out.push({ t: "strong", children: inline(bold) });
    else out.push({ t: "em", children: inline(star ?? under ?? "") });
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBER = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*?)\s*$/;

export function chatBlocks(text: string): Block[] {
  const out: Block[] = [];
  let open = false;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const prev = open ? out.at(-1) : undefined;
    const bullet = BULLET.exec(line);
    const number = NUMBER.exec(line);
    const heading = HEADING.exec(line);
    open = line.trim() !== "";
    if (!open) continue;
    if (bullet) {
      const item = [inline(bullet[1] ?? "")];
      if (prev?.t === "ul") prev.items.push(item);
      else out.push({ t: "ul", items: [item] });
    } else if (number) {
      const item = [inline(number[2] ?? "")];
      if (prev?.t === "ol") prev.items.push(item);
      else out.push({ t: "ol", start: Number(number[1]), items: [item] });
    } else if (prev && prev.t !== "p" && /^\s/.test(line)) {
      // An indented line goes on with the list item above it.
      prev.items.at(-1)?.push(inline(line.trim()));
    } else {
      const l: Line = heading
        ? [{ t: "strong", children: inline(heading[1] ?? "") }]
        : inline(line.trim());
      if (prev?.t === "p") prev.lines.push(l);
      else out.push({ t: "p", lines: [l] });
    }
  }
  return out;
}
