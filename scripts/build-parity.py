#!/usr/bin/env python3
"""Builds docs/parity.md from docs/parity-src/ (one row file per spec group)
and the status map below. Run: python3 scripts/build-parity.py

Status rules:
  done (CalDAV) = a full UI E2E test passes against a real CalDAV server (E2E map).
  partial       = implemented in part, or proven by unit tests only (PARTIAL, UNIT,
                  GOOGLE_ROWS); the reason says what is missing.
  blocked       = not implemented yet, or a non-goal; the reason says which.

Each row id goes into exactly one status map (E2E, PARTIAL, GOOGLE_ROWS, UNIT or
BLOCKED). The maps record every write, and the build fails when a row was ever
written to two of them, even if a later pop removed it from one.
"""
import re, sys, glob, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
STAGING = os.path.join(ROOT, "docs/parity-src")
OUT = os.path.join(ROOT, "docs/parity.md")

# Row id -> every status map that was ever given that row. A pop does not erase it.
WRITES = {}

class StatusMap(dict):
    """A status map that records each row it gets in WRITES."""
    def __init__(self, name, rows):
        super().__init__()
        self.name = name
        self.update(rows)
    def __setitem__(self, row_id, value):
        WRITES.setdefault(row_id, set()).add(self.name)
        super().__setitem__(row_id, value)
    def update(self, rows):
        for row_id, value in rows.items():
            self[row_id] = value
    def setdefault(self, row_id, value):
        if row_id not in self:
            self[row_id] = value
        return self[row_id]

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
    # Team policies (policies, agendas, fragmentation specs)
    "pol_focus": "a focus policy by department gives members in scope a focus goal from the policy; a directory change moves it",
    "pol_scope": "the narrower policy wins; members personalize their goal and keep it when the admin changes the policy; disabling falls back",
    "pol_buffer": "a buffer policy gives members in scope prep and follow-up buffers by meeting type and a daily break",
    "pol_decline": "auto-decline declines invitations without an agenda at the lead time and keeps the others",
    "pol_remind": "remind lists meetings without an agenda with a draft from the type's template; adjust proposes a shorter meeting",
    "pol_base": "the fragmentation baseline shows the group average of fragmented time on each day of the 4 weeks before",
    "pol_frag": "an enabled fragmentation policy places new habits of members in scope next to busy time, within each member's flexibility",
    # Delegated access and account actions (delegation, account specs)
    "dg_give": "the owner gives a team member access after a confirmation; people outside the team are not offered",
    "dg_switch": "the delegate switches into the owner's account, sees the banner on every page, plans a task on the owner's calendar, and exits",
    "dg_block": "an acting delegate cannot add or remove accounts, connect calendars, manage API keys, change delegates or delete the account",
    "dg_live": "owner and delegate see each other's changes without a reload",
    "dg_remove": "removing a delegate ends the open acting session; a delegate who leaves the team loses access",
    "dg_ea2": "the assistant sets up a flexible meeting for the executive, on the executive's calendar only",
    "dg_ea4": "an assistant with two executives switches between them; a habit lands on the chosen executive's calendar only",
    "acct_add": "a user adds a second CalDAV account and removes it after a confirmation; the main account stays",
    "acct_keys": "a personal API key creates a planned task; regenerate replaces the secret; delete revokes it",
    "acct_delete": "deleting the own account needs the email typed, is refused for a sole admin with members, and removes data and future managed events",
    # Team links, round robin, booking pages, team webhooks (team-links, booking-pages, webhooks specs)
    "tl_team": "a team link offers only times when every required organizer is free, invites everyone, and the co-organizer changes their own hours and most fields from the team links group",
    "tl_opt": "an optional organizer is invited but not checked; another organizer can be host and gets the event",
    "tl_recovery": "a team link keeps the longest recovery buffer among its organizers free, and the link can turn it off",
    "tl_rr": "a round-robin link offers every pool member's time, names nobody before confirmation, balances the load, and keeps the member on reschedule while they are free",
    "tl_pref": "a preferred pool member is chosen first, but a reschedule keeps the member who is still free",
    "tl_rr_org": "a round-robin link with organizers checks the required ones, invites all of them, and drops a pool member who leaves the team",
    "bp_starter": "a new booking page gets three starter links with their priorities and durations",
    "bp_dir": "any member finds every team member's booking page and public links in the directory and copies one",
    "bp_brand": "branding: the admin uploads a logo and banner and sets the team default; the page copies it, the link setting wins, and a member can choose custom",
    "wh_team": "only a team admin manages endpoints in Team settings > Webhooks; a member attaches one to their own link",
}

# Row id -> E2E test keys that prove it on CalDAV.
E2E = StatusMap("E2E", {
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
    # Team policies
    585: ["pol_focus", "pol_scope"], 586: ["pol_focus", "pol_scope"], 216: ["pol_focus", "pol_scope"],
    587: ["pol_buffer"], 234: ["pol_buffer"], 588: ["pol_decline", "pol_remind"],
    352: ["pol_decline", "pol_remind"], 589: ["pol_remind"], 590: ["pol_base", "pol_frag"],
    593: ["pol_focus", "pol_buffer", "pol_decline", "pol_base"],
    # Delegated access, assistants, API keys
    522: ["dg_give", "dg_remove"], 523: ["dg_switch", "dg_remove"], 524: ["dg_block", "acct_add", "acct_keys", "acct_delete"],
    525: ["dg_live"], 765: ["dg_switch", "dg_ea2", "dg_ea4"], 927: ["acct_keys"],
    # Team links, round robin, booking pages, team webhooks
    425: ["tl_team"], 426: ["tl_team"], 430: ["tl_team"], 439: ["tl_team"], 427: ["tl_opt"],
    428: ["tl_opt"], 429: ["tl_recovery"], 431: ["tl_rr"], 433: ["tl_rr"], 422: ["tl_rr"],
    435: ["tl_rr", "tl_pref"], 434: ["tl_pref"], 432: ["tl_rr_org"], 767: ["bp_starter"],
    766: ["bp_dir", "dg_switch"], 423: ["bp_brand"], 570: ["bp_brand"], 571: ["wh_team"],
    930: ["wh_team", "w_flow"],
})

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
    423: "Branding applies to booking pages; Tempoloom sends no booking emails and has no embeds yet, and the link group is the user's booking page",
    426: "Hours come from the organizer's hours sets; item-specific hours on a link are not built",
    428: "The host part; Tempoloom has no conference integrations yet (they need vendor apps), so the host's integration has nothing to apply",
    429: "A team link keeps the longest recovery buffer of its organizers' buffer automations free",
    767: "The starter set follows booking-links.md rule 2, which owns this rule",
    524: "The blocked actions exist for the owner (E2E proves they work for the owner)",
    765: "Executive assistant journey T1, T2 and T4; T3 (booking pages directory) is row 766. T2 sets up a new flexible meeting: converting an existing calendar meeting is not built",
    927: "The expiry limit has unit tests; the rate limit is not built",
    588: "Adjust proposes a shorter meeting and changes it only when the organizer confirms; moving a meeting or lowering its priority is not built, because preview mode is not implemented",
    352: "Generated agendas are drafts from the meeting type's template: Tempoloom has no AI drafting, and the page says so",
    593: "Reports show goal, baseline and weekly group averages; for buffers they count removed buffers instead of a keep rate",
    628: "The organization calendar access is a CalDAV account that reads every person's calendars; the 24-hour refresh is a setting (GRANT_REFRESH_SECONDS), 30 seconds in the test",
}

