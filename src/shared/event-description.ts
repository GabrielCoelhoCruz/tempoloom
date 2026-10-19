// Turns a short plain-language description of events into buffer filter
// conditions (docs/specs/buffers-automation.md rule 4). No language model:
// a small fixed grammar, documented in the spec. Words it does not know are
// returned, so the form can name them.
import type { Category } from "../scheduler/categories.ts";
import type { BufferFilter } from "../scheduler/model.ts";

export type DescribedFilter = Omit<BufferFilter, "travel" | "flight"> & {
  travel?: boolean;
  flight?: boolean;
};

const PEOPLE = "(?:people|persons|attendees|guests|participants)";
const DURATION = String.raw`(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h)\b`;
const ADDRESS = String.raw`(?:anyone\s+at\s+)?([^\s,;"]*@[^\s,;"]+)`;
const QUOTE = "\uE000(\\d+)\uE001";

type Apply = (m: RegExpExecArray, f: DescribedFilter, quoted: string[]) => void;

const minutes = (n: string, unit: string) =>
  Math.round(Number(n) * (unit.toLowerCase().startsWith("h") ? 60 : 1));
const count =
  (op: NonNullable<BufferFilter["participants"]>["op"]): Apply =>
  (m, f) => {
    f.participants = { op, value: Number(m[1]) };
  };
const length =
  (op: NonNullable<BufferFilter["length"]>["op"]): Apply =>
  (m, f) => {
    f.length = { op, minutes: minutes(m[1] ?? "0", m[2] ?? "m") };
  };
const category =
  (c: Category): Apply =>
  (_m, f) => {
    f.categories = [...(f.categories ?? []).filter((x) => x !== c), c];
  };

