#!/usr/bin/env python3
"""Builds docs/parity.md from docs/parity-src/ (one row file per spec group)
and the status map below. Run: python3 scripts/build-parity.py

Status rules:
  done (CalDAV) = a full UI E2E test passes against a real CalDAV server (E2E map).
  partial       = implemented in part, or proven by unit tests only (PARTIAL, UNIT,
                  GOOGLE_ROWS); the reason says what is missing.
  blocked       = not implemented yet, or a non-goal; the reason says which.
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
    "m_follow": "copies follow the source: create, label, skip rules, move, delete, put back, turn off",
    "m_two": "details mode copies the title; two-way mirroring never copies a copy",
    "x_cost": "the meeting cost calculator computes, rejects bad input and resets",
    "x_timer": "the pomodoro timer runs sessions and breaks, counts them and keeps them after reload",
    "x_stats": "stats sum meetings, tasks and habits for a chosen range",
    "x_prio": "a lowered external event is offered only by higher-priority booking links",
    "x_travel": "travel time wraps events at an address; flights get airport time instead",
    "w_flow": "booking, reschedule and cancel send signed requests with custom data; a new secret signs the next one",
    "w_retry": "a failing receiver gets retries with one request id and Retry-After; too much custom data is dropped; removed and deleted endpoints stop",
    "m_sync": "a weekly meeting sits at the ideal time, moves around a colleague's busy time but not an unanswered invite, and moves the colleague's habit",
    "m_hours": "a colleague's meeting hours limit the time, a full slot shrinks to fit, optional guests do not count, and skip or delete drop one period",
    "lib_habit": "a habit entry fills the habit form; saving places it and shows Added; a second use gets a suffix; delete clears the badge",
    "lib_other": "buffer and focus entries add their automation as set; prompts offer no action",
    "c_paint": "managed events take their category color, a new color repaints them, and external events change color only for the scope all events",
    "c_buffer": "a buffer for external meetings adds prep before a meeting with another domain only",
    # Teams (tests/e2e/team.spec.ts, directory.spec.ts)
    "tm_invite": "an invitation by email adds an existing user at once and a new person after sign-up; members are refused",
    "tm_revoke": "a copied invite link works until it is revoked; a revoked link adds nobody",
    "tm_request": "a same-domain user asks to join; the admin approves with admin rights or rejects; other domains see nothing",
    "tm_auto": "automatic join adds a same-domain user at once with no review; invite only hides the team",
    "tm_leave": "the sole admin cannot leave or drop the admin role; a member leaves and keeps habits and events",
    "tm_roles": "an invitation can grant the admin role; an admin gives and removes the role and removes a member; members cannot; the seat bar frees a seat",
    "tm_perm": "team settings are for admins only; with invite permission for admins only a member cannot invite, with all members a member can",
    "tm_colleagues": "people of the same domain who are alone are offered for a new team, and each gets one invitation",
    "tm_seats": "over the seat limit, scheduling goes on but invitations stop",
    "dir_scim": "SCIM provisioning adds people with attributes and no seat until sign-in; updates and deactivation follow the directory",
    # Analytics (tests/e2e/team-stats.spec.ts, org-analytics.spec.ts)
    "an_team": "team stats show averages over the included members of last week, with no names, a time-in-meetings distribution, and no values for small teams",
    "an_future": "team stats for a future week count planned tasks, recovery buffers and travel, with each member's days and work hours in their own time zone",
    "an_org": "organization analytics group last week by department, manager line and person, filter by custom attributes, score focus and fragmentation, cost meetings, trend week over week and export CSV for admins only",
    "an_seat": "a future range counts planned breaks and travel; an analytics-only member is counted but the scheduler never changes their calendar",
    # SSO and provisioning (tests/e2e/sso.spec.ts, grant.spec.ts)
    "sso_only": "SSO only: people on the team's domain sign in through its identity provider, other sign-ins point them to SSO, and people outside the team keep theirs",
    "sso_capture": "SSO and other sign-in, with domain capture: members use either, new sign-ups on the domain join the team, others keep their own team",
    "grant_read": "Calendar access attaches each provisioned person's calendar read-only, reads it on a slow cycle until first sign-in and in real time after it, and writes nothing before it",
    "prov_api": "The admin provisioning API adds a large import at a paced rate, with attributes and calendars through the grant; only team admins can use it",
    # Team defaults, out-of-office calendars, no-meeting days (team-defaults, ooo-calendar, no-meeting specs)
    "tpl_defaults": "default work and meeting hours go to people who join after the admin saves them; existing members and later changes keep their hours",
    "tpl_focus": "a new member sees the team's habit templates while joining and takes the focus recommendation with a changed goal; existing members see none",
    "tpl_habits": "team habit templates show at the top of every member's habits page; edits and deletes never change habits made from them; only admins manage them",
    "ooo_copy": "participants come from write access to the shared calendar; a teammate who joins later is enrolled; a full-day absence is copied and follows moves and deletes",
    "ooo_partial": "partial-day absences keep exact times until the admin switches to all-day; all-day busy events count only from the switch on; two calendars get a copy each; the person's managed events move off the time away",
    "ooo_perm": "members add out-of-office calendars while the team allows it; after an admin switches it off only admins can",
    "nm_self": "a #tl_free block keeps habits but not the organizer's flexible meetings or any booking link, even at a lowered priority",
    "nm_team": "a team no-meeting day invitation counts for each invitee who answers yes or maybe, not for an unanswered one",
    "org_cover": "organization analytics count a provisioned person who never signed in, through the calendar access, without writing to their calendar",
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
    449: ["m_follow"], 459: ["m_two"], 463: ["m_two"], 464: ["m_follow"], 466: ["m_follow"], 474: ["m_follow"],
    477: ["m_two"], 483: ["m_follow"], 486: ["m_follow"], 487: ["m_follow"], 488: ["m_follow"], 498: ["m_follow"],
    462: ["m_follow"], 503: ["c_second", "m_follow"],
    597: ["x_stats"], 598: ["x_stats"], 599: ["x_stats"], 600: ["x_stats"], 601: ["x_stats"], 602: ["x_stats"],
    701: ["x_timer"], 702: ["x_timer"], 703: ["x_timer"], 705: ["x_timer"], 706: ["x_timer"], 707: ["x_timer"],
    711: ["x_timer"], 714: ["x_cost"], 715: ["x_cost"], 716: ["x_cost"],
    294: ["x_prio"], 295: ["x_prio"], 296: ["x_prio"], 237: ["x_travel"], 239: ["x_travel"], 240: ["x_travel"],
    241: ["x_travel"], 407: ["x_prio"],
    405: ["w_flow"], 931: ["w_flow", "w_retry"], 932: ["w_flow", "w_retry"], 933: ["w_retry"], 935: ["w_flow"],
    937: ["w_retry"], 939: ["w_retry"], 940: ["w_flow"], 941: ["w_flow", "w_retry"], 942: ["w_flow"],
    943: ["w_flow", "w_retry"],
    321: ["m_sync"], 323: ["m_sync"], 325: ["m_sync"], 329: ["m_sync"], 330: ["m_hours"], 335: ["m_sync"],
    337: ["m_sync"], 338: ["m_sync"], 348: ["m_sync"], 351: ["m_sync", "m_hours"], 354: ["m_sync", "m_hours"],
    363: ["m_sync"], 366: ["m_hours"], 371: ["m_sync"],
    149: ["lib_habit"], 717: ["lib_habit", "lib_other"], 721: ["lib_other"], 743: ["lib_other"],
    275: ["c_paint", "c_buffer"], 277: ["c_paint"], 279: ["c_paint"], 280: ["c_paint"], 281: ["c_paint"],
    731: ["c_buffer"],
    260: ["c_allday"], 264: ["c_allday"], 267: ["c_allday"],
    54: ["b_book"], 62: ["b_prio"], 258: ["m_follow"],
    # Teams
    546: ["tm_invite", "tm_colleagues"], 547: ["tm_colleagues"], 548: ["tm_invite", "tm_roles"],
    549: ["tm_revoke"], 550: ["tm_revoke"], 551: ["tm_invite"], 552: ["tm_request"], 553: ["tm_auto"],
    554: ["tm_request", "tm_auto"], 555: ["tm_leave"], 556: ["tm_roles"], 557: ["tm_roles", "tm_leave"],
    558: ["tm_roles", "tm_seats"], 559: ["tm_seats"], 560: ["tm_seats"], 561: ["tm_invite", "tm_seats"],
    562: ["tm_perm", "tm_roles"], 563: ["tm_perm"], 642: ["dir_scim"], 646: ["dir_scim"],
    # Analytics
    596: ["an_team"], 613: ["an_team"], 614: ["an_team"], 615: ["an_future"], 616: ["an_org"],
    617: ["an_org"], 618: ["an_org"], 619: ["an_org"], 620: ["an_org"], 621: ["an_org"], 622: ["an_org"],
    623: ["an_org", "an_future"], 624: ["an_org"], 625: ["an_seat", "an_future"], 626: ["an_org"],
    629: ["an_seat"], 218: ["an_org"],
    # SSO and provisioning
    639: ["sso_only"], 640: ["sso_only", "sso_capture"], 641: ["sso_only", "sso_capture"],
    643: ["sso_capture"], 647: ["prov_api"], 648: ["prov_api"],
    # Team defaults, out-of-office calendars, no-meeting days
    192: ["tpl_habits"], 564: ["tpl_habits", "tpl_focus"], 565: ["tpl_defaults"], 215: ["tpl_focus"],
    566: ["tpl_focus", "tpl_defaults"], 567: ["tpl_defaults", "tpl_focus"], 269: ["ooo_copy"],
    573: ["ooo_copy"], 574: ["ooo_copy"], 575: ["ooo_copy"], 583: ["ooo_copy"], 576: ["ooo_partial"],
    577: ["ooo_partial"], 579: ["ooo_partial"], 580: ["ooo_partial"], 578: ["ooo_perm"],
    249: ["nm_self"], 251: ["nm_team"], 628: ["org_cover", "grant_read"],
}

# Row id -> how Tempoloom meets the row, when that differs from the reference's wording.
E2E_NOTES = {
    559: "Buying seats is a non-goal; the operator sets the limit with the CLI (seat-limit)",
    560: "No tiers: the operator sets a team's most members with the CLI, or TEAM_SEAT_LIMIT for all teams",
    561: "No tier gate by design (teams-membership.md rule 11); the seat limit is the only gate",
    619: "The score uses the spec's proposed formula; no public benchmark data exists, and the page says so",
    629: "The spec's proposed meaning: the calendar counts in analytics and the scheduler never changes it",
    639: "Proven with Dex, a real OpenID Connect provider on loopback, through its own login page",
    640: "The other sign-in methods are Google and CalDAV; SSO-only refuses both for the team's domains",
    648: "The API uses the team admin's session (no API keys exist yet)",
    566: "Proactive mode only: Tempoloom has no reactive focus mode",
    574: "Write access is read from the CalDAV privilege set; CalDAV has no groups to expand, and Google calendar access lists are not read",
    583: "Marketing-only in the reference; built: a teammate with write access who joins later takes part with no setup",
    269: "On CalDAV, an out-of-office event carries X-MICROSOFT-CDO-BUSYSTATUS:OOF",
    628: "The organization calendar access is a CalDAV account that reads every person's calendars; the 24-hour refresh is a setting (GRANT_REFRESH_SECONDS), 30 seconds in the test",
}

# Row id -> reason, for rows implemented in part (some behavior has E2E, some does not).
PARTIAL = {
    930: "Endpoints are per user, on the Booking links page, with E2E on CalDAV (\u201cbooking, reschedule and cancel send signed requests\u201d); teams and the admin role are not implemented",
    571: "A per-user webhooks section on the Booking links page; no team settings page yet",
    934: "http on a public host is rejected in E2E; the localhost and IP-literal checks are in code but not under E2E, because the E2E server allows private receivers (WEBHOOK_ALLOW_PRIVATE)",
    936: "success on 200 and failure on 500 are E2E-proven; the 10-second timeout is not under test",
    938: "the delivery worker suspends the endpoint and the page offers Resume; not under test (needs 24 hours of failures)",
    320: "A meeting is created from a form, with E2E on CalDAV; each occurrence is its own event, not an instance of one recurring series",
    322: "Availability of attendees who are users here is E2E-proven on CalDAV; the Google free/busy query for other emails is not implemented",
    324: "Optional guests are written with the optional role and never limit the time (E2E); the E2E optional guest is not a user here",
    328: "Every day, every week and every N weeks; no monthly or custom day counts. E2E covers weekly",
    331: "Everyone's meeting hours (E2E) and the organizer's hours only (not under E2E); no item-specific hours",
    332: "A start date delays the first occurrence; unit tests only",
    333: "P1 to P4 with P2 by default; displacement by level has unit tests only",
    334: "A rank is stored per level and orders placement; no reorder in the UI",
    336: "Meetings are placed before focus time by the engine order; unit tests only",
    339: "The common time of the organizer's and a colleague's meeting hours is E2E-proven; both use one time zone in the test",
    341: "Adaptive (default), busy and free; a far occurrence is written free in E2E; the switch to busy has unit tests only",
    342: "Busy or free only; no visibility or reminder settings",
    343: "The description is written to every occurrence; not under E2E",
    345: "A text location only; no conference link or room",
    346: "Occurrences go to the organizer's main calendar only",
    349: "The list is grouped by priority; no drag to reorder",
    350: "No limit in code; not under test",
    356: "Changed rules or hours place future occurrences again (engine change flag); unit tests only",
    357: "A move keeps the notice set on the meeting (default 12 hours); unit tests only",
    359: "A conflict is marked and listed with its reason on the meeting; no suggested times",
    360: "Remove, or keep and mark the conflict (default); unit tests only",
    364: "A resize in the calendar locks like a move; not under E2E for meetings",
    367: "The planner drawer locks and unlocks any managed event (E2E for task chunks); not under E2E for meetings",
    368: "A time edit in the calendar is kept and locks (E2E); free/busy is written back by the general drift rule, not under E2E for meetings",
    372: "Delete removes future occurrences and the rules; no choice about guest notices",
    374: "Unplaced and conflicting occurrences show their reason on the meeting; no shared attention list",
    764: "E2E adds Lunch at 12:00 on each workday from the library; the 11:30 to 14:00 window is not set",
    759: "E2E checks the prefilled form (personal hours, three days); the habit is not saved in that test",
    278: "The category is computed again from the cached attendees on each run; not under E2E",
    283: "Future managed events and external events from 90 days back are repainted; past managed events are not",
    284: "An event that cannot change color is skipped and painting never stops a run; not under E2E (Google)",
    285: "At most 2 scope changes a minute (E2E); no repaint-all button",
    221: "Text, count, length, exact title, tag and category filters; category is E2E-proven; no filter by person",
    261: "Google out-of-office events are busy, so they block like any busy event; Google E2E pending",
    262: "Away time over 8 hours is vacation, shorter is personal commitment (unit tests); stats do not split it yet",
    263: "#tl_free opens a busy event to tasks and habits (E2E for a timed event); not under E2E for out of office",
    265: "Any connected calendar that counts for availability blocks its busy events (E2E); no holiday calendar of its own",
    56: "Inside one level and rank: meetings, then buffers, then habits, then tasks; unit tests only",
    242: "The planner can set any event's category to flight (E2E for the control); airport time still follows the title or #tl_flight",
    253: "#tl_busy makes any free event block tasks and habits (E2E); no quick-block action",
    254: "#tl_travel makes the travel buffer wrap an event without an address; not under E2E",
    255: "#tl_flight gives airport time and the flight category; E2E covers flight numbers in the title, not the tag",
    256: "#tl_trip gives the travel category (unit tests); no buffer is added",
    257: "#tl_focus counts an event as focus in stats; not under test",
    385: "Booked events go to the main calendar; no choice of calendar",
}

# Library entries (automations-library.md): row = 718 + entry number.
LIB_FORM = [11, 32, 34, 35, 36, 37, 38, 39, 40, 42, 43, 44, 45]
LIB_DIRECT = [1, 7, 10, 19, 23, 28, 29, 30]
for n in LIB_FORM:
    PARTIAL.setdefault(718 + n, "The library opens the form of its kind with the preset; not under E2E")
for n in LIB_DIRECT:
    PARTIAL.setdefault(718 + n, "The library adds it with the preset (no form of its own yet); not under E2E")

# Row id -> reason, for rows that cannot work yet because a feature they build on is missing.
BLOCKED = {
    718: "Needs the assistant chat, which is not implemented",
    627: "Needs the assistant chat, which is not implemented",
    630: "Not needed for parity: the reference lists these reports as coming soon (analytics-organization.md rule 16)",
    644: "Needs a Google Workspace domain and a super admin to grant domain-wide delegation; the CalDAV organization grant covers the same need for CalDAV servers (E2E: \u201cCalendar access attaches each provisioned person's calendar read-only\u2026\u201d)",
    645: "Needs a Microsoft 365 tenant and a Microsoft Graph calendar provider, which is not implemented",
    568: "Needs the assistant chat, which is not implemented: a switch with nothing to switch off has no effect to prove",
    569: "Needs the assistant chat, which is not implemented",
    581: "Needs the Slack app (a vendor developer app and a test workspace)",
    582: "Needs the assistant chat, which is not implemented",
}
for n in [5, 6, 12, 14, 15, 16, 17, 18, 20, 21, 22, 24, 31]:
    BLOCKED[718 + n] = "A prompt entry: needs the assistant chat, which is not implemented"
for n in [4, 9]:
    BLOCKED[718 + n] = "Needs meeting checks, which are not implemented"
for n in [8, 26]:
    BLOCKED[718 + n] = "Needs a meeting load cap, which is not implemented"
BLOCKED[718 + 2] = "Needs a buffer filter by person, which is not implemented"
BLOCKED[718 + 27] = "Needs a buffer after a run of meetings, which is not implemented"
BLOCKED[718 + 33] = "Needs no-meeting days for meetings and booking links, which are not implemented"

# Row id -> limits, for rows implemented with unit or property tests only.
UNIT = {
    9: "cooldown options are in the engine and settings, not in the UI", 27: "API only; no UI yet",
    55: "engine only; no drag UI yet", 58: "", 59: "booking-link side not implemented", 70: "",
    73: "several ranges per day; no copy-to-all", 90: "meetings, then buffers, then habits inside one level; unit tests only",
    100: "", 109: "", 152: "engine only", 154: "", 156: "daily and weekly; monthly and custom not implemented",
    161: "", 165: "", 178: "", 196: "", 197: "", 202: "", 203: "", 206: "", 208: "", 209: "", 219: "",
    225: "", 226: "API only",
    228: "", 249: "tasks and habits honor it; meetings and booking links not implemented",
    259: "title and description; not the RSVP note", 292: "settings field; no UI yet", 506: "API only",
    517: "status is stored; no reconnect UI yet",
    383: "set through the API; the form derives the slug from the title", 384: "several durations work; the default is the first",
    388: "", 389: "rolling days only; no fixed end date", 390: "before and after buffers; no travel or recovery buffer checks",
    392: "a free-text location only; no Meet, Zoom or Gong", 398: "busy event with the booker as guest and manage link; no conference link",
    408: "", 411: "", 412: "the page marks preferred times; no legend yet", 415: "",
    420: "name, email and message; no CC, questions or location choice",
    450: "calendars of one account; several accounts not tested", 455: "toggle works; no throttle warning",
    456: "", 457: "deletes at once; no confirmation dialog", 467: "", 468: "API only; no UI switch",
    470: "", 471: "stored per policy; no UI", 472: "", 473: "the skip half is E2E-proven; free copies in details mode are not",
    475: "", 476: "copies the details; the provider visibility is not set to private", 480: "", 490: "",
    193: "work and personal habit hours in stats; no per-habit progress", 353: "one-to-one, group and booked meeting hours",
    596: "personal stats only; no team tab", 604: "meetings outside work hours and personal habit hours",
    606: "one-to-one and group split; no heaviest or lightest weekday", 607: "meetings, focus and booking counts; no breaks or travel",
    704: "phase tabs E2E-proven; reset not covered by E2E", 708: "sound on or off; one alarm sound", 712: "today's summary only",
    60: "this event or the whole series; E2E covers a single event", 61: "only main-calendar events can change", 297: "",
    298: "only main-calendar events can change", 238: "a fixed 30 minutes; no setting yet",
    243: "travel buffers follow their event; a manual length is not kept", 244: "",
}

GOOGLE_ROWS = {
    638: "Google sign-in is implemented and follows the team's SSO rules; Google E2E pending (needs a Google OAuth client and account). Microsoft sign-in is not implemented: it needs an app registration and a Microsoft Graph provider.",
    510: "Google sign-in (OAuth with PKCE) and Google Calendar sync are implemented; Google E2E pending: needs a service-account key, and the consent screen needs a one-time check by a person. Microsoft is not implemented.",
    513: "Google and CalDAV accounts can be connected; adding a second account in the UI and Microsoft are not implemented. Google E2E pending.",
    147: "Google sign-in asks for calendar scopes up front; incremental consent not implemented. Google E2E pending.",
    518: "All calendar scopes are asked at sign-in; incremental consent not implemented. Google E2E pending.",
}

GOOGLE_PENDING = "Google E2E pending: the service-account key is not available yet (1Password token missing)."

def status(row_id, spec_file, notes):
    if row_id in E2E:
        tests = "; ".join(f"\u201c{T[k]}\u201d" for k in E2E[row_id])
        note = f" {E2E_NOTES[row_id]}." if row_id in E2E_NOTES else ""
        return "done (CalDAV)", f"Full UI E2E passes on CalDAV (Radicale): {tests}.{note} Google Calendar run pending (service-account key)."
    if row_id in PARTIAL:
        return "partial", f"{PARTIAL[row_id]}."
    if row_id in GOOGLE_ROWS:
        return "partial", GOOGLE_ROWS[row_id]
    if row_id in UNIT:
        extra = UNIT[row_id]
        return "partial", "Implemented; unit or property tests only, no E2E yet." + (f" Limits: {extra}." if extra else "")
    if row_id in BLOCKED:
        return "blocked", f"{BLOCKED[row_id]}."
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