# Row id -> reason, for rows implemented in part (some behavior has E2E, some does not).
PARTIAL = StatusMap("PARTIAL", {
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
    764: "E2E adds Lunch at 12:00 on each workday from the library; the 11:30 to 14:00 window is not set",
    759: "E2E checks the prefilled form (personal hours, three days); the habit is not saved in that test",
    278: "The category is computed again from the cached attendees on each run; not under E2E",
    283: "Future managed events and external events from 90 days back are repainted; past managed events are not",
    284: "An event that cannot change color is skipped and painting never stops a run; not under E2E (Google)",
    285: "At most 2 scope changes a minute (E2E); no repaint-all button",
    261: "Google out-of-office events are busy, so they block like any busy event; Google E2E pending",
    262: "Away time over 8 hours is vacation, shorter is personal commitment (unit tests); stats do not split it yet",
    263: "#tl_free opens a busy event to tasks and habits (E2E for a timed event); not under E2E for out of office",
    265: "Any connected calendar that counts for availability blocks its busy events (E2E); no holiday calendar of its own",
    242: "The planner can set any event's category to flight (E2E for the control); airport time still follows the title or #tl_flight",
    253: "#tl_busy makes any free event block tasks and habits (E2E); no quick-block action",
    254: "#tl_travel makes the travel buffer wrap an event without an address; not under E2E",
    255: "#tl_flight gives airport time and the flight category; E2E covers flight numbers in the title, not the tag",
    256: "#tl_trip gives the travel category (unit tests); no buffer is added",
    257: "#tl_focus counts an event as focus in stats; not under test",
})

# Library entries (automations-library.md): row = 718 + entry number.
LIB_FORM = [11, 32, 34, 35, 36, 37, 38, 39, 40, 42, 43, 44, 45]
LIB_DIRECT = [1, 7, 10, 19, 23, 28, 29, 30]
for n in LIB_FORM:
    PARTIAL.setdefault(718 + n, "The library opens the form of its kind with the preset; not under E2E")
for n in LIB_DIRECT:
    PARTIAL.setdefault(718 + n, "The library adds it with the preset (no form of its own yet); not under E2E")

# Row id -> reason, for rows that cannot work yet because a feature they build on is missing.
BLOCKED = StatusMap("BLOCKED", {
    718: "Needs the assistant chat, which is not implemented",
    627: "Needs the assistant chat, which is not implemented",
    630: "Not needed for parity: the reference lists these reports as coming soon (analytics-organization.md rule 16)",
    644: "Needs a Google Workspace domain and a super admin to grant domain-wide delegation; the CalDAV organization grant covers the same need for CalDAV servers (E2E: \u201cCalendar access attaches each provisioned person's calendar read-only\u2026\u201d)",
    645: "Needs a Microsoft 365 tenant and a Microsoft Graph calendar provider, which is not implemented",
    568: "Needs the assistant chat, which is not implemented: a switch with nothing to switch off has no effect to prove",
    569: "Needs the assistant chat, which is not implemented",
    581: "Needs the Slack app (a vendor developer app and a test workspace)",
    582: "Needs the assistant chat, which is not implemented",
    217: "No benchmark data: the evidence gives no targets per role (teams-policies.md open question 3)",
    594: "No benchmark data: the evidence gives no targets per role (teams-policies.md open question 3)",
    436: "Needs video conferencing integrations, which need vendor apps and test accounts",
    673: "The evidence names it only on the pricing page and gives no behavior to build (plans-feature-inventory.md open questions); org-chart data exists through SCIM managers",
    928: "Needs the vendor's Zapier app and a Zapier account",
    929: "Needs the vendor's Zapier app and a Zapier account",
    591: "Needs the Slack app (a vendor developer app and a test workspace)",
    592: "Needs the Slack app (a vendor developer app and a test workspace)",
    688: "Needs the assistant chat, which is not implemented",
})
for n in [5, 6, 12, 14, 15, 16, 17, 18, 20, 21, 22, 24, 31]:
    BLOCKED[718 + n] = "A prompt entry: needs the assistant chat, which is not implemented"

# Row id -> limits, for rows implemented with unit or property tests only.
UNIT = StatusMap("UNIT", {
    154: "", 156: "daily and weekly; monthly and custom not implemented",
    161: "", 165: "", 178: "", 196: "", 197: "", 202: "", 203: "", 206: "", 208: "", 209: "", 219: "",
    225: "", 226: "API only",
    228: "",
    259: "title and description; not the RSVP note", 292: "settings field; no UI yet",
    193: "work and personal habit hours in stats; no per-habit progress", 353: "one-to-one, group and booked meeting hours",
    604: "meetings outside work hours and personal habit hours",
    607: "meetings, focus and booking counts; no breaks or travel",
    704: "phase tabs E2E-proven; reset not covered by E2E", 708: "sound on or off; one alarm sound", 712: "today's summary only",
    297: "",
    298: "only main-calendar events can change", 238: "a fixed 30 minutes; no setting yet",
    243: "travel buffers follow their event; a manual length is not kept", 244: "",
})

GOOGLE_ROWS = StatusMap("GOOGLE_ROWS", {
    638: "Google sign-in is implemented and follows the team's SSO rules; Google E2E pending (needs a Google OAuth client and account). Microsoft sign-in is not implemented: it needs an app registration and a Microsoft Graph provider.",
    518: "All calendar scopes are asked at sign-in; incremental consent not implemented. Google E2E pending.",
})

# Round 3 rows. Each block adds rows with T.update, E2E.update, E2E_NOTES.update,
# PARTIAL.update and BLOCKED.update. A row goes into one status map only; to move a row,
# delete it from the map where it was (a pop is not enough: check_one_map_per_row fails).