/** Tried in this order at each position; the first match wins. */
const RULES: [RegExp, Apply][] = [
  [
    new RegExp(
      String.raw`(?:back-to-back\s+(?:meetings\s+|events\s+)?|runs?\s+of\s+(?:meetings|events)\s+)(?:runs?\s+)?longer\s+than\s+${DURATION}(?:\s+in\s+a\s+row)?`,
      "iy",
    ),
    (m, f) => {
      f.runLongerThanMinutes = minutes(m[1] ?? "0", m[2] ?? "m");
    },
  ],
  [
    new RegExp(String.raw`with\s+${ADDRESS}((?:\s*(?:,|\bor\b|\band\b)\s*${ADDRESS})*)`, "iy"),
    (m, f) => {
      const all = m[0].match(/[^\s,;"]*@[^\s,;"]+/g) ?? [];
      f.people = [...(f.people ?? []), ...all.map((p) => p.toLowerCase())];
    },
  ],
  [new RegExp(String.raw`(?:with\s+)?(\d+)\s+or\s+more\s+${PEOPLE}`, "iy"), count(">=")],
  [new RegExp(String.raw`(?:with\s+)?(\d+)\s+or\s+(?:fewer|less)\s+${PEOPLE}`, "iy"), count("<=")],
  [new RegExp(String.raw`(?:with\s+)?at\s+least\s+(\d+)\s+${PEOPLE}`, "iy"), count(">=")],
  [new RegExp(String.raw`(?:with\s+)?at\s+most\s+(\d+)\s+${PEOPLE}`, "iy"), count("<=")],
  [new RegExp(String.raw`(?:with\s+)?more\s+than\s+(\d+)\s+${PEOPLE}`, "iy"), count(">")],
  [new RegExp(String.raw`(?:with\s+)?(?:fewer|less)\s+than\s+(\d+)\s+${PEOPLE}`, "iy"), count("<")],
  [new RegExp(String.raw`(?:with\s+)?(?:exactly\s+)?(\d+)\s+${PEOPLE}`, "iy"), count("=")],
  [new RegExp(String.raw`(?:longer|more)\s+than\s+${DURATION}`, "iy"), length(">")],
  [new RegExp(String.raw`(?:shorter|less)\s+than\s+${DURATION}`, "iy"), length("<")],
  [new RegExp(String.raw`at\s+least\s+${DURATION}`, "iy"), length(">=")],
  [new RegExp(String.raw`at\s+most\s+${DURATION}`, "iy"), length("<=")],
  [new RegExp(String.raw`(?:lasting|exactly|of)\s+${DURATION}`, "iy"), length("=")],
  [
    new RegExp(String.raw`(?:titled|called|named)\s+${QUOTE}`, "iy"),
    (m, f, q) => {
      f.exactTitle = q[Number(m[1])] ?? "";
    },
  ],
  [
    new RegExp(String.raw`(?:containing|with)\s+${QUOTE}(?:\s+in\s+the\s+title)?`, "iy"),
    (m, f, q) => {
      f.text = { values: [...(f.text?.values ?? []), q[Number(m[1])] ?? ""], fields: ["title"] };
    },
  ],
  [
    new RegExp(String.raw`mentioning\s+${QUOTE}`, "iy"),
    (m, f, q) => {
      f.text = {
        values: [...(f.text?.values ?? []), q[Number(m[1])] ?? ""],
        fields: ["title", "description", "location"],
      };
    },
  ],
  [
    /(?:(?:tagged|with)\s+)?(#\w+)((?:\s*(?:,|\bor\b|\band\b)\s*#\w+)*)/iy,
    (m, f) => {
      f.tags = [...(f.tags ?? []), ...(m[0].match(/#\w+/g) ?? [])];
    },
  ],
  [
    /(?:at|with)\s+an?\s+(?:address|location)\b/iy,
    (_m, f) => {
      f.travel = true;
    },
  ],
  [
    /flights?\b/iy,
    (_m, f) => {
      f.flight = true;
    },
  ],
  [/external(?:\s+(?:meetings?|calls?|events?))?\b/iy, category("external_meeting")],
  [/(?:one-on-ones?|one\s+on\s+ones?|1:1s?)(?=\s|,|;|$)/iy, category("one_on_one")],
  [/team\s+(?:meetings?|calls?)\b/iy, category("team_meeting")],
  [/personal(?:\s+events?)?\b/iy, category("personal")],
];

const FILLER = /(?:meetings?|events?|calls?|appointments?|all|my|any|every|each|the)\b/iy;
const SEPARATOR = /(?:\s+|,|;|\band\b|\bor\b)+/iy;

/** The conditions a description names, and the words it could not read (or null). */
export function describeEvents(input: string): {
  filter: DescribedFilter;
  unknown: string | null;
} {
  const quoted: string[] = [];
  const text = input.replace(/["“”]([^"“”]*)["“”]/g, (_q, inner: string) => {
    quoted.push(inner);
    return `\uE000${quoted.length - 1}\uE001`;
  });
  const filter: DescribedFilter = {};
  const unknown: string[] = [];
  let pos = 0;
  const at = (re: RegExp) => {
    re.lastIndex = pos;
    return re.exec(text);
  };
  while (pos < text.length) {
    const sep = at(SEPARATOR);
    if (sep && sep[0].length > 0) {
      pos += sep[0].length;
      continue;
    }
    let matched = false;
    for (const [re, apply] of RULES) {
      const m = at(re);
      if (m) {
        apply(m, filter, quoted);
        pos += m[0].length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const filler = at(FILLER);
    if (filler) {
      pos += filler[0].length;
      continue;
    }
    const word = /[^\s,;]+/y;
    word.lastIndex = pos;
    const w = word.exec(text)?.[0] ?? text.slice(pos, pos + 1);
    unknown.push(w.replace(/\uE000(\d+)\uE001/g, (_x, n: string) => `"${quoted[Number(n)]}"`));
    pos += w.length;
  }
  return { filter, unknown: unknown.length > 0 ? unknown.join(" ") : null };
}
