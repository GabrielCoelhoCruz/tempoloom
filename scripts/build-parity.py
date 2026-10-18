#!/usr/bin/env python3
"""Builds docs/parity.md from docs/parity-src/ (one row file per spec group)
and the status map below. Run: python3 scripts/build-parity.py

Status rules:
  done     = implemented AND a passing Google Calendar E2E test (none yet).
  partial  = implemented; proof is a passing CalDAV E2E (named) or unit tests.
  blocked  = not implemented yet, or a non-goal; the reason says which.
"""
import re, sys, glob, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
STAGING = os.path.join(ROOT, "docs/parity-src")
OUT = os.path.join(ROOT, "docs/parity.md")

T = {
    "split": "places a split task in work hours and keeps it after reload and restart",
    "meeting": "moves a chunk away from a new meeting and never touches the meeting",
    "drag": "a drag in the planner moves the chunk and locks it there",
    "done": "mark done removes future chunks; delete removes the task",
    "later": "deleting a chunk in the calendar places the work again later",
    "habit": "a habit sits at its ideal time each weekday and moves when blocked",
    "buffer": "a recovery buffer follows a meeting with attendees",
    "focus": "focus time fills the weekly goal within daily limits",
    "t_title": "a task with only a title gets P2, a due date in 3 days and work-hour chunks",
    "t_prio": "a P1 task takes the first free slot ahead of a P4 task, and due dates order one level",
    "t_start": "start after delays the first chunk",
    "t_next": "a next-up task goes before other tasks of any level",
    "t_late": "work that misses its due date goes late, turns busy and shows why",
    "t_free": "a chunk with room to spare stays free; the last chance turns busy",
    "t_more": "add time places more work and reopens a done task; filters show each state",
    "t_huge": "a chunk too long for any hours range is not placed and shows the reason",
    "t_notes": "task notes go into the event description",
    "t_personal": "a task on personal hours is placed in the evening",
    "c_invite": "unanswered and declined invitations do not block; accepted ones do",
    "c_allday": "free events do not block; a busy all-day event blocks its whole day",
    "c_tags": "#tl_free opens busy time to tasks; #tl_busy closes free time",
    "c_move": "moving a chunk in the calendar locks it there; the planner shows the lock",
    "c_lock": "lock and unlock from the planner details panel",
    "c_title": "a title edit of a chunk in the calendar is put back",
    "c_second": "a second calendar blocks time only when it counts for availability",
    "h_weekly": "a weekly habit uses its days, its notes, and always-busy defense",
    "h_free": "an always-free habit stays transparent",
    "h_skip": "skip removes one day; a calendar delete finds another time; a calendar move locks",
    "h_off": "turning a habit off removes its future events, on brings them back, delete removes it",
    "h_conflict": "with no room, one habit is kept as a marked conflict and another is removed",
    "h_words": "keywords skip days with a matching event; a start date delays the first day",
    "s_hours": "editing work hours moves existing events into the new hours",
    "s_custom": "a custom hours set can hold a task",
    "s_window": "a shorter planning window leaves later work unplaced, with the reason",
    "s_pause": "pausing stops new placements; resuming plans again",
    "s_break": "a break keeps a gap between task and habit events",
    "s_focus": "work habits count toward focus time; a deleted focus block is not reused",
    "s_prep": "a prep buffer sits before a meeting but not between back-to-back meetings",
    "s_zone": "changing the time zone moves the work day",
    "b_book": "a visitor books a time without signing in; the event lands on the calendar and a task moves away",
    "b_prio": "link priority decides which managed time it offers",
    "b_limit": "a daily limit closes the day after one booking; a hidden link is unlisted but works",
    "b_resched": "the visitor reschedules and then cancels from the manage page",
}