# --- s1: automations and event settings ---
T.update({
    "s1_list": "the automation list shows habits, flexible meetings, buffers and focus time in P1 to P4 groups in the scheduler's order, filters by type after a reload, opens the shared form from the create button, and keeps focus time in P4 while it ranks inside P4",
    "s1_drag": "a drag inside a priority group gives the contested slot to the automation now ranked first, and a drop on another group changes its priority; both persist after reload",
    "s1_off": "turning a buffer off in the list deletes its future events and on brings them back with the same settings; remove asks first, then deletes it and its future events",
    "s1_added": "a library entry opens the shared form with its preset; Added follows the template through a rename and not a hand-made automation with the entry's name",
    "s1_habit_es": "a habit writes its emoji after the marker, its category color or its own color, private or public visibility, location and custom, no or default reminders onto the calendar chosen at creation; an edit rewrites its future events",
    "s1_focus_es": "a focus automation writes its title, emoji, description, private visibility, reminder and chosen calendar, and a rename renames its events",
    "s1_kinds": "task chunks, habits and flexible meetings get the calendar default reminder, recovery buffers and focus time none, travel buffers are public with a reminder, and a buffer's reminders and visibility change in its form",
    "s1_task_color": "a task color overrides the category color of its chunks in every plan run",
    "s1_category": "a personal habit in work hours counts as personal in stats and not toward focus time; as a work habit it counts for both",
    "s1_done": "an ended habit event gets the done marker and an ended task chunk the partly done marker until its task is done",
    "s1_types": "travel and airport buffers get the travel marker, the user's own flight gets the flight marker once, an invitation is not renamed, and personal-label copies get the house marker and no reminders",
    "s1_emoji": "a template's emoji can be removed in the form, and the user's emoji stays after the free, busy and lock markers of habits and on buffers",
    "lib_other": "buffer and focus entries open the shared form with their preset and saving adds them; prompts offer no action",
})
E2E.update({
    65: ["s1_list", "s1_drag"],
    133: ["s1_kinds", "s1_types"],
    134: ["s1_habit_es", "s1_focus_es", "s1_kinds"],
    141: ["s1_habit_es", "s1_kinds"],
    150: ["s1_habit_es", "s1_emoji"],
    152: ["s1_drag"],
    153: ["s1_habit_es", "s1_category"],
    163: ["s1_habit_es"],
    166: ["s1_habit_es"],
    171: ["s1_habit_es"],
    172: ["s1_habit_es"],
    199: ["s1_focus_es"],
    214: ["s1_focus_es"],
    227: ["s1_kinds"],
    287: ["s1_done"],
    289: ["s1_types"],
    290: ["s1_emoji", "s1_habit_es"],
    291: ["s1_emoji"],
    300: ["s1_added", "s1_focus_es", "s1_kinds", "s1_habit_es"],
    302: ["s1_added"],
    304: ["s1_list"],
    305: ["s1_drag"],
    306: ["s1_list"],
    307: ["s1_off"],
    308: ["s1_list"],
})
E2E_NOTES.update({
    65: "The list is its own Automations page in the main navigation, not a planner sidebar, so the planner page loads nothing more",
    133: "CalDAV keeps no default reminders, so the calendar default is one alert 10 minutes before the start; travel buffers start with it and the user may change it (NTF-14)",
    141: "Each automation has Calendar default, Public or Private; on CalDAV they write no CLASS, CLASS:PUBLIC or CLASS:PRIVATE",
    300: "One Title field is the name and the event title; flexible meetings keep their own form",
    304: "The list is its own Automations page; types without a priority show in a Meeting quality section, empty until meeting checks exist",
})
PARTIAL.update({
    301: "From the library and from the top-bar create menu (E2E: \u201ca library entry opens the shared form\u2026\u201d, \u201cthe automation list shows habits\u2026\u201d); asking the assistant chat needs the chat, which is not implemented",
    245: "Travel and airport buffers start public, with the travel marker (E2E: \u201ctask chunks, habits and flexible meetings get the calendar default reminder\u2026\u201d); mirroring skips every managed event, while mirroring rule 15 skips only copies, so no copy of a travel buffer exists to follow a policy",
})
for n in [1, 7, 10, 19, 23, 28, 29, 30]:
    PARTIAL[718 + n] = "The library opens the shared automation form with the preset; not under E2E"
# --- end s1 ---

# --- s2: habit actions, focus and buffers ---
T.update({
    "s2_make_habit": "a solo recurring event becomes a habit from the planner with its title, length, days and time; a series with guests offers a flexible meeting instead",
    "s2_reschedule": "reschedule puts one occurrence at the legal slot nearest the chosen time on its day and keeps it there",
    "s2_edit_habit": "edit habit opens the habit of any of its events and moves its future events only",
    "s2_done": "an ended habit occurrence gets the done marker on the calendar and shows done in the planner",
    "s2_monthly": "a monthly habit is placed once, on a day of the month or on the nth weekday",
    "s2_habit_tasks": "a habit's saved task search lists matching tasks on every event and while it runs, and changes no event",
    "s2_focus_modes": "proactive focus keeps daily limits and shows the goal is not reached; reactive focus waits, then protects the last free time",
    "s2_focus_decline": "auto-decline declines unanswered invitations over focus time with the message; the focus event stays",
    "s2_focus_tasks": "every focus event lists the same task search, and the planner shows its tasks while focus runs",
    "s2_overload_daily": "a daily meeting limit turns the rest of the day into focus time, declines invitations there with a note, shows its task search, and goes when meetings drop",
    "s2_overload_weekly": "the meeting load cap entry fills the form; a weekly limit protects the rest of the week once reached",
    "s2_recovery_day": "the recovery day entry caps meetings only on the workday after a heavy meeting day",
    "s2_filter_describe": "the executive prep entry needs people; descriptions set people, count, category, title, text, tag and length conditions; the live list follows each change; the buffer lands before the matching meeting",
    "s2_scope": "a buffer for one calendar skips meetings on other calendars; all calendars covers them",
    "s2_runs": "the meeting runs entry adds one recovery buffer after a run of back-to-back meetings longer than 90 minutes",
    "s2_mirror_travel": "a mirrored copy with details gets travel time from its tag; a busy-only copy gets none",
})
E2E.update({
    48: ["s2_focus_tasks"], 49: ["s2_habit_tasks"], 50: ["s2_overload_daily"],
    127: ["s2_make_habit"], 173: ["s2_habit_tasks"], 174: ["s2_make_habit"],
    182: ["s2_reschedule"], 190: ["s2_edit_habit"], 191: ["s2_done"],
    198: ["s2_focus_modes"], 200: ["s2_focus_decline"], 210: ["s2_focus_modes"], 211: ["s2_focus_tasks"],
    212: ["s2_overload_daily", "s2_overload_weekly"], 213: ["s2_overload_daily"],
    221: ["s2_filter_describe", "c_buffer"], 222: ["s2_filter_describe"], 223: ["s2_filter_describe"],
    224: ["s2_scope"], 246: ["s2_mirror_travel"],
    720: ["s2_filter_describe"], 726: ["s2_recovery_day"], 744: ["s2_overload_weekly"], 745: ["s2_runs"],
    768: ["s2_monthly", "lib_habit", "tpl_habits"],
})
E2E_NOTES.update({
    48: "The search has a name, a title keyword and an optional due range over Tempoloom tasks; integration fields come with the task integrations",
    49: "The search has a name, a title keyword and an optional due range over Tempoloom tasks",
    50: "Assigned in the meeting overload form; the list shows on its events",
    173: "The task filter is a saved task search (planning-next-up.md NXT-40)",
    198: "Reactive mode protects the free time left once it is not more than the missing goal",
    222: "A fixed, documented grammar reads the description; no language model (buffers-automation.md rule 4)",
    221: "One \u201cwith people\u201d condition matches attendee and organizer addresses or a domain",
    246: "Tempoloom's own mirror copies count as anchors as they show on their calendar",
    768: "The monthly reviews are habits with the monthly frequency; the other executive routines are library entries and team habit templates",
})
# --- end s2 ---

