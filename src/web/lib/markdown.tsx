// Markdown in event notes (docs/specs/planning-event-content.md CNT-11 to
// CNT-14): bold, italic, headings 1 to 3, numbered, bullet and check lists,
// links (also app links such as obsidian://) and http(s) images. It builds
// elements, never HTML strings, so notes cannot inject markup.
import type { ComponentChildren } from "preact";

const UNSAFE = /^\s*(javascript|vbscript|data|file):/i;
const IMAGE = /^https?:\/\//i;
const INLINE =
  /(!?)\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|\*\*(.+?)\*\*|(?<![\w*])\*(?!\s)(.+?)\*(?!\w)|(?<!\w)_(?!\s)(.+?)_(?!\w)|(https?:\/\/[^\s<>"')\]]+)/g;

function inline(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const [all, bang, label, href, bold, star, under, bare] = m;
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    last = at + all.length;
    if (href !== undefined) {
      if (bang && IMAGE.test(href)) out.push(<img src={href} alt={label ?? ""} />);
      else if (!bang && !UNSAFE.test(href))
        out.push(
          <a href={href} target="_blank" rel="noopener noreferrer">
            {inline(label ?? "")}
          </a>,
        );
      else out.push(all);
    } else if (bold !== undefined) out.push(<strong>{inline(bold)}</strong>);
    else if (star !== undefined || under !== undefined)
      out.push(<em>{inline(star ?? under ?? "")}</em>);
    else if (bare !== undefined)
      out.push(
        <a href={bare} target="_blank" rel="noopener noreferrer">
          {bare}
        </a>,
      );
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { t: "h"; level: 1 | 2 | 3; text: string }
  | { t: "ul" | "ol"; items: { text: string; check: boolean | null }[] }
  | { t: "p"; lines: string[] };

function blocks(src: string): Block[] {
  const out: Block[] = [];
  for (const line of src.replace(/\r\n?/g, "\n").split("\n")) {
    const prev = out.at(-1);
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
    const number = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (line.trim() === "") out.push({ t: "p", lines: [] });
    else if (heading)
      out.push({
        t: "h",
        level: (heading[1] as string).length as 1 | 2 | 3,
        text: heading[2] ?? "",
      });
    else if (bullet) {
      const item = {
        text: bullet[2] ?? "",
        check: bullet[1] === undefined ? null : bullet[1] !== " ",
      };
      if (prev?.t === "ul") prev.items.push(item);
      else out.push({ t: "ul", items: [item] });
    } else if (number) {
      const item = { text: number[1] ?? "", check: null };
      if (prev?.t === "ol") prev.items.push(item);
      else out.push({ t: "ol", items: [item] });
    } else if (prev?.t === "p") prev.lines.push(line);
    else out.push({ t: "p", lines: [line] });
  }
  return out.filter((b) => b.t !== "p" || b.lines.length > 0);
}

/** The user's notes in a managed event description: without the tip, planner link and footer. */
export function notesOf(description: string): string {
  return description
    .split("\n")
    .filter((l) => !/^(Open in Tempoloom: |Tempoloom tip: |Planned by Tempoloom\.$)/.test(l.trim()))
    .join("\n")
    .trim();
}

/** Renders the notes of an event; nothing when it has none. */
export function Markdown({ text }: { text: string }) {
  const notes = notesOf(text);
  if (!notes) return null;
  return (
    <div class="md" data-testid="event-notes">
      {blocks(notes).map((b, i) => {
        if (b.t === "h") {
          const H = `h${b.level + 2}` as "h3" | "h4" | "h5";
          return <H key={i}>{inline(b.text)}</H>;
        }
        if (b.t === "p")
          return (
            <p key={i}>
              {b.lines.flatMap((l, j) => (j === 0 ? inline(l) : [<br key={j} />, ...inline(l)]))}
            </p>
          );
        const List = b.t;
        return (
          <List key={i}>
            {b.items.map((it, j) => (
              <li key={j}>
                {it.check === null ? (
                  inline(it.text)
                ) : (
                  <label>
                    <input type="checkbox" checked={it.check} disabled /> {inline(it.text)}
                  </label>
                )}
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