# Row id -> E2E test keys that prove it on CalDAV.
E2E = {
    1: ["t_title"], 4: ["split"], 7: ["split", "t_title"], 8: ["split"], 10: ["t_title", "t_prio"], 11: ["t_title"],
    12: ["t_start"], 13: ["t_late"], 15: ["t_notes"], 20: ["t_more"], 21: ["t_huge", "t_late"], 22: ["done", "t_more"],
    23: ["t_more"], 24: ["done"], 41: ["t_next"], 44: ["t_next"], 52: ["t_prio"], 53: ["t_prio"], 57: ["t_prio"],
    69: ["split", "s_hours"], 71: ["t_personal"], 72: ["s_custom"], 74: ["s_hours"], 81: ["s_window"], 83: ["s_window"],
    84: ["meeting"], 85: ["t_more", "s_hours"], 86: ["c_invite"], 87: ["c_allday"], 88: ["c_allday"], 89: ["c_tags"],
    91: ["t_huge"], 94: ["h_conflict"], 95: ["t_free"], 96: ["t_free"], 97: ["t_free", "t_late"], 98: ["h_weekly", "h_free"],
    101: ["h_weekly"], 103: ["drag", "c_lock"], 104: ["c_lock"], 105: ["drag", "c_move"], 108: ["c_move"], 113: ["later"],
    115: ["later"], 116: ["h_skip"], 117: ["s_focus"], 119: ["c_title"], 120: ["drag"], 125: ["c_lock"], 126: ["drag"],
    142: ["h_off"], 143: ["s_pause"], 148: ["habit", "h_weekly"], 151: ["h_weekly"], 155: ["habit"], 157: ["h_weekly"],
    158: ["habit", "h_weekly"], 159: ["h_words"], 160: ["h_conflict"], 162: ["h_weekly"], 164: ["h_weekly", "h_free"],
    168: ["h_words"], 176: ["habit"], 177: ["habit"], 179: ["h_skip"], 180: ["h_skip"], 181: ["h_skip"], 186: ["h_off"],
    188: ["h_off"], 194: ["focus", "s_focus"], 195: ["focus"], 204: ["s_focus"], 207: ["s_focus"], 220: ["s_prep"],
    229: ["s_prep", "buffer"], 230: ["buffer"], 231: ["s_prep"], 233: ["buffer"], 247: ["s_break"], 248: ["c_tags"],
    252: ["c_tags"], 270: ["s_zone"], 286: ["drag", "t_late", "t_free", "h_weekly"], 288: ["h_conflict"],
    496: ["c_second"], 497: ["c_second"], 503: ["c_second"], 504: ["split", "c_second"],
    379: ["b_book"], 380: ["b_book"], 381: ["b_book"], 382: ["b_book"], 386: ["b_book"], 387: ["b_prio"],
    391: ["b_limit"], 397: ["b_limit"], 399: ["b_book"], 400: ["b_book"], 402: ["b_resched"], 403: ["b_resched"],
    404: ["b_book"], 406: ["b_prio"], 409: ["b_prio", "b_limit"], 410: ["b_book"], 414: ["b_book"], 421: ["b_book", "b_resched"],
}

# Row id -> limits, for rows implemented with unit or property tests only.
UNIT = {
    9: "cooldown options are in the engine and settings, not in the UI", 27: "API only; no UI yet",
    55: "engine only; no drag UI yet", 58: "", 59: "booking-link side not implemented", 70: "",
    73: "several ranges per day; no copy-to-all", 90: "flexible meetings not implemented",
    100: "", 109: "", 152: "engine only", 154: "", 156: "daily and weekly; monthly and custom not implemented",
    161: "", 165: "", 178: "", 196: "", 197: "", 202: "", 203: "", 206: "", 208: "", 209: "", 219: "",
    221: "text, count, length, exact title and tag; no attendee or category filters", 225: "", 226: "API only",
    228: "", 249: "tasks and habits honor it; meetings and booking links not implemented",
    259: "title and description; not the RSVP note", 292: "settings field; no UI yet", 506: "API only",
    517: "status is stored; no reconnect UI yet",
    383: "set through the API; the form derives the slug from the title", 384: "several durations work; the default is the first",
    388: "", 389: "rolling days only; no fixed end date", 390: "before and after buffers; no travel or recovery buffer checks",
    392: "a free-text location only; no Meet, Zoom or Gong", 398: "busy event with the booker as guest and manage link; no conference link",
    408: "", 411: "", 412: "the page marks preferred times; no legend yet", 415: "",
    420: "name, email and message; no CC, questions or location choice",
}

GOOGLE_ROWS = {
    510: "Google sign-in (OAuth with PKCE) and Google Calendar sync are implemented; Google E2E pending: needs a service-account key, and the consent screen needs a one-time check by a person. Microsoft is not implemented.",
    513: "Google and CalDAV accounts can be connected; adding a second account in the UI and Microsoft are not implemented. Google E2E pending.",
    147: "Google sign-in asks for calendar scopes up front; incremental consent not implemented. Google E2E pending.",
    518: "All calendar scopes are asked at sign-in; incremental consent not implemented. Google E2E pending.",
}

GOOGLE_PENDING = "Google E2E pending: the service-account key is not available yet (1Password token missing)."