# --- s3: tasks, planner, time zones and tools ---
T.update({
    "s3_another": "the New task form opened with the key C stays open with Create another and closes without it; every task gets its event",
    "s3_suggest": "suggestions-only placement removes task events, lists Suggested now and At risk in scheduler order, and places chunks again when switched back",
    "s3_nextup": "the planner's next-up task is the one in progress, else the earliest chunk, else the first in scheduler order",
    "s3_focus_tasks": "with suggestions only, a focus time block lists the tasks to work on and tasks get no events",
    "s3_blocks": "Block time shows work blocks as a preview; Discard writes nothing; a moved block and Apply write locked events that stay",
    "s3_timer": "the task timer survives a reload, keeps going or discards, and logs edited minutes as a past event on the chosen calendar only on Log time",
    "s3_logged": "time logged with the timer on a task and on a habit is a past event and counts in stats",
    "s3_delete_hours": "deleting a custom hours set in use asks for a replacement and moves its task there; an unused set goes after a confirmation",
    "s3_item_hours": "a habit with item-specific hours is placed in them; tasks and other hours menus never offer them",
    "s3_preview": "the hours menu of the task and habit forms previews the chosen ranges and links to the hours page",
    "s3_review": "a new user is asked once to review hours; a change there moves events; the banner stays gone after reload and restart",
    "s3_utc": "a browser that reports UTC gets a warning and never changes the home zone; the hours page names the zone and an active trip",
    "s3_join": "the planner shows the current or next meeting and joins it in one click from its location or description link",
    "s3_alert": "an event start flashes the tab title and plays the chime only when it is on; with both off nothing happens",
    "s3_blocked": "a chime that the browser blocks shows a hint",
    "s3_conflict": "overlapping external events are outlined and listed with a suggested time; neither event moves",
    "s3_markdown": "task notes keep their markdown in the calendar, render in the planner with app links while unsafe links stay text, and the planner link opens the task",
    "s3_timer_link": "a timer link in the focus time description and in habit notes reaches every event and renders as a link",
    "s3_profile": "the profile shows account fields read-only and keeps job title, company, size and use case after reload and restart",
    "s3_travel": "a travel zone places habits in its local time on its dates; several entries are allowed, overlaps and reversed dates are refused; delete returns home",
    "s3_travel_book": "a booking link offers times in the travel zone on travel days",
    "s3_travel_prompt": "the planner prompts for a travel zone when the browser is elsewhere, shows two time columns, and ends the trip back home",
    "s3_bg_audio": "background audio plays the chosen track in work sessions only and keeps its settings after reload",
    "s3_mini": "the mini window shows the running timer and pauses it",
})
E2E.update({
    3: ["s3_another"], 30: ["s3_suggest", "s3_focus_tasks"], 39: ["s3_timer"], 45: ["s3_nextup"],
    46: ["s3_suggest", "s3_focus_tasks"], 51: ["s3_blocks"], 68: ["s3_conflict"], 75: ["s3_delete_hours"],
    77: ["s3_preview"], 79: ["s3_review"], 80: ["s3_utc"], 124: ["s3_join"], 131: ["s3_alert"],
    132: ["s3_alert", "s3_blocked"], 137: ["s3_markdown"], 138: ["s3_markdown"],
    139: ["s3_markdown", "s3_timer_link"], 146: ["s3_profile"], 271: ["s3_travel"],
    272: ["s3_travel_book"], 273: ["s3_travel_prompt", "s3_utc"], 274: ["s3_travel_prompt"],
    611: ["s3_logged"], 709: ["s3_bg_audio"], 710: ["s3_mini"], 713: ["s3_timer_link"],
    771: ["s3_focus_tasks"],
})
E2E_NOTES.update({
    51: "Without the assistant chat, the request is a Block time button on a suggested task",
    611: "Time is logged by hand with the timer, on tasks and habits; the legacy form on a past planner slot (rows 37, 38) is not built",
    710: "The E2E browser has no Document Picture-in-Picture, so the test proves the popup window that Tempoloom opens instead; the picture-in-picture path is not under E2E",
    124: "Join uses the first link in the event's location or description; no conference vendor app",
})
PARTIAL.update({
    76: "Habits have item-specific hours (E2E on CalDAV: \u201ca habit with item-specific hours is placed in them\u2026\u201d); focus time, flexible meetings and booking links do not offer them yet",
})
# --- end s3 ---

# --- s4: mirroring, accounts and instance limits ---
T.update({
    "s4_tabs": "the policy list filters by account; an edit rewrites and moves the copies; details warn about admins; delete asks first",
    "s4_mesh": "three calendars that block each other take six policies; each event gets one copy on every other calendar, copies never chain, and a repeated pair is refused",
    "s4_main_dest": "a destination that is another Tempoloom account's main calendar is refused; that calendar can still be a source",
    "s4_labels": "labels follow the event category and the calendar type; an event that invites the destination gets no copy; a color override paints one policy's copies",
    "s4_alerts": "an alert added to a copy is removed; the full reconcile puts back a changed color and shows its time",
    "s4_family": "guidance covers family calendars and duplicate views; a declined or tagged family event loses its copy for good",
    "s4_window": "mirroring keeps copies 12 months ahead while planning stops at its own window",
    "s4_shared": "a calendar shared with full access can be added, connected, blocks time and feeds a mirroring policy; a read-only share is refused",
    "s4_twice": "a calendar that two added accounts can see is listed once, under the account added first",
    "s4_category": "each connected calendar has a category that colors its events; the page explains connected calendars versus mirroring",
    "s4_secondary": "a secondary email signs in to the same account; removing it removes its policy, copies and calendars",
    "s4_main": "use as main moves the main badge, the locked main calendar and new events; the old email still signs in",
    "s4_taken": "an email that is main in another account cannot become main; after that account is deleted the retry works",
    "s4_several": "an email that two accounts hold as secondary opens neither and offers a new account",
    "s4_win_limit": "an operator window limit caps planning but never booking links",
    "s4_cal_limit": "an operator limit on connected calendars refuses one more, and a lower limit turns the extras off",
    "s4_counts": "operator limits on mirroring policies, booking links and automations refuse one more with a message; existing ones keep working",
    "s4_feed": "a holiday feed blocks its days; a change in the feed moves work; removing it removes its calendar",
})
E2E.update({
    82: ["s4_window"], 266: ["s4_feed"], 452: ["s4_main_dest"], 453: ["s4_tabs"], 454: ["s4_tabs"],
    460: ["s4_mesh"], 461: ["s4_counts"], 465: ["s4_labels"], 478: ["s4_tabs"], 479: ["s4_labels"],
    481: ["s4_labels"], 482: ["s4_alerts"], 489: ["s4_alerts"], 494: ["s4_family"], 495: ["s4_family"],
    499: ["s4_shared"], 500: ["s4_twice"], 501: ["s4_category"], 502: ["s4_cal_limit"],
    508: ["s4_category"], 509: ["s4_shared"], 511: ["s4_secondary"], 512: ["s4_several"],
    514: ["s4_secondary"], 515: ["s4_main"], 516: ["s4_taken"], 656: ["s4_win_limit"],
    657: ["s4_cal_limit"], 658: ["s4_counts"], 659: ["s4_counts"], 660: ["s4_counts"],
    # Partial rows of the mirroring spec that these tests now prove in full.
    450: ["s4_tabs", "s4_shared"], 455: ["s4_tabs", "m_follow"], 457: ["s4_tabs"],
    490: ["s4_tabs", "s4_labels"],
})
E2E_NOTES.update({
    82: "Copies 150 and 350 days ahead exist while the planning window is 1 week; an event 372 days ahead gets none",
    266: "The test serves the feed on loopback; feed days block time also when the feed marks them free",
    452: "The colleague's main email is added as a secondary email; its main calendar is refused as a destination",
    461: "Tempoloom has no plans: the operator sets max_mirrors with the CLI (off by default)",
    465: "On CalDAV the destination's account email is the invited address; a Google calendar id as guest is unit-tested",
    482: "CalDAV copies carry no VALARM and an alarm added to a copy is removed on the next sync; Google copies are written with reminders.useDefault=false",
    489: "The interval is MIRROR_RECONCILE_SECONDS (default 12 hours); the test sets 10 seconds",
    499: "On CalDAV the server's privileges decide and a read-only share is refused; Google holiday, birthday and group calendars are left out by calendar id (unit test)",
    500: "The same calendar URL reached through two CalDAV accounts",
    502: "Tempoloom has no plans: lowering the operator limit max_connected_calendars turns the extra calendars off",
    509: "On CalDAV the user adds a shared calendar by its URL",
    511: "On CalDAV, logging in with an email means signing in with that calendar account",
    656: "Tempoloom has no plans: the operator sets max_scheduling_window_weeks with the CLI (off by default)",
    657: "Tempoloom has no plans: the operator sets max_connected_calendars with the CLI (off by default)",
    658: "The operator sets max_mirrors with the CLI (off by default)",
    659: "The operator sets max_booking_links with the CLI (off by default)",
    660: "The operator sets max_automations_per_user with the CLI (off by default); habits, focus time and buffers count",
})
PARTIAL.update({
    469: "Copies of events that Gmail made from an email (Google event type fromGmail) are busy, proven by a unit test; CalDAV has no such events, and the Google E2E needs a Google account",
})
# --- end s4 ---

