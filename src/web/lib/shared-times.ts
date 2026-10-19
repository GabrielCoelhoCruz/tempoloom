// Shared times: chosen offered times of a link as HTML and plain text for a
// message (docs/specs/booking-links-sharing.md rules 18-22).
import { utcToLocal } from "../../shared/time.ts";
import { pad } from "./format.ts";
import { timeText, type View } from "./zoned.ts";

export const DEFAULT_TEMPLATE =
  "Here are some times that work for me ({timezone}):\n{times}\nOr pick another time: {link}";

export interface SharedTimesInput {
  times: { start: number; end: number }[];
  zone: string;
  format: View["format"];
  style: "buttons" | "text";
  /** Start and end instead of the start only. */
  showRanges: boolean;
  /** Text format: each time links to the booking page. */
  includeLinks: boolean;
  template: string;
  bookingUrl: string;
  /** The duration of the times, for the links and `{duration}`. */
  duration: number;
  /** The date heading of a time, in the zone. */
  dayLabel: (t: number) => string;
}

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
const attr = (s: string) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

const BUTTON =
  "display:inline-block;margin:2px 4px 2px 0;padding:6px 12px;border:1px solid #3b6fd8;border-radius:6px;color:#3b6fd8;text-decoration:none";

/** The booking page on one time: the URL parameters of booking page rule 9. */
export function timeLink(i: SharedTimesInput, start: number): string {
  const l = utcToLocal(i.zone, start);
  const q = new URLSearchParams({
    day: l.date,
    time: `${pad(Math.floor(l.minuteOfDay / 60))}:${pad(l.minuteOfDay % 60)}`,
    duration: String(i.duration),
    tz: i.zone,
  });
  return `${i.bookingUrl}?${q.toString().replaceAll("%3A", ":")}`;
}

export function sharedTimes(i: SharedTimesInput): { html: string; text: string } {
  const view: View = { zone: i.zone, format: i.format };
  const sorted = [...i.times].sort((a, b) => a.start - b.start);
  const days = new Map<string, { start: number; end: number }[]>();
  for (const t of sorted) {
    const d = utcToLocal(i.zone, t.start).date;
    days.set(d, [...(days.get(d) ?? []), t]);
  }
  const linked = i.style === "buttons" || i.includeLinks;
  // Rule 19: plain ranges merge when one ends where the next starts.
  const merge = i.style === "text" && i.showRanges && !i.includeLinks;
  const label = (t: { start: number; end: number }) =>
    i.showRanges ? `${timeText(view, t.start)}–${timeText(view, t.end)}` : timeText(view, t.start);
  const htmlLines: string[] = [];
  const textLines: string[] = [];
  for (const list of days.values()) {
    const items: { start: number; end: number }[] = [];
    for (const t of list) {
      const last = items.at(-1);
      if (merge && last && last.end === t.start) last.end = t.end;
      else items.push({ ...t });
    }
    const heading = i.dayLabel(items[0]?.start ?? 0);
    const html = items.map((t) =>
      linked
        ? `<a href="${attr(timeLink(i, t.start))}"${i.style === "buttons" ? ` style="${BUTTON}"` : ""}>${esc(label(t))}</a>`
        : esc(label(t)),
    );
    const text = items.map((t) => (linked ? `${label(t)} (${timeLink(i, t.start)})` : label(t)));
    htmlLines.push(
      i.style === "buttons"
        ? `<p><strong>${esc(heading)}</strong><br>${html.join(" ")}</p>`
        : `<p><strong>${esc(heading)}</strong>: ${html.join(", ")}</p>`,
    );
    textLines.push(`${heading}: ${text.join(", ")}`);
  }
  const vars = (s: string, times: string, link: string) =>
    s
      .replaceAll("{timezone}", i.zone)
      .replaceAll("{duration}", `${i.duration} minutes`)
      .replaceAll("{link}", link)
      .replaceAll("{times}", times);
  const text = vars(i.template, textLines.join("\n"), i.bookingUrl);
  // The template is text: escape it, then put in the HTML of the times and the link.
  const html = i.template
    .split("\n")
    .map((line) =>
      line.trim() === "{times}"
        ? htmlLines.join("")
        : `<p>${vars(esc(line), htmlLines.join(""), `<a href="${attr(i.bookingUrl)}">${esc(i.bookingUrl)}</a>`)}</p>`,
    )
    .join("");
  return { html, text };
}