def status(row_id, spec_file, notes):
    if row_id in E2E:
        tests = "; ".join(f"\u201c{T[k]}\u201d" for k in E2E[row_id])
        return "done (CalDAV)", f"Full UI E2E passes on CalDAV (Radicale): {tests}. Google Calendar run pending (service-account key)."
    if row_id in GOOGLE_ROWS:
        return "partial", GOOGLE_ROWS[row_id]
    if row_id in UNIT:
        extra = UNIT[row_id]
        return "partial", "Implemented; unit or property tests only, no E2E yet." + (f" Limits: {extra}." if extra else "")
    if "non-goal" in notes.lower():
        return "blocked", "Non-goal by decision (billing, payments or mobile apps)."
    if spec_file.startswith("integrations-"):
        return "blocked", "Not implemented yet; needs the vendor's developer app and a test account."
    return "blocked", "Not implemented yet."

def main():
    files = sorted(glob.glob(f"{STAGING}/parity-[A-F]-*.md"))
    rows, n = [], 0
    for f in files:
        group = re.sub(r"^parity-|\.md$", "", os.path.basename(f))
        for line in open(f, encoding="utf8"):
            if not line.startswith("| ") or line.startswith("| Feature"):
                continue
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if len(cells) < 4:
                continue
            n += 1
            feature, evidence, spec, notes = cells[0], cells[1], cells[2], cells[3]
            spec_file = re.sub(r"#.*", "", spec).strip()
            st, why = status(n, spec_file, notes)
            if notes and notes.lower() not in ("", "-"):
                why += f" Reference note: {notes}."
            link = spec
            if spec_file.endswith(".md"):
                link = f"[{spec}](specs/{spec.replace(' ', '')})"
            rows.append((group, n, feature, evidence, link, st, why))
    counts = {"done (CalDAV)": 0, "partial": 0, "blocked": 0}
    for r in rows:
        counts[r[5]] += 1
    header = open(f"{STAGING}/parity-header.md", encoding="utf8").read().rstrip()
    out = [header, "", "## Summary", "",
           f"- Rows: {len(rows)}",
           f"- done (CalDAV): {counts['done (CalDAV)']}",
           "- done (Google): 0",
           f"- partial: {counts['partial']}",
           f"- blocked: {counts['blocked']}", "",
           "\"done (CalDAV)\" means a full UI E2E test passes against a real CalDAV server (Radicale in a",
           "loopback container): Playwright drives the Tempoloom UI, the real API and scheduler write to the",
           "calendar, and the test checks the calendar, a page reload and persistence. The suite runs in CI",
           "on every push. No row is done on Google Calendar yet: that run needs a service-account key.",
           "",
           "Evidence basis: every row comes from public evidence only (marketing pages and help docs). No",
           "logged-in observation of the reference product was made, so behavior that only a logged-in",
           "account shows (exact defaults, API shapes, current-version details) is \"public-evidence only\";",
           "the open questions in each spec list what is unknown.", ""]
    names = {
        "A-core-planning": "Core planning", "B-habits-focus-buffers": "Habits, focus time and buffers",
        "C-meetings-links": "Flexible meetings and booking links", "D-sync-accounts": "Calendar mirroring and accounts",
        "E-team-analytics-ai": "Teams, analytics and assistant", "F-integrations": "Integrations",
    }
    current = None
    for g, n, feat, ev, link, st, why in rows:
        if g != current:
            current = g
            out += ["", f"## {names.get(g, g)}", "",
                    "| # | Feature | Evidence (public-evidence only) | Spec | Status | Proof or reason |",
                    "|---|---|---|---|---|---|"]
        out.append(f"| {n} | {feat} | {ev} | {link} | {st} | {why} |")
    out += ["", "## Beyond the reference product", "",
            "| # | Feature | Evidence | Spec | Status | Proof or reason |", "|---|---|---|---|---|---|",
            "| X1 | Sign in with a CalDAV account (Radicale, Nextcloud, Fastmail) | none | [accounts-login-emails-permissions.md](specs/accounts-login-emails-permissions.md) | partial | CalDAV E2E passes: “signs in with CalDAV, rejects a wrong password, and keeps the session”. Not a reference feature, so no Google E2E applies. |",
            "| X2 | Self-hosting with one process and one SQLite file, Docker image | none | [../adr/0001-stack.md](adr/0001-stack.md) | partial | Docker image builds; no deployment test yet. |"]
    open(OUT, "w", encoding="utf8").write("\n".join(out) + "\n")
    print(len(rows), counts)

if __name__ == "__main__":
    main()