# --- s5: meeting rescheduling and meeting checks ---
T.update({
    "s5_checks": "each built-in check raises its issue in the planner Issues tab, never edits an event, and resolves when its cause ends",
    "s5_ignore": "checks are on for a new user; ignore hides one event or a whole series; a disabled check closes its issues and raises no new ones",
    "s5_digest": "library entry 'Flag meeting problems' turns on the checks and an email digest of open, not ignored, issues at the chosen time, once a day",
    "s5_company": "a team admin's company check flags only the meeting's organizer, shows locked to members, and a member can ignore one issue",
    "s5_agenda": "an agenda draft is staged and written only when applied; recommendations list a skipped habit, an unmet focus goal and a day with too many meetings",
    "s5_decline": "a required guest's decline moves the occurrence and an optional guest's does not; each move is logged; guests get an update email only inside the days-ahead limit and while emails are on",
    "s5_limit": "with 1 move per day a second conflict is flagged with suggested times and a suggestion applies as a locked move; with no automatic moves the meeting stays flagged",
    "s5_adopt": "rules attach to an existing recurring meeting: the form fills from it, the series keeps its id, and a conflict moves only its own instance",
    "s5_daily": "the daily emails list meetings at risk in the next 14 days and new recurring meetings; the email's link opens the form filled from that series",
    "s5_starts": "start times limit flexible meetings and booking pages to the chosen minutes; a change does not move meetings placed before it",
    "s5_nomeet": "the weekly no-meeting day writes one weekly all-day #tl_free series: habits keep the day, meetings and booking links stay off it each week",
})
E2E.update({
    135: ["s5_decline"],
    136: ["s5_daily"],
    250: ["s5_nomeet"],
    309: ["s5_checks"],
    310: ["s5_checks"],
    311: ["s5_checks", "s5_ignore"],
    312: ["s5_checks", "s5_ignore"],
    313: ["s5_ignore"],
    314: ["s5_ignore"],
    315: ["s5_checks", "s5_ignore"],
    318: ["s5_company"],
    319: ["s5_adopt"],
    355: ["s5_decline"],
    358: ["s5_limit", "s5_decline"],
    373: ["s5_decline", "s5_limit"],
    376: ["s5_daily"],
    377: ["s5_decline"],
    378: ["s5_starts"],
    722: ["s5_agenda"],
    727: ["s5_digest"],
    751: ["s5_nomeet"],
    772: ["s5_checks", "s5_agenda"],
})
E2E_NOTES.update({
    135: "Tempoloom sends the update email itself, with an iCalendar REQUEST attached, because it writes changes without the provider's update emails; the limit uses the earlier of the old and new start",
    136: "Tempoloom builds both planned notices: the at-risk digest (row 376) and an email that offers each new recurring series once, with a link to the meeting form filled from it",
    310: "Not free is read from the calendar of a guest who is a user here; other guests count by their answer only",
    312: "A video link is a CONFERENCE property or a URL whose host names a video service",
    315: "The Issues tab is in a panel under the planner's week view",
    318: "Conditions: attendee count, empty description, no video link, guests from outside the team, length and title text",
    319: "On CalDAV a moved instance is an override (RECURRENCE-ID) inside the one series; turning the meeting off or deleting it keeps the series as a normal recurring event",
    355: "Answers are read from the PARTSTAT on the organizer's copy, as a CalDAV server with scheduling writes it",
    358: "The count is per meeting in a rolling 24 hours and counts moves for conflicts and declines; a flag is raised only when another time exists",
    373: "The log shows on each meeting of the Meetings page",
    377: "Tempoloom sends the update email itself, with an iCalendar REQUEST attached",
    722: "The draft is a fixed agenda template (no AI drafting); it is staged in the Issues tab and written to the event only when the user applies it",
    751: "The series is 'No meetings #tl_free' on the user's main calendar; removing it deletes the series",
    772: "Issues come from the meeting checks; recommendations come from the planner's report and days with 6 hours or more of meetings",
})
PARTIAL.update({
    317: "The daily digest by email, at a time the user sets, has full UI E2E on CalDAV (\u201clibrary entry 'Flag meeting problems' turns on the checks and an email digest of open, not ignored, issues at the chosen time, once a day\u201d); the chat app channel needs a chat vendor app (Slack), which Tempoloom does not have",
})
# --- end s5 ---

# --- s6: booking links ---
T.update({
    "s6_questions": "screening questions keep their order, type and required flag; the page and the API refuse a missing answer or a choice outside the list; the answers reach the event",
    "s6_redirect": "after booking, the confirmation shows and the browser opens the https redirect page 7 seconds later; an http URL is refused",
    "s6_emails": "booking, reschedule and cancel email the booker and the organizer, each in their own time zone, with reschedule and cancel links for the booker only",
    "s6_mail_brand": "booking emails carry the link's branding: the team logo linked to the homepage, or no logo",
    "s6_reminder": "the reminder email reaches the booker once at its time with the message; a booking made before the setting gets it, a cancelled one never",
    "s6_zone": "the time zone picker lists the browser's and the calendar's zone first and converts the times; the zone and the 12- or 24-hour format survive a reload",
    "s6_params": "URL parameters choose the zone, duration, day and time; each duration lists its own times; invalid or unoffered values are ignored",
    "s6_overlay": "a signed-in booker overlays their own events next to the times; the organizer's events never show; signed-out bookers get no switch",
    "s6_inspect": "organizers inspect every time with a dot per failed check, its person, their own event titles and setting links; inspecting changes nothing and others never see it",
    "s6_cards": "link cards show title, durations and priority, sit under their page, copy and open the URL, and change the priority so the booking page follows",
    "s6_groups": "a link group gets its own booking page with its links, refuses a slug in use, and a booker books from it",
    "s6_groups_edit": "editing a group or moving a link warns before URLs break, old URLs stop working, and deleting a group moves or deletes its links",
    "s6_oneoff": "a one-off link has its own settings and prefilled invitee, stays unlisted, leaves the source unchanged, counts against its limits, and its creator edits it from its URL",
    "s6_expiry": "a one-off link shows its 30-day expiry date and, once expired, an expired page with no times and refused bookings",
    "s6_times": "shared times take up to 5 dates and offered times, as buttons or text with merged ranges and links that open that time, and the last template is kept",
    "s6_share": "the share menu copies the URL and opens an email draft and the LinkedIn, X and Facebook share pages with it",
    "s6_embed": "script, object, iframe and URL embeds load the branded booking page on another site; the script sizes its frame; an embedded booking reaches the calendar",
    "s6_embed_redirect": "embed redirect modes: none stays, top page moves the whole page, frame moves only the frame, and the last mode is remembered",
})
E2E.update({
    393: ["s6_questions"], 394: ["s6_reminder"], 395: ["s6_redirect"], 396: ["s6_cards", "s6_share"],
    401: ["s6_emails"], 413: ["s6_inspect"], 416: ["s6_zone"], 417: ["s6_zone"],
    418: ["s6_params", "s6_times"], 419: ["s6_overlay"], 424: ["bp_brand", "s6_mail_brand", "s6_embed"],
    437: ["s6_groups"], 438: ["s6_groups_edit"], 440: ["s6_oneoff", "s6_expiry"], 441: ["s6_times"],
    442: ["s6_times"], 443: ["s6_share"], 444: ["s6_embed"], 445: ["s6_embed_redirect"],
    411: ["s6_params"], 415: ["s6_params"], 423: ["bp_brand", "s6_mail_brand", "s6_embed"],
})
E2E_NOTES.update({
    394: "The server sends due reminders every minute; the test runs the same check at chosen times with the operator CLI (booking-reminders --now)",
    401: "Emails need SMTP_URL; without it the calendar invitation is the only notice",
    413: "Each day lists the starts from the first start to the last end of the people's hours; start minutes are not a booking-link check, so no time fails on startInterval",
    419: "The overlay lists the booker's events of all their connected calendars under each date and marks the times that overlap them",
    423: "Branding applies to booking pages, booking emails and embeds; a new link group copies the team default and has its own branding setting",
    424: "Logo, banner and homepage link on booking pages, in booking emails and in embeds",
    440: "The lifetime is an instance setting (ONEOFF_LINK_DAYS, default 30); the test checks the 30-day date, then restarts the server with 0 days to show the expired page",
    443: "LinkedIn, X and Facebook through their public share URLs; no vendor API",
})
# --- end s6 ---

