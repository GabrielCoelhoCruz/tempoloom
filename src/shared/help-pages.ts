// The Tempoloom user documentation: the help pages
// (docs/specs/support-troubleshooting.md). The help view draws them, and
// assistant chat searches them to answer questions about Tempoloom
// (assistant-chat.md rule 10), so both use one text. A link in a text is
// written as [label](/path).

export type HelpBlock = { p: string } | { warning: string } | { ul: string[] } | { ol: string[] };

export interface HelpPage {
  title: string;
  body: HelpBlock[];
}

export const HELP_PAGES: Record<string, HelpPage> = {
  "meeting-not-placed": {
    title: "A flexible meeting is not placed",
    body: [
      {
        p: "Tempoloom places a flexible meeting only inside the meeting hours of every required guest who uses this server, and only where all of them are free.",
      },
      {
        ul: [
          "Open the planner: “items need attention” names the meeting and the reason.",
          "Make a guest optional, or widen the meeting hours, to give it more room.",
        ],
      },
    ],
  },
  "booked-guests": {
    title: "Guests do not see a booked meeting",
    body: [
      {
        p: "Google Calendar can keep invitations from unknown senders off a guest's calendar until the guest accepts by email, and the email can land in spam. Tempoloom does not answer the invitation for the guest.",
      },
      {
        ul: [
          "In Google Calendar settings, set the automatic adding of invitations to “from everyone”, and ask your guests to do the same.",
          "When Google shows an unknown-sender notice, mark the sender as known.",
          "The booking reminder email reaches guests even when the invitation is hidden.",
        ],
      },
    ],
  },
  "copies-missing": {
    title: "Copies are missing",
    body: [
      { p: "When an event on a source calendar has no copy, do these steps in order:" },
      {
        ol: [
          "Turn the mirroring off in [Calendar mirroring settings](/settings), wait a few minutes, and turn it on again. Then Tempoloom reads the source calendar again and writes each copy that is missing.",
          "If a copy is still missing, [look the event up](/help/lookup) and send its event link to the person who runs this server.",
        ],
      },
      {
        warning:
          "Do not turn mirroring off and on many times in a short time: your calendar provider can slow down your account when it gets many changes quickly.",
      },
    ],
  },
  "copies-twice": {
    title: "Copies appear twice",
    body: [
      { p: "Two mirrorings that copy the same source calendar to one calendar make two copies." },
      {
        ul: [
          "Open [Calendar mirroring settings](/settings) and delete one of them.",
          "Another tool that also copies events between these calendars makes copies too: turn it off.",
        ],
      },
    ],
  },
  "copies-details": {
    title: "Copies miss details",
    body: [
      {
        p: "A copy shows only what its mirroring allows: a label, “Busy”, or the title and description. To copy the details, change “Copies show” of the mirroring in [Calendar mirroring settings](/settings). Guests, alerts and attachments are never copied.",
      },
    ],
  },
  "focus-not-placed": {
    title: "Focus time is not placed",
    body: [
      {
        p: "Focus time fills its weekly goal inside your work hours, between the daily minimum and maximum, in blocks of the shortest and longest length you set. Meetings and items with a higher priority come first. Lower the goal or the shortest block to give it more room.",
      },
    ],
  },
  "task-not-placed": {
    title: "A task is not placed",
    body: [
      {
        p: "A task is placed between its start date and due date, inside its hours and the scheduling window. The task list and the planner's “items need attention” give the reason. A chunk longer than any free range of its hours cannot be placed.",
      },
    ],
  },
  "buffer-missing": {
    title: "A buffer does not appear",
    body: [
      {
        p: "A buffer follows only the events that match its filter, and it needs free time next to the event. When an item with a higher priority holds that time, the buffer is removed or kept as a conflict, as you chose.",
      },
    ],
  },
  colors: {
    title: "Colors do not show",
    body: [
      {
        p: "Tempoloom colors the events it manages by category. To color your other events too, choose “All events on my calendars” in [Settings](/settings). Outlook calendars may not show these colors.",
      },
    ],
  },
  "item-not-placed": {
    title: "An item does not get placed",
    body: [
      {
        p: "Open the planner: “items need attention” lists each item that has no place and the reason, for example no free time in its hours or a due date that is too close.",
      },
    ],
  },
  "wrong-hours": {
    title: "Events are placed at the wrong hours",
    body: [
      {
        p: "Check the time zone and the hours in [Settings](/settings). Each task, habit and focus goal uses one set of hours: work, personal, meeting or your own.",
      },
    ],
  },
  "apple-alerts": {
    title: "Alerts for copies on Apple devices",
    body: [
      {
        p: "Copies never alert: Tempoloom writes them without alerts. Apple Calendar can still alert, because its default alert time applies to events without alerts. On each device:",
      },
      {
        ol: [
          "In the device's calendar settings, set the default alert time for events to None.",
          "Turn off the calendar account on the device and delete its local data.",
          "Turn the calendar account on again and wait for the full download.",
        ],
      },
    ],
  },
  "events-come-back": {
    title: "Events come back after you delete them",
    body: [
      {
        p: "Tempoloom treats a deleted event as a skip for that time, and places the item at another time. To stop an item for good:",
      },
      {
        ul: [
          "Habit: delete the habit, or turn the habit off, on the [Habits](/habits) page.",
          "Focus time: turn focus time off by deleting its goal in [Settings](/settings).",
          "Task: delete it (Tempoloom removes all its events, past ones too), or mark it done (past events stay), on the [Tasks](/tasks) page.",
          "Mirrored copy: decline or delete the source event, or add #tl_nosync to its title or description.",
        ],
      },
    ],
  },
  "other-tools": {
    title: "Turn off other scheduling tools",
    body: [
      {
        p: "Before Tempoloom plans your week, turn off any other scheduling tool that creates events on the same calendars, such as another planner or a focus time app. Two tools that plan the same calendar create competing events and move each other's events.",
      },
    ],
  },
};

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/** The parts of a text: plain strings and links. */
export function helpInline(text: string): (string | { label: string; href: string })[] {
  const out: (string | { label: string; href: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ label: m[1] ?? "", href: m[2] ?? "" });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A page as plain text, links as "label (/path)". */
export function helpText(page: HelpPage): string {
  const plain = (t: string) => t.replace(LINK, "$1 ($2)");
  return page.body
    .map((b) =>
      "p" in b
        ? plain(b.p)
        : "warning" in b
          ? plain(b.warning)
          : ("ul" in b ? b.ul : b.ol)
              .map((x, i) => `${"ul" in b ? "-" : `${i + 1}.`} ${plain(x)}`)
              .join("\n"),
    )
    .join("\n");
}

/** Words that say nothing about a topic. */
const COMMON = new Set(
  "the and are but can could does doesn did for from get got has have how into its not now one our out should that the their them then there they this was what when where which who why will with would you your tempoloom".split(
    " ",
  ),
);

const words = (t: string) =>
  t
    .toLowerCase()
    .normalize("NFKD")
    .split(/[^\p{L}\p{N}#_]+/u)
    .filter((w) => w.length > 2 && !COMMON.has(w));

/** Each word's stem: a few English endings off, so "deleted" finds "delete". */
const stem = (w: string) => w.replace(/(ing|ed|es|s|e)$/, "") || w;

/**
 * The help pages that match a question, best first: a page scores by the
 * question's words found in it, a word in the title counts double. A page
 * must hold more than half of the question's words, so one common word (such
 * as "order") does not make an answer.
 */
export function searchHelp(
  query: string,
  limit = 3,
): { slug: string; title: string; text: string; score: number }[] {
  const asked = [...new Set(words(query).map(stem))];
  return Object.entries(HELP_PAGES)
    .map(([slug, page]) => {
      const title = new Set(words(page.title).map(stem));
      const body = new Set(words(helpText(page)).map(stem));
      const found = asked.filter((w) => title.has(w) || body.has(w));
      const score = found.reduce((s, w) => s + (title.has(w) ? 2 : 0) + (body.has(w) ? 1 : 0), 0);
      return { slug, title: page.title, text: helpText(page), score, found: found.length };
    })
    .filter((r) => r.found * 2 > asked.length)
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
    .slice(0, limit)
    .map(({ found: _, ...r }) => r);
}