# --- s7: preview mode, MCP, stats and support ---
T.update({
    "s7_mcp_read": "an MCP client with an API key reads events, free time, the week summary and meeting context; without a key it gets a 401",
    "s7_mcp_stage": "an MCP write is staged, not written; the planner shows it with its source; accept and apply write it, and nothing stays staged",
    "s7_final": "the final list applies only what stays in it: a discarded and a removed change stay off the calendar, and guests get mail only at apply",
    "s7_stale": "a change whose event moved after staging is skipped as stale, and the event keeps its newer time",
    "s7_readonly": "a server with MCP_WRITE_ENABLED=false lists no write tools, refuses a write and stages nothing",
    "s7_manual": "preview mode turned on by hand stages a drag; turned off, the change stays pending after a reload; apply moves and locks the event",
    "s7_auto": "with preview mode on, a new habit and turning it off show their calendar impact and write nothing until apply",
    "s7_help": "the help index groups common problems, and its pages give each fix in order, also after a reload",
    "s7_lookup": "an event link shows the copy's mirroring and source, a skip reason, and Tempoloom's change log with the source move",
    "s7_hint": "a new user sees the advice to turn off other scheduling tools until they dismiss it",
    "s7_stats": "stats split deep and shallow work, count breaks, travel and time away, and name the people met, busiest and lightest days, insights and facts",
})
E2E.update({
    93: ["s7_auto"], 175: ["s7_auto"], 303: ["s7_auto"], 696: ["s7_auto"],
    690: ["s7_mcp_stage", "s7_auto"], 691: ["s7_mcp_stage", "s7_final"],
    692: ["s7_final", "s7_stale"], 693: ["s7_final"], 694: ["s7_manual"], 695: ["s7_manual"],
    697: ["s7_mcp_read"], 698: ["s7_mcp_read"], 699: ["s7_mcp_stage", "s7_final"],
    663: ["s7_readonly"],
    537: ["s7_help"], 538: ["s7_help"], 544: ["s7_help"], 545: ["s7_help"],
    539: ["s7_lookup"], 541: ["s7_lookup"], 774: ["s7_hint"],
    235: ["s7_stats"], 276: ["s7_stats"], 584: ["s7_stats"], 603: ["s7_stats"],
    605: ["s7_stats"], 608: ["s7_stats"], 606: ["s7_stats"],
})
E2E_NOTES.update({
    93: "Staged while preview mode is on; with preview mode off an automation save applies at once",
    175: "Staged while preview mode is on; with preview mode off a habit save applies at once",
    303: "Staged while preview mode is on; the impact is the difference between the plan now and the plan with the change",
    693: "CalDAV servers need not deliver invitations, so Tempoloom sends each guest one email at apply",
    697: "Streamable HTTP at /mcp; a personal API key is the bearer token, not OAuth. Per-tool hints (apply_staged_changes is destructive), output schemas and cursor pages are unit-tested (tests/unit/mcp.test.ts), not under E2E",
    698: "The E2E calls list_events, find_free_time, get_week_summary and get_meeting_context; list_tasks, list_automations, list_staged_changes and get_stats have unit tests only (tests/unit/mcp.test.ts)",
    663: "An instance setting (MCP_WRITE_ENABLED); Tempoloom has no tiers",
    539: "CalDAV event links; a Google edit link is read too but not under E2E",
    541: "Tempoloom's own change log, shown in the event lookup; the Google Workspace audit log is outside Tempoloom",
    774: "A planner hint with a help page, until the user dismisses it",
    606: "Totals per meeting category over the range, with the busiest and lightest weekday",
})
PARTIAL.update({
    700: "The account page gives the server URL and the API key steps for any MCP client (E2E: \u201can MCP client with an API key reads\u2026\u201d checks the URL); no guide per product (ChatGPT, Claude, Cursor), which integrations-ai-tools.md owns",
    610: "Planned time (the calendar when each day began, from Tempoloom's change log) and actual time (what stayed) show on the stats page; unit tests only, because an E2E run cannot pass a day boundary; logged time is not added",
    634: "The facts (busiest meeting day, longest focus session, booked meetings, breaks, people met) show on the stats page for any range (E2E: \u201cstats split deep and shallow work\u2026\u201d); the weekly report email itself is not built",
})
# --- end s7 ---

# --- s8: automation types ---
T.update({
    "s8_types": "the automation list shows all six types: habits, flexible meetings and buffers in their groups, meeting overload and focus time pinned to P4, and each meeting check in Meeting quality with no priority and no Remove; the type filter has every type and keeps it after a reload",
    "s8_overload": "a meeting overload's entry opens its form with its values and a saved edit replans its events; off removes its focus events and on brings them back; ranked below a focus goal in P4 it leaves that goal its hours first; remove asks, then deletes it and its events",
    "s8_checks": "turning a built-in meeting check off in the list closes its issue in the Issues tab and unchecks it on the meeting checks page; on brings the issue back, also for agenda drafts, which start off; all persist after a reload",
    "s8_company": "a company check shows locked in the list; a member gets no actions, while the admin's off and remove in the list reach the member's list and checks page",
})
E2E.update({
    299: ["s8_types", "s8_overload", "s8_checks", "s8_company"],
    304: E2E[304] + ["s8_types"],
    308: E2E[308] + ["s8_types", "s8_overload"],
    313: E2E[313] + ["s8_checks"],
    318: E2E[318] + ["s8_company"],
})
E2E_NOTES.update({
    299: "Meeting overload ranks in P4 with focus time; one Meeting quality entry per built-in check (turn off or on, no remove) and per company check (admins only)",
    304: "The list is its own Automations page; the meeting checks, which have no priority, show in a Meeting quality section below the groups",
})
# --- end s8 ---

# --- merge: rows that need the work of more than one stream ---
E2E.update({282: ["s1_habit_es", "s1_task_color", "s4_labels"]})
E2E_NOTES.update({282: "Habits, focus time, buffers and tasks have their own color (stream s1); a mirroring policy has a color override (stream s4)"})
# Rows this round did not build, each with the concrete reason.
CHAT = "Needs the assistant chat (a language-model chat), which is not built; preview mode and the MCP server, which it would use, exist"
for n in [6, 47, 130, 316, 369, 609, 612, 661, 662, 672, 674, 675, 676, 677, 678, 679, 680, 681,
          682, 684, 685, 686, 687, 689]:
    BLOCKED[n] = CHAT
BLOCKED[683] = CHAT + "; the morning email digest of meeting checks is built (row 317)"
BLOCKED[769] = "Needs the assistant chat, which is not built; the other parts of the baseline are built (preview mode, automations, issues, insights, MCP server)"
MICROSOFT = "Needs a Microsoft 365 account and a Microsoft Graph calendar provider, which is not built"
for n in [520, 521, 526, 527, 528, 529, 530, 531, 532, 533, 534, 535, 536, 669, 670]:
    BLOCKED[n] = MICROSOFT
BLOCKED[451] = "Needs Google and Microsoft calendar accounts; mirroring between calendars of two CalDAV accounts is built (rows 453, 460)"
BLOCKED[145] = "Needs a Google account: these fields come from the Google profile; the editable profile fields are built (row 146)"
BLOCKED[491] = "Needs a Google Workspace account: the trigger is Google calendar sharing"
BLOCKED[492] = "Needs a Google Workspace account: the help covers Workspace sharing and Gmail-made events"
BLOCKED[493] = "Needs Google or Microsoft accounts that subscribe to the iCloud calendar; a CalDAV server connects directly"
BLOCKED[519] = "Needs a Google Workspace domain and a super admin"
BLOCKED[671] = "Needs Google Meet (a Google account and the Calendar conference API)"
for n in [446, 447]:
    BLOCKED[n] = "Needs the Gmail and Google Calendar add-on, a vendor app; the same actions exist on the Booking links page (rows 440 to 443)"
for n in [268, 293]:
    BLOCKED[n] = "Needs the Slack app (a vendor developer app and a test workspace)"
BLOCKED[344] = "Needs the vendor apps of third-party agenda tools (Docs notes, Lattice, Fellow)"
for n in [664, 665, 666, 667, 668]:
    BLOCKED[n] = "The pricing page names it and gives no behavior to build (plans-feature-inventory.md open questions); it also needs meeting notes, transcripts or a room provider"
# --- end merge ---

# --- U08: mirroring copy rules, accounts and webhook delivery ---
T.update({
    "u8_answers": "the owner's answer and role decide a copy's free/busy; the no-reply setting applies to every policy; details copy free events",
    "u8_allday": "all-day events: none by default, then busy ones, then all; a copy of an all-day event is all-day",
    "u8_hours": "copy only during work hours: events fully outside are skipped, an overlapping one is copied in full; the checkbox is saved",
    "u8_privacy": "privacy: busy-only copies say Busy with no details; private details copies keep the details, are marked private, and copy free events as free",
    "u8_type": "the calendar type of a policy sets the label and the category color of its copies",
    "u8_resync": "turning a policy off and on runs a full re-sync: a drifted copy and changes made while it was off are all put right",
    "u8_taskcal": "tasks on personal hours go to that set's task calendar; work-hours tasks stay on the main calendar",
    "u8_reconnect": "an account whose login stops working shows Disconnected, pauses its policies and nothing else; reconnect resumes them",
    "u8_urls": "with private receivers off, http, localhost and IP hosts are refused and a public https host is kept; the operator setting allows loopback",
    "u8_timeout": "an answer after 10 seconds is a failure and is cut at 10 seconds; only 200, 201, 202 and 204 count as success",
    "u8_suspend": "an endpoint that fails for the whole period is suspended, gets no new requests and its admins get an email; Resume sends the waiting request",
})
E2E.update({
    456: ["u8_resync"], 467: ["u8_allday"], 468: ["u8_hours"], 470: ["u8_answers"],
    471: ["u8_answers"], 472: ["u8_answers"], 473: ["m_follow", "u8_answers", "u8_privacy"],
    475: ["u8_privacy"], 476: ["u8_privacy"], 480: ["u8_type"], 506: ["u8_taskcal"],
    517: ["u8_reconnect"], 934: ["u8_urls"], 936: ["u8_timeout"], 938: ["u8_suspend"],
})
E2E_NOTES.update({
    471: "One setting on the Settings page for every policy, stored with the account settings",
    473: "Label and busy-only copies skip free events; details copies are free",
    476: "Copies get the private class (CalDAV CLASS:PRIVATE, Google visibility private)",
    506: "Each hours set has a calendar for task chunks on the Settings page",
    517: "On CalDAV the server rejects the stored password and the user types a new one; a Google account reconnects through Google sign-in again",
    934: "The E2E server runs with private receivers off for this test (WEBHOOK_ALLOW_PRIVATE)",
    938: "The 24-hour period is a setting (WEBHOOK_SUSPEND_AFTER_SECONDS), 4 seconds in the test",
})
BLOCKED[510] = ("Needs a Microsoft 365 account and a Microsoft Graph provider, which is not built; "
                "Google sign-in (OAuth with PKCE) and Google Calendar sync are built, and their E2E needs a Google service-account key")
BLOCKED[513] = ("Needs a Microsoft 365 account and a Microsoft Graph provider, which is not built; a second CalDAV account "
                "is added with CalDAV E2E (\u201ca user adds a second CalDAV account and removes it after a confirmation\u201d), "
                "and Google accounts connect through Google sign-in (Google E2E needs a Google account)")
# --- end U08 ---

# --- U03: core planning ---
T.update({
    "u03_spacing": "the time between chunks of a task is a setting: once a day puts each chunk on its own day, 2 hours keeps a 2-hour gap",
    "u03_calendar": "each hours set has a calendar for task chunks; chunks of tasks in that set go there",
    "u03_calendar_keep": "a new calendar for task chunks moves placed chunks there at the same times and saves no hours; a calendar that is not the user's is refused",
    "u03_order": "inside one level meetings go first, then habits, then tasks; a higher level goes before all of them",
    "u03_urgency": "the urgency setting decides whether a low task that is short of time goes first",
    "u03_urgency_48": "with the 48-hour urgency mode a low task due within 48 hours goes up one level, a task due later does not",
    "u03_focus": "focus time goes after a P4 task, keeps the free/busy status set on it, and counts as P2 for booking links",
    "u03_focus_near": "free focus time stays free inside the 12 hours before it starts",
    "u03_series": "the level of a recurring external event applies to this event or to the whole series",
    "u03_other": "events of another connected calendar stay P1: the control is disabled with a note, and links never offer their time",
    "u03_meeting_hours": "flexible meetings use meeting hours: a change there moves the meeting, and tasks keep work hours",
    "u03_ranges": "a day can have several ranges and copy to all copies them to every day that is on; chunks never span the gap",
    "u03_moved": "a chunk moved in the calendar leaves its old time closed to that task only",
})
E2E.update({
    9: ["u03_spacing"],
    27: ["u03_calendar", "u03_calendar_keep"],
    55: ["s1_drag"],
    56: ["u03_order"],
    58: ["u03_urgency", "u03_urgency_48"],
    59: ["u03_focus"],
    60: ["u03_series"],
    61: ["u03_other"],
    70: ["u03_meeting_hours"],
    73: ["u03_ranges"],
    100: ["u03_focus", "u03_focus_near"],
    109: ["u03_moved"],
})
E2E_NOTES.update({
    9: "The choice is a user task default on the Settings page; existing chunks keep their place while they stay valid",
    27: "A new choice moves placed unlocked chunks to that calendar at the same times (HRS-7) and applies to new chunks",
    73: "Copy to all takes Monday's ranges and saves at once",
})
BLOCKED[78] = "Needs a Google account: the zone comes from the Google Calendar setting. The hours page shows the zone that hours apply in and an active trip (E2E on CalDAV: \u201ca browser that reports UTC gets a warning\u2026\u201d)"
BLOCKED[147] = "Needs a Google OAuth client and a Google test account to prove it: incremental consent happens only in Google sign-in. Today Google sign-in asks for calendar scopes up front"
# Row 90 stays partial: E2E does not cover buffers inside a level.
PARTIAL[90] = "E2E on CalDAV covers flexible meetings, habits, tasks, next-up tasks and focus time in the order (\u201cinside one level meetings go first, then habits, then tasks\u2026\u201d, \u201ca next-up task goes before other tasks of any level\u201d, \u201cfocus time goes after a P4 task\u2026\u201d); buffers inside a level have unit tests only"
# Row 76 stays partial: planning-hours.md says focus time, flexible meetings and
# booking links do not offer item-specific hours "yet", so only habits are built.
# --- end U03 ---

# --- U07: flexible meeting limits and actions, booking link settings ---
T.update({
    "u7_notice": "the move notice: an automatic move never starts sooner than the notice after the move, and a meeting with notice 0 takes the nearest time",
    "u7_notime": "with no time in a period, 'remove' leaves the period empty and 'keep' keeps the occurrence at its time as a marked conflict; both say why in the meeting and in the attention list, and the next period is placed",
    "u7_manual": "manual actions: lock and unlock from the planner hold and free an occurrence; a resize in the calendar is kept and locks; a title edit is kept, a free/busy edit is written back",
    "u7_delete": "delete asks first: with email the guests get the cancelled times, without email they get nothing; both remove every future occurrence and the rules",
    "u7_url": "URL names: a title in use gets -2; the owner renames the URL, the old one stops working and a name in use is refused; up to 3 durations with a default that the page preselects",
    "u7_range": "notice and range: no time inside the notice; the last day is a fixed date or today plus the rolling days; both survive a reload",
    "u7_buffers": "buffers: times that leave no buffer before or after a busy event are not offered; at an address the travel time stays free while the link keeps it, and not after it is turned off",
    "u7_locations": "locations, CC and calendar: the booker chooses one of the link's locations and adds CC guests; the busy event goes to the chosen calendar with the location, guests and manage links, and keeps them on reschedule",
    "u7_focus": "placed focus time is offered by a P1 link only",
    "u7_preferred": "preferred times: a time with nothing else on the calendar has a green dot and the legend explains it; a time over a free event is offered without the dot",
    "u7_travel_kind": "travel time follows the kind of the chosen location: an address keeps it free with or without commas, other text with commas does not, and a booker who picks the address is held to it",
    "u7_calendar_kept": "the calendar for booked events is kept when the editor saves while the calendar list cannot load",
    "u7_reminder_loc": "the reminder names the location the booker chose, not the link's default",
    "u7_cc_mail": "CC guests get the booked, rescheduled and cancelled emails with the chosen location and without the booker's links; an organizer in CC gets no second copy",
    "u7_delete_series": "delete on rules attached to an existing series offers no cancel email: the series stays on the calendar and the guests get nothing",
})
E2E.update({
    357: ["u7_notice"],
    359: ["s5_limit"],
    360: ["u7_notime", "s5_daily"],
    367: ["u7_manual"],
    372: ["u7_delete", "u7_delete_series"],
    374: ["u7_notime"],
    383: ["u7_url"],
    384: ["u7_url"],
    385: ["u7_locations", "u7_calendar_kept"],
    388: ["u7_range"],
    389: ["u7_range"],
    390: ["u7_buffers", "u7_travel_kind", "tl_recovery"],
    408: ["u7_focus"],
    412: ["u7_preferred"],
    420: ["u7_locations", "u7_travel_kind", "u7_cc_mail", "u7_reminder_loc", "s6_questions", "s6_emails"],
})
E2E_NOTES.update({
    359: "The flag shows on the meeting in the Meetings page with up to 3 suggested times",
    372: "Tempoloom sends the cancel email itself, because it writes calendars without the provider's guest emails; it needs SMTP_URL, and without it the page offers no email. Rules attached to an existing series leave the series on the calendar, so that delete offers no cancel email",
    374: "The attention list is at the top of the Meetings page",
    389: "The date replaces the rolling days; it is not limited to 100 days",
    390: "Recovery buffers: \u201ca team link keeps the longest recovery buffer among its organizers free\u201d; travel time uses the person's travel buffer automations and applies when the chosen or default location option is of kind address",
    420: "CC guests are invited to the event and get the booked, rescheduled and cancelled emails (they need SMTP_URL); the location choice shows when the link has several",
})
PARTIAL.update({
    364: "A resize of one occurrence in the calendar is kept and locks it, with full UI E2E on CalDAV (\u201c" + T["u7_manual"] + "\u201d); a resize of the following or all occurrences of a series does not change the meeting's duration yet",
    368: "Title and time edits in the calendar are kept and free/busy is written back, with full UI E2E on CalDAV (\u201c" + T["u7_manual"] + "\u201d); privacy is not written back, because meetings have no visibility setting yet (row 342)",
})
BLOCKED.update({
    392: "Meet, Zoom and Gong options need the vendors' developer apps and test accounts (integrations-video-conferencing.md). The other options have full UI E2E on CalDAV: address, phone and other (text or URL), with a default and the booker's choice (\u201c" + T["u7_locations"] + "\u201d)",
    398: "A conference link needs Meet or Zoom, which need the vendors' developer apps and test accounts. The rest has full UI E2E on CalDAV: a busy event with the booker and CC guests invited, the chosen location and the manage links (\u201c" + T["u7_locations"] + "\u201d; \u201c" + T["b_book"] + "\u201d)",
})
# --- end U07 ---

GOOGLE_PENDING = "Google E2E pending: the service-account key is not available yet (1Password token missing)."

def e2e_status(row_id, tests):
    tests = "; ".join(f"\u201c{T[k]}\u201d" for k in tests)
    note = f" {E2E_NOTES[row_id]}." if row_id in E2E_NOTES else ""
    return "done (CalDAV)", f"Full UI E2E passes on CalDAV (Radicale): {tests}.{note} Google Calendar run pending (service-account key)."

def unit_status(row_id, extra):
    return "partial", "Implemented; unit or property tests only, no E2E yet." + (f" Limits: {extra}." if extra else "")

# The status maps and how each one writes its row. status() and check_one_map_per_row()
# both use this list, so a new map is checked as soon as it gives a status.
STATUS_MAPS = [
    (E2E, e2e_status),
    (PARTIAL, lambda row_id, reason: ("partial", f"{reason}.")),
    (GOOGLE_ROWS, lambda row_id, reason: ("partial", reason)),
    (UNIT, unit_status),
    (BLOCKED, lambda row_id, reason: ("blocked", f"{reason}.")),
]

def status(row_id, spec_file, notes):
    for m, row_status in STATUS_MAPS:
        if row_id in m:
            return row_status(row_id, m[row_id])
    if "non-goal" in notes.lower():
        return "blocked", "Non-goal by decision (billing, payments or mobile apps)."
    if spec_file.startswith("integrations-"):
        return "blocked", "Not implemented yet; needs the vendor's developer app and a test account."
    return "blocked", "Not implemented yet."

def check_one_map_per_row():
    order = [m.name for m, _ in STATUS_MAPS]
    assert set().union(*WRITES.values()) <= set(order), "a StatusMap is missing from STATUS_MAPS"
    dups = {r: [n for n in order if n in names] for r, names in WRITES.items() if len(names) > 1}
    if dups:
        for r in sorted(dups):
            print(f"row {r} is in more than one status map: {', '.join(dups[r])}", file=sys.stderr)
        sys.exit(f"{len(dups)} rows are in more than one status map; keep each row in one map")

def main():
    check_one_map_per_row()
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
