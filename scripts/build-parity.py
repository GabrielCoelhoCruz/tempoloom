#!/usr/bin/env python3
"""Builds docs/parity.md from docs/parity-src/ (one row file per spec group)
and the status map below. Run: python3 scripts/build-parity.py

Status rules:
  done (CalDAV) = a full UI E2E test passes against a real CalDAV server (E2E map).
  done (Google) = done (CalDAV), and every test of the row also passed in the recorded
                  Google Calendar run (GOOGLE_RUN_STATUS, read from docs/e2e-google-run.tsv)
                  and its test() call did not change since the run commit.
  partial       = implemented in part, or proven by unit tests only (PARTIAL, UNIT,
                  GOOGLE_ROWS); the reason says what is missing.
  blocked       = not implemented yet, or a non-goal; the reason says which.

Each row id goes into exactly one status map (E2E, PARTIAL, GOOGLE_ROWS, UNIT or
BLOCKED). The maps record every write, and the build fails when a row was ever
written to two of them, even if a later pop removed it from one.
"""
import re, sys, glob, os, json, subprocess

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
    "split": "places a split task in work hours and keeps it after reload and restart (SPEC-PLANNING-01 AT 1)",
    "meeting": "moves a chunk away from a new meeting and never touches the meeting (SCH-1, SCH-55)",
    "drag": "a drag in the planner moves the chunk and locks it there (CED-50, LCK-2)",
    "done": "mark done removes future chunks; delete removes the task (TSK-40, TSK-42)",
    "later": "deleting a chunk in the calendar places the work again later (CED-20, CED-23)",
    "habit": "a habit sits at its ideal time each weekday and moves when blocked (SPEC-HABITS-01 AT 1, 2)",
    "buffer": "a recovery buffer follows a meeting with attendees (SPEC-BUFFERS-01)",
    "focus": "focus time fills the weekly goal within daily limits (SPEC-FOCUS-01 AT 1)",
    "t_title": "a task with only a title gets P2, a due date in 3 days and work-hour chunks (TSK-1, AT-T3)",
    "t_prio": "a P1 task takes the first free slot ahead of a P4 task, and due dates order one level (PRI-1, PRI-4)",
    "t_start": "start after delays the first chunk (TSK-15)",
    "t_next": "a next-up task goes before other tasks of any level (PRI-6, SCH-67)",
    "t_late": "work that misses its due date goes late, turns busy and shows why (TSK-21, DEF-12, CNT-1)",
    "t_free": "a chunk with room to spare stays free; the last chance turns busy (DEF-10, DEF-11)",
    "t_more": "add time places more work and reopens a done task; filters show each state (TSK-30, TSK-41)",
    "t_huge": "a chunk too long for any hours range is not placed and shows the reason (SCH-116)",
    "t_notes": "task notes go into the event description (CNT-10)",
    "t_personal": "a task on personal hours is placed in the evening (HRS-1)",
    "c_invite": "unanswered and declined invitations do not block; accepted ones do (SCH-20, SCH-21)",
    "c_allday": "free events do not block; a busy all-day event blocks its whole day (SCH-22, SCH-25)",
    "c_tags": "#tl_free opens busy time to tasks; #tl_busy closes free time, in title or description (SCH-23, SCH-24, events-tags 1-12)",
    "c_move": "moving a chunk in the calendar locks it there; the planner shows the lock (CED-1, LCK-4)",
    "c_lock": "lock and unlock from the planner details panel (LCK-10, LCK-41)",
    "c_title": "a title edit of a chunk in the calendar is put back (CED-41)",
    "c_second": "a second calendar blocks time only when it counts for availability (SPEC-ACCT-01)",
    "h_weekly": "a weekly habit uses its days, its notes, and always-busy defense (SPEC-HABITS-01 rules 9-25)",
    "h_free": "an always-free habit stays transparent (DEF-21)",
    "h_skip": "skip removes one day; a calendar delete finds another time; a calendar move locks (rules 26-31, CED-24)",
    "h_off": "turning a habit off removes its future events, on brings them back, delete removes it (rules 34-36)",
    "h_conflict": "with no room, one habit is kept as a marked conflict and another is removed (rule 17, CNT conflict marker)",
    "h_words": "keywords skip days with a matching event; a start date delays the first day (rules 16, 35)",
    "s_hours": "editing work hours moves existing events into the new hours (HRS-1, HRS-7)",
    "s_custom": "a custom hours set can hold a task (HRS-8, HRS-9)",
    "s_window": "a shorter planning window leaves later work unplaced, with the reason (WIN-1, WIN-6)",
    "s_pause": "pausing stops new placements; resuming plans again (pause spec)",
    "s_break": "a break keeps a gap between task and habit events (buffers-breaks rule 1)",
    "s_focus": "work habits count toward focus time; a deleted focus block is not reused (SPEC-FOCUS-01 AT 2, rule 21)",
    "s_prep": "a prep buffer sits before a meeting but not between back-to-back meetings (buffers rules 8-10)",
    "s_zone": "changing the time zone moves the work day (timezones spec, HRS-13)",
    "b_book": "a visitor books a time without signing in; the event lands on the calendar and a task moves away (booking-links rules 10-13, 22-23)",
    "b_prio": "link priority decides which managed time it offers (availability rule 12)",
    "b_limit": "a daily limit closes the day after one booking; a hidden link is unlisted but works (rules 6, 9)",
    "b_resched": "the visitor reschedules and then cancels from the manage page (rules 16-18)",
    "m_follow": "copies follow the source: create, label, skip rules, move, delete, put back, turn off (rules 14-43)",
    "m_two": "details mode copies the title; two-way mirroring never copies a copy (rules 15, 26)",
    "x_cost": "the meeting cost calculator computes, rejects bad input and resets (tools-meeting-cost-calculator rules 1-6)",
    "x_timer": "the pomodoro timer runs sessions and breaks, counts them and keeps them after reload (tools-pomodoro-timer)",
    "x_stats": "stats sum meetings, tasks and habits for a chosen range (analytics-personal-stats rules 1-9)",
    "x_prio": "a lowered external event is offered only by higher-priority booking links (events-external-priority rules 1-5, 9)",
    "x_travel": "travel time wraps events at an address; flights get airport time instead (buffers-travel rules 1-6)",
    "w_flow": "booking, reschedule and cancel send signed requests with custom data; a new secret signs the next one (rules 2-7, 16-18, 23)",
    "w_retry": "a failing receiver gets retries with one request id and Retry-After; too much custom data is dropped; removed and deleted endpoints stop (rules 2, 6, 8-10, 20)",
    "m_sync": "a weekly meeting sits at the ideal time, moves around a colleague's busy time but not an unanswered invite, and moves the colleague's habit (rules 4-5, 8, 10-16, 27; MEET-02 1, 17, 27)",
    "m_hours": "a colleague's meeting hours limit the time, a full slot shrinks to fit, optional guests do not count, and skip or delete drop one period (rules 11, 16-17, 35; MEET-02 20)",
    "lib_habit": "a habit entry fills the habit form; saving places it and shows Added; a second use gets a suffix; delete clears the badge (rules 3-5, 9; T1, T4)",
    "lib_other": "buffer and focus entries add their automation as set; prompts offer no action (rule 4, entries 3, 21, 25)",
    "c_paint": "managed events take their category color, a new color repaints them, and external events change color only for the scope all events (rules 1, 4, 6-8, 11)",
    "c_buffer": "a buffer for external meetings adds prep before a meeting with another domain only (rule 14; library entry 13)",
    # Teams (tests/e2e/team.spec.ts, directory.spec.ts)
    "tm_invite": "an invitation by email adds an existing user at once and a new person after sign-up; members are refused (rules 1, 3-6, 9, 10; edge case 3; T1)",
    "tm_revoke": "a copied invite link works until it is revoked; a revoked link adds nobody (rules 7, 8; edge case 4; T2)",
    "tm_request": "a same-domain user asks to join; the admin approves with admin rights or rejects; other domains see nothing (rules 12-14; edge case 7; T3)",
    "tm_auto": "automatic join adds a same-domain user at once with no review; invite only hides the team (rules 15, 16; T4)",
    "tm_leave": "the sole admin cannot leave or drop the admin role; a member leaves and keeps habits and events (rules 17-19; edge cases 1, 2; T5)",
    "tm_roles": "an invitation can grant the admin role; an admin gives and removes the role and removes a member; members cannot; the seat bar frees a seat (rules 4, 21, 22, 25; T6)",
    "tm_perm": "team settings are for admins only; with invite permission for admins only a member cannot invite, with all members a member can (team settings rules 1, 12)",
    "tm_colleagues": "people of the same domain who are alone are offered for a new team, and each gets one invitation (rule 2)",
    "tm_seats": "over the seat limit, scheduling goes on but invitations stop (rules 24, 27; edge case 8; T7)",
    "dir_scim": "SCIM provisioning adds people with attributes and no seat until sign-in; updates and deactivation follow the directory (rules 6-8, 16; edge cases 1, 6)",
    # Analytics (tests/e2e/team-stats.spec.ts, org-analytics.spec.ts)
    "an_team": "team stats show averages over the included members of last week, with no names, a time-in-meetings distribution, and no values for small teams (team stats rules 1-6, 8, 9; T1-T4)",
    "an_future": "team stats for a future week count planned tasks, recovery buffers and travel, with each member's days and work hours in their own time zone (rule 7; edge case 4)",
    "an_org": "organization analytics group last week by department, manager line and person, filter by custom attributes, score focus and fragmentation, cost meetings, trend week over week and export CSV for admins only (rules 1-10, 12; T1-T4)",
    "an_seat": "a future range counts planned breaks and travel; an analytics-only member is counted but the scheduler never changes their calendar (rules 1, 8; open question 4)",
    # SSO and provisioning (tests/e2e/sso.spec.ts, grant.spec.ts)
    "sso_only": "SSO only: people on the team's domain sign in through its identity provider, other sign-ins point them to SSO, and people outside the team keep theirs (rules 2, 3, 5; T1; edge cases 4, 5)",
    "sso_capture": "SSO and other sign-in, with domain capture: members use either, new sign-ups on the domain join the team, others keep their own team (rules 4, 9; T2, T5; edge case 3)",
    "grant_read": "Calendar access attaches each provisioned person's calendar read-only, reads it on a slow cycle until first sign-in and in real time after it, and writes nothing before it (rules 12, 14-17; T3, T4)",
    "prov_api": "The admin provisioning API adds a large import at a paced rate, with attributes and calendars through the grant; only team admins can use it (rules 10, 18)",
    # Team defaults, out-of-office calendars, no-meeting days (team-defaults, ooo-calendar, no-meeting specs)
    "tpl_defaults": "default work and meeting hours go to people who join after the admin saves them; existing members and later changes keep their hours (rules 6, 7, 9, 10, 11; T1)",
    "tpl_focus": "a new member sees the team's habit templates while joining and takes the focus recommendation with a changed goal; existing members see none (rules 4, 8, 9; T2)",
    "tpl_habits": "team habit templates show at the top of every member's habits page; edits and deletes never change habits made from them; only admins manage them (rules 3, 5; edge cases 1, 2; T3)",
    "ooo_copy": "participants come from write access to the shared calendar; a teammate who joins later is enrolled; a full-day absence is copied and follows moves and deletes (rules 2, 4, 6, 7, 10, 13, 14; T1, T2, T4, T5)",
    "ooo_partial": "partial-day absences keep exact times until the admin switches to all-day; all-day busy events count only from the switch on; two calendars get a copy each; the person's managed events move off the time away (rules 9, 11, 12, 16; edge cases 4, 6, 7; T3, T6)",
    "ooo_perm": "members add out-of-office calendars while the team allows it; after an admin switches it off only admins can (rules 1-3; T7)",
    "nm_self": "a #tl_free block keeps habits but not the organizer's flexible meetings or any booking link, even at a lowered priority (rules 1-4)",
    "nm_team": "a team no-meeting day invitation counts for each invitee who answers yes or maybe, not for an unanswered one (rule 8)",
    "org_cover": "organization analytics count a provisioned person who never signed in, through the calendar access, without writing to their calendar (rules 13-15; T1)",
    # Team policies (policies, agendas, fragmentation specs)
    "pol_focus": "a focus policy by department gives members in scope a focus goal from the policy; a directory change moves it (T1, T2; rules 1-4, 9, 11)",
    "pol_scope": "the narrower policy wins; members personalize their goal and keep it when the admin changes the policy; disabling falls back (rules 5, 7, 9; edge cases 1, 5)",
    "pol_buffer": "a buffer policy gives members in scope prep and follow-up buffers by meeting type and a daily break (rules 12, 13; buffers-automation.md rules 19-21)",
    "pol_decline": "auto-decline declines invitations without an agenda at the lead time and keeps the others (T3; rules 14, 17)",
    "pol_remind": "remind lists meetings without an agenda with a draft from the type's template; adjust proposes a shorter meeting (T4; rules 15, 16, 18, 19)",
    "pol_base": "the fragmentation baseline shows the group average of fragmented time on each day of the 4 weeks before (T5; rules 21, 22)",
    "pol_frag": "an enabled fragmentation policy places new habits of members in scope next to busy time, within each member's flexibility (rules 6, 23)",
    # Delegated access and account actions (delegation, account specs)
    "dg_give": "the owner gives a team member access after a confirmation; people outside the team are not offered (rules 1-4; AT-1, AT-4)",
    "dg_switch": "the delegate switches into the owner's account, sees the banner on every page, plans a task on the owner's calendar, and exits (rules 5, 6, 8, 11; AT-1, AT-3; T1)",
    "dg_block": "an acting delegate cannot add or remove accounts, connect calendars, manage API keys, change delegates or delete the account (rule 7; edge cases 4, 5; AT-2)",
    "dg_live": "owner and delegate see each other's changes without a reload (rule 9)",
    "dg_remove": "removing a delegate ends the open acting session; a delegate who leaves the team loses access (rule 10; edge case 1)",
    "dg_ea2": "the assistant sets up a flexible meeting for the executive, on the executive's calendar only (EA T2)",
    "dg_ea4": "an assistant with two executives switches between them; a habit lands on the chosen executive's calendar only (rule 4; EA T4)",
    "acct_add": "a user adds a second CalDAV account and removes it after a confirmation; the main account stays (rules 6-8)",
    "acct_keys": "a personal API key creates a planned task; regenerate replaces the secret; delete revokes it (API keys rules 1-5; AT-1, AT-2)",
    "acct_delete": "deleting the own account needs the email typed, is refused for a sole admin with members, and removes data and future managed events",
    # Team links, round robin, booking pages, team webhooks (team-links, booking-pages, webhooks specs)
    "tl_team": "a team link offers only times when every required organizer is free, invites everyone, and the co-organizer changes their own hours and most fields from the team links group (rules 1-2, 4, 8, 10-11, 22, 25)",
    "tl_opt": "an optional organizer is invited but not checked; another organizer can be host and gets the event (rules 3, 9)",
    "tl_recovery": "a team link keeps the longest recovery buffer among its organizers free, and the link can turn it off (rule 7, availability rule 10)",
    "tl_rr": "a round-robin link offers every pool member's time, names nobody before confirmation, balances the load, and keeps the member on reschedule while they are free (rules 14-20, 23, 26)",
    "tl_pref": "a preferred pool member is chosen first, but a reschedule keeps the member who is still free (rule 16, edge cases 2 and 6)",
    "tl_rr_org": "a round-robin link with organizers checks the required ones, invites all of them, and drops a pool member who leaves the team (rules 13, 18, 26, edge case 3)",
    "bp_starter": "a new booking page gets three starter links with their priorities and durations (booking-links rule 2)",
    "bp_dir": "any member finds every team member's booking page and public links in the directory and copies one (EA rule 5)",
    "bp_brand": "branding: the admin uploads a logo and banner and sets the team default; the page copies it, the link setting wins, and a member can choose custom (rules 25-31)",
    "wh_team": "only a team admin manages endpoints in Team settings > Webhooks; a member attaches one to their own link (rules 1, 4; acceptance test 6)",
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
})

# Row id -> reason, for rows that cannot work yet because a feature they build on is missing.
BLOCKED = StatusMap("BLOCKED", {
    630: "Not needed for parity: the reference lists these reports as coming soon (analytics-organization.md rule 16)",
    644: "Needs a Google Workspace domain and a super admin to grant domain-wide delegation; the CalDAV organization grant covers the same need for CalDAV servers (E2E: \u201cCalendar access attaches each provisioned person's calendar read-only\u2026\u201d)",
    645: "Needs a Microsoft 365 tenant and a Microsoft Graph calendar provider, which is not implemented",
    581: "Needs a Slack app and a Slack test workspace",
    217: "No benchmark data: the evidence gives no targets per role (teams-policies.md open question 3)",
    594: "No benchmark data: the evidence gives no targets per role (teams-policies.md open question 3)",
    673: "The evidence names it only on the pricing page and gives no behavior to build (plans-feature-inventory.md open questions); org-chart data exists through SCIM managers",
    591: "Needs a Slack app and a Slack test workspace",
    592: "Needs a Slack app and a Slack test workspace",
})

# Row id -> limits, for rows implemented with unit or property tests only.
UNIT = StatusMap("UNIT", {
})

GOOGLE_ROWS = StatusMap("GOOGLE_ROWS", {
})

# Round 3 rows. Each block adds rows with T.update, E2E.update, E2E_NOTES.update,
# PARTIAL.update and BLOCKED.update. A row goes into one status map only; to move a row,
# delete it from the map where it was (a pop is not enough: check_one_map_per_row fails).

# --- s1: automations and event settings ---
T.update({
    "s1_list": "the automation list groups every type by priority, filters by type, and keeps focus time in P4 (rules 1, 6-10; PRI-54)",
    "s1_drag": "dragging an automation changes its rank or its priority, and the scheduler follows the new order (rules 7, 14, 16; AT 2)",
    "s1_off": "turning an automation off removes its future events and keeps its settings; remove asks first, then deletes it and its future events (rules 11-13; AT 4)",
    "s1_added": "a library entry opens the shared form with its preset; Added follows the template, so a rename keeps it and a hand-made automation with the same name does not get it (rules 1-3; library rule 4)",
    "s1_habit_es": "a habit puts its emoji, category, color, visibility, location and reminders on every event, on the calendar chosen at creation (habits concepts; NTF-14; CNT-21; colors rule 9)",
    "s1_focus_es": "a focus automation writes its title, emoji, description, visibility, reminders and calendar, and a rename renames its events (focus concepts; E-0070)",
    "s1_kinds": "each managed event kind starts with its reminders and visibility, and a buffer's can change (NTF table, NTF-10, NTF-14; buffers reminders and visibility; travel outputs)",
    "s1_task_color": "a task color overrides the category color of its chunks, in every plan run (colors rule 9)",
    "s1_category": "a habit's category decides its stats group and whether it counts toward focus time (habits concepts: category)",
    "s1_done": "an ended habit event gets the done marker; an ended task chunk gets the partly done marker until the task is done (marker table; rules 2, 5)",
    "s1_types": "travel buffers, flights Tempoloom may edit and personal mirror copies get their markers once (marker table; rules 2, 8)",
    "s1_emoji": "a template's emoji shows in the form and can be removed; the user's own emoji stays after the state marker (rules 3, 4)",
    "lib_other": "buffer and focus entries add their automation as set; prompts offer no action (rule 4, entries 3, 21, 25)",
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
})
# --- end s1 ---

# --- s2: habit actions, focus and buffers ---
T.update({
    "s2_make_habit": "a solo recurring event becomes a habit from the planner; a series with guests offers a flexible meeting instead (rules 6, 8; PLN-11)",
    "s2_reschedule": "reschedule places one occurrence at the legal slot nearest the chosen time and keeps it there (rule 30)",
    "s2_edit_habit": "edit habit opens the habit of any of its events; the edit moves its future events only (rules 5, 6)",
    "s2_done": "an ended habit occurrence gets the done marker; future ones keep their state marker (Outputs; title markers rule 2)",
    "s2_monthly": "a monthly habit is placed once a month, on a day of the month or on the nth weekday (frequency; executive monthly reviews)",
    "s2_habit_tasks": "a habit carries a saved task search: its events list the matching tasks, live, and placement does not change (rule 40; NXT-40 to NXT-44)",
    "s2_focus_modes": "proactive focus stops at the daily limit and shows the goal is not reached; reactive protects free time only when it runs short (rules 1-10, 35; Outputs)",
    "s2_focus_decline": "auto-decline declines unanswered invitations over focus time with the message; the focus event stays (rule 23; AT 8)",
    "s2_focus_tasks": "focus time carries one task search: every focus event lists the same tasks, and the planner shows them while focus runs (rule 24; NXT-40 to NXT-44, AT 6)",
    "s2_overload_daily": "a daily meeting limit turns the rest of that day into focus time, declines invitations there, and removes it when meetings drop (rules 11-15, 23; AT 7; NXT-45)",
    "s2_overload_weekly": "the meeting load cap entry fills the form; a weekly limit protects the rest of the week once reached (rule 13; library entry 26)",
    "s2_recovery_day": "the recovery day entry caps meetings only on the workday after a heavy meeting day (library entry 8)",
    "s2_filter_describe": "the executive prep entry needs people; a plain-language description fills the filter; the live list follows every change; saving places the buffers (rules 3, 4; event filter; library entry 2)",
    "s2_scope": "calendar scope: a buffer for one calendar skips meetings on other calendars; all calendars covers them (calendar_scope; edge case 3)",
    "s2_runs": "the meeting runs entry adds recovery after a run of back-to-back meetings longer than 90 minutes only (library entry 27)",
    "s2_mirror_travel": "travel time follows what a mirrored copy shows: a copy with details gets it from its tag, a busy-only copy does not (buffers-travel rule 13)",
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
    "s3_another": "the New task form keeps open for the next task with Create another, and closes without it (TSK-5, TSK-6)",
    "s3_suggest": "suggestions-only mode removes task events and lists tasks as Suggested now and At risk (TSK-70, NXT-30 to NXT-33)",
    "s3_nextup": "the next-up task is the one in progress, else the earliest chunk, else scheduler order (NXT-20)",
    "s3_focus_tasks": "in suggestions mode, focus time lists the tasks to work on and tasks get no events (platform-current-version T1)",
    "s3_blocks": "Block time proposes work blocks as a preview; Discard writes nothing, a moved block and Apply write locked events (NXT-50)",
    "s3_timer": "the task timer logs the recorded time as a past event on the chosen calendar only after Log time (PRG-30 to PRG-32)",
    "s3_logged": "time logged with the timer on a task and on a habit counts in stats (analytics-personal-stats rule 15)",
    "s3_delete_hours": "deleting a custom set in use asks for a replacement and moves its items there (HRS-10, AT-H4)",
    "s3_item_hours": "a habit can use item-specific hours that tasks and other items cannot pick (item-specific hours, AT-H6)",
    "s3_preview": "the hours menu of an item editor previews the chosen hours and links to the hours page (HRS-11)",
    "s3_review": "a new user is asked once to review work, meeting and personal hours, and a change there moves events (HRS-15)",
    "s3_utc": "a browser that reports UTC gets a warning and never changes the home zone; an active trip shows on the hours page (planning-hours edge case 6, rules 11-12)",
    "s3_join": "the planner shows the current or next meeting and joins it in one click (PLN-7)",
    "s3_alert": "an event start flashes the tab title, and plays the chime when it is on (NTF-1 to NTF-3)",
    "s3_blocked": "a chime the browser blocks shows a hint (NTF-2)",
    "s3_conflict": "overlapping external events are flagged with a suggested fix and never moved (events-external-priority rule 8)",
    "s3_markdown": "task notes keep their markdown in the calendar, render in the planner and link back to the task (CNT-10 to CNT-14, AT-C1)",
    "s3_timer_link": "a timer link in the focus time description and in habit notes reaches every event (tools-pomodoro-timer rule 19, T5)",
    "s3_profile": "the profile shows account fields read-only and saves job title, company, size and use case (PRF-1, PRF-4, PRF-8)",
    "s3_travel": "a travel zone places habits in its local time on its dates; several entries are allowed, overlaps are refused, and delete returns home (rules 1-7, AT 1, 3, 4)",
    "s3_travel_book": "a booking link offers times in the travel zone on travel days (rule 3, AT 2)",
    "s3_travel_prompt": "the planner prompts for a travel zone when the browser is elsewhere, shows two time columns, and offers to end the trip back home (rules 8-10)",
    "s3_bg_audio": "background audio plays the chosen track during work sessions only (rule 14)",
    "s3_mini": "the mini window shows the running timer and controls it (rule 13)",
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
    "s4_tabs": "the policy list filters by account; an edit rewrites and moves the copies; details warn about admins; delete asks first (rules 6-8, 10, 26, 43)",
    "s4_mesh": "three calendars that block each other take six policies; each event gets one copy on every other calendar and copies never chain; a repeated pair is refused (rules 12, 15; edge case 14)",
    "s4_main_dest": "a destination that is another Tempoloom account's main calendar is refused; that calendar can still be a source (rule 4; AT-10)",
    "s4_labels": "labels follow the event category and the calendar type; an event that invites the destination gets no copy; a color override paints one policy's copies (rules 17, 27, 29)",
    "s4_alerts": "copies never alert: an alert added to a copy is removed; the full reconcile puts back a changed color (rules 30, 38, 39)",
    "s4_family": "guidance covers family calendars and duplicate views; a declined or tagged family event loses its copy for good (edge cases 11, 16; rule 40)",
    "s4_window": "mirroring keeps copies 12 months ahead while planning stops at its own window (WIN-7; rule 14)",
    "s4_shared": "a calendar shared with full access can be added, connected and blocks time; a read-only share is refused (rules 4, 30)",
    "s4_twice": "a calendar that two added accounts can see is listed once, under the account added first (rule 6; AT-8)",
    "s4_category": "each connected calendar has a category that colors its events; the page explains connected calendars versus mirroring (rules 8, 28, 29)",
    "s4_secondary": "a secondary email signs in to the same account; removing it removes its policy, copies and calendars (rules 2, 3, 7; AT-2)",
    "s4_main": "use as main moves the main badge, the locked main calendar and new events; the old email still signs in (rules 10, 11; AT-3; connected calendars AT-7)",
    "s4_taken": "an email that is main in another account cannot become main here; after that account is deleted the retry works (rules 12, 13; AT-4)",
    "s4_several": "an email that two accounts hold as secondary opens neither and offers a new account (rule 3.3; AT-6)",
    "s4_win_limit": "a window limit caps planning but never booking links (plans rule 3; T1)",
    "s4_cal_limit": "a connected calendar limit refuses one more, and a lower limit turns the extras off (plans rule 4; connected calendars plan limits)",
    "s4_counts": "limits on mirroring policies, booking links and automations refuse one more with a message; existing ones keep working (plans rule 4, T2)",
    "s4_feed": "a holiday feed blocks its days; a change in the feed moves work; removing it removes its calendar (rule 11)",
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
    469: ("Copies of events that Gmail made from an email (Google event type fromGmail) are busy, proven by a unit test; CalDAV "
          "has no such events, and an E2E cannot make one: Gmail makes them, and the Google Calendar API cannot create them"),
})
# --- end s4 ---

# --- s5: meeting rescheduling and meeting checks ---
T.update({
    "s5_checks": "each built-in check raises its issue in the planner Issues tab, never changes an event, and an issue resolves when its condition ends (checks conflict, attendee_availability, rsvp_reminder, video_link; rules 5-7)",
    "s5_ignore": "checks are on for a new user; ignore hides one event or the whole series; a disabled check closes its issues and raises no new ones (rules 1-3)",
    "s5_digest": "library entry 'Flag meeting problems' turns on the checks and a daily email digest that lists open, not ignored, issues once a day (rule 6; library entry 9)",
    "s5_company": "a company check from a team admin flags only the meeting's organizer, shows locked to members, and a member can ignore one issue (rules 8-12)",
    "s5_agenda": "library entry 'Agenda drafts' stages a draft that is written only when applied, and the recommendations list shows a skipped habit, an unmet focus goal and a day with too many meetings (library entry 4; platform rule 5)",
    "s5_decline": "a required guest's decline moves the occurrence and an optional guest's does not; each move is logged; guests get an update email only inside the days-ahead limit and while emails are on (MEET-02 rules 2, 31-32, 36; NTF-20 to NTF-22)",
    "s5_limit": "the move limit: with 1 move per day a second conflict is flagged with suggested times and a suggestion applies as a locked move; with no automatic moves the meeting stays and is flagged (MEET-02 rules 9-11, 17)",
    "s5_adopt": "meeting rules attach to an existing recurring meeting the user organizes: the form is filled from it, the series keeps its id and gets tl_meeting, and Tempoloom moves its instances around a conflict (MEET-01 rules 1, 3, 39)",
    "s5_daily": "the daily emails list meetings at risk in the next 14 days and new recurring meetings that could become flexible; the email's link opens the form filled from that series (MEET-02 rule 35; NTF-30)",
    "s5_starts": "start times limit flexible meetings and booking pages to the chosen minutes, and a change does not move meetings placed before it (rules 1-3, 6)",
    "s5_nomeet": "the weekly no-meeting day from the library writes one weekly all-day busy #tl_free series: habits keep the day, flexible meetings and booking links stay off it every week, and removing it ends that (events-tags.md rules 3-7; library entry 33)",
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
# --- end s5 ---

# --- s6: booking links ---
T.update({
    "s6_questions": "screening questions: the owner adds them, the booker must answer the required one, and the answers reach the event (questions, rules 12-14)",
    "s6_redirect": "redirect after booking: the confirmation shows, then the browser opens the https page 7 seconds later; an http URL is refused (rule 15, edge case 8)",
    "s6_emails": "booking, reschedule and cancel email the booker and the organizer, each in their own time zone, with the actions for the booker only (rules 14, 16, 18; page rules 19-21)",
    "s6_mail_brand": "booking emails use the link's branding: the team logo with the homepage link, or no logo (page rules 23, 25, 31)",
    "s6_reminder": "the reminder email reaches the booker once at its time with the message; a booking made before the setting gets it, a cancelled one never (rule 21)",
    "s6_zone": "time zone picker and time format: the actual zones come first, times convert, and both choices survive a reload (page rules 6-8)",
    "s6_params": "URL parameters choose the time zone, duration, day and time; invalid or unavailable values are ignored (page rule 9, edge case 1)",
    "s6_overlay": "overlay my calendar: a signed-in booker sees their own events next to the times, never the organizer's; signed-out bookers get no switch (page rules 10, 32-33)",
    "s6_inspect": "the availability inspector shows organizers every time with a dot per failed check, explains each and links its setting; others never see it (availability rules 18-22)",
    "s6_cards": "link cards show title, durations and priority with their actions, grouped by page; the priority changes from the card and the booking page follows (rules 5, 6, 9)",
    "s6_groups": "a link group gets its own booking page with its links, and a booker books from it (sharing rules 1-3, 7, edge case 4)",
    "s6_groups_edit": "editing a group warns before it breaks URLs; old URLs stop working; delete moves or removes the links (sharing rules 4-6)",
    "s6_oneoff": "a one-off link has its own settings and prefilled invitee, stays unlisted, leaves the source unchanged, counts against its limits, and the creator edits it from its URL (sharing rules 8-13, 16, 31-32)",
    "s6_expiry": "a one-off link expires 30 days after creation: its URL then shows an expired page with no times (sharing rule 14)",
    "s6_times": "shared times: up to 5 dates, offered times as buttons or text, merged text ranges, time links that open the booking page, and the last template kept (sharing rules 17-22)",
    "s6_share": "the share menu copies the URL and opens an email draft and the social networks' share pages with it (sharing rule 23)",
    "s6_embed": "website embeds: script, object, iframe and URL load the booking page with its branding on another site; the script resizes its frame; a booking in the embed reaches the calendar (sharing rules 24, 26)",
    "s6_embed_redirect": "embed redirect modes: none stays, top page sends the whole page to the redirect URL, frame moves only the frame; the last mode is remembered (sharing rule 25)",
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
    "s7_mcp_read": "an MCP client with an API key reads the schedule, free time, the week summary and meeting context (SPEC-ASSIST-03 rules 1-3, T1, T2)",
    "s7_mcp_stage": "a write from an MCP client is staged, not written; the user accepts and applies it in the planner (SPEC-ASSIST-03 T3, T4; SPEC-ASSIST-02 rules 1, 4-8)",
    "s7_final": "the final list applies only what stays in it; attendees hear only at apply (SPEC-ASSIST-02 rules 6-9, T3)",
    "s7_stale": "a staged change whose event moved after staging is skipped as stale (SPEC-ASSIST-02 rule 12, T5)",
    "s7_readonly": "a read-only server lists no write tools, refuses a write and stages nothing (SPEC-ASSIST-03 rule 9, T5; SPEC-PLANS-01 T3)",
    "s7_manual": "preview mode turned on by hand stages a drag; turning it off keeps it pending after reload; apply writes it (SPEC-ASSIST-02 rules 3, 10, 11)",
    "s7_auto": "with preview mode on, a new habit shows its calendar impact and writes nothing until apply; turning it off is staged too (SPEC-ASSIST-02 rule 2, T6)",
    "s7_help": "the help index groups common problems and links each to its fix (SPEC-SUPPORT-01 rules 1-6, 17-20)",
    "s7_lookup": "looking up an event by its link shows what Tempoloom knows and its change log (SPEC-SUPPORT-01 rules 7-12, AT-1 to AT-3)",
    "s7_hint": "a new user sees the advice to turn off other scheduling tools until they dismiss it (SPEC-PLATFORM rule 17)",
    "s7_stats": "stats split solo work into deep and shallow, count breaks, travel and time away, and name people met (SPEC-ANALYTICS-01 T1, T2, rules 1, 4, 6-8, 12-13)",
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
})
# --- end s7 ---

# --- s8: automation types ---
T.update({
    "s8_types": "the list shows all six types: meeting overload pinned to P4, meeting checks in Meeting quality with no priority and no Remove; the type filter covers every type after a reload (rules 6-11; row 299)",
    "s8_overload": "a meeting overload's list entry opens its editor, ranks against focus time in P4, turns it off and on, and removes it, each with its effect on the calendar (rules 8, 11-15; focus-time rules 12, 29)",
    "s8_checks": "a built-in meeting check turns off and on from the list: its issues leave and return in the Issues tab, the meeting checks page follows, and a check that is off by default turns on (meeting quality rules 1-2; rules 9, 11)",
    "s8_company": "a company check shows locked in the Meeting quality section: the admin turns it off and removes it from the list, a member gets no actions and sees each change (meeting quality rule 11; rules 9, 11, 13)",
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

# --- U09: library entries, stats panels, tools ---
T.update({
    "u9_lib_habits1": "library habit entries 11, 35, 36, 43, 45, 46 add habits with their presets: wrap-up at the end of work hours, Lunch inside 11:30 to 14:00",
    "u9_lib_habits2": "library habit entries 40, 41, 42, 44 add habits with their presets: walk, exercise in personal hours, coding at P2, email at P4",
    "u9_lib_buffers": "library buffer entries 1, 10, 19 add buffers after large meetings, around flights and after long meetings only",
    "u9_lib_external": "library buffer entries 28, 29, 30 anchor on external meetings: travel only at an address, prep before, debrief after",
    "u9_lib_focus": "library focus entries 7 and 23 place their weekly goal inside the 09:00 to 12:00 window, and the window stays on edit",
    "u9_lib_meetings": "library entries 32, 34 and 37: flexible meetings repeat at their period with the guests, and the priority link offers time over P3 and P4 habits",
    "u9_lib_mirror": "library mirroring entries 38 and 39 copy busy time only between job calendars, both ways, never copying a copy",
    "u9_timer": "the pomodoro timer plays the chosen alarm, resets a running session without counting it, and shows the stats view with streak, completion rate and a chart (rules 7, 9, 17; T3)",
    "u9_planned": "planned time is the calendar when the day began and actual time is what stayed; only ended days count",
    "u9_weekly": "the weekly report goes out once in the first work hour of the last workday, with the week's totals and the calendar facts of the stats page; the user can turn it off",
    "u9_balance": "stats show work-life balance (personal habits, meetings outside work hours, time away) and highlights (focus held, link bookings, breaks, travel) for a chosen range",
})
E2E.update({
    719: ["u9_lib_buffers"], 728: ["u9_lib_buffers"], 737: ["u9_lib_buffers"],
    746: ["u9_lib_external"], 747: ["u9_lib_external"], 748: ["u9_lib_external"],
    753: ["u9_lib_habits1"], 754: ["u9_lib_habits1"], 761: ["u9_lib_habits1"],
    763: ["u9_lib_habits1"], 764: ["u9_lib_habits1", "lib_habit"],
    758: ["u9_lib_habits2"], 759: ["u9_lib_habits2", "lib_habit"], 760: ["u9_lib_habits2"],
    762: ["u9_lib_habits2"],
    752: ["u9_lib_meetings"], 755: ["u9_lib_meetings"],
    604: ["u9_balance"], 607: ["u9_balance", "s7_stats"],
    704: ["u9_timer", "x_timer"], 708: ["u9_timer"], 712: ["u9_timer"],
    610: ["u9_planned"], 634: ["u9_weekly", "s7_stats"],
})
E2E_NOTES.update({
    764: "The 11:30 to 14:00 window is item-specific hours on workdays",
    746: "An external meeting with an address: the buffer filter is the external meeting category and an address",
    737: "A meeting has at least one other attendee; a meeting of exactly 60 min with exactly one other person gets the break",
    604: "Time away is the work hours that out-of-office time covers",
    610: "The test sets the server clock (TEST_CLOCK_START, test mode only) so that a day begins and ends; time logged with the task timer is a past event of its task (rule 15), so it counts in actual time once (rule 16 decision)",
    634: "Up to 4 facts that apply, in the stats page's order, as colored blocks under the totals; with 5 kinds of facts the fifth does not show; the report counts the week up to the send time; the operator command weekly-reports --now runs one tick of the server's email worker, and one test lets the server's own clock (TEST_CLOCK_START) reach the send hour",
    704: "The timer page changes no calendar event, so the test checks that the calendar stays empty",
    708: "Three alarm sounds made in the browser (Bell, Chime, Digital); the choice stays in this browser",
    712: "The stats come from the session log in this browser; the chart groups by day, week or month",
    607: "Focus time held is the time of focus events; work habits and tasks that count toward the goal are not added",
})
BLOCKED[638] = (
    "Google sign-in is built and follows the team's SSO rules; it has no E2E: the Google Calendar run "
    "(docs/e2e-google-run.md) connects its user with the operator command connect-google-oauth, so "
    "\u201cSign in with Google\u201d on the sign-in page is not tested. Microsoft sign-in is not built: it needs a Microsoft app "
    "registration and a Microsoft 365 account to build and test a Microsoft Graph provider"
)
# Rows whose entry covers only part of its preset (review of PR 10).
PARTIAL.update({
    725: "The entry adds 8 h of weekly focus in a 09:00 to 12:00 window on workdays (E2E: \u201clibrary focus entries 7 and 23 place their weekly goal inside the 09:00 to 12:00 window, and the window stays on edit\u201d). Focus time has no ideal time (focus-time.md), so the mornings are hard hours: with busy mornings no focus goes to the afternoon, where the preset's ideal time would allow it",
    741: "The entry adds 10 h of weekly focus in a 09:00 to 12:00 window on workdays that the user can change (E2E: \u201clibrary focus entries 7 and 23 place their weekly goal inside the 09:00 to 12:00 window, and the window stays on edit\u201d). Focus time has no ideal time (focus-time.md), so the window is hard hours, not an ideal window",
    729: "The entry adds the habit at P3, 30 min on workdays (E2E: \u201clibrary habit entries 11, 35, 36, 43, 45, 46 add habits with their presets: wrap-up at the end of work hours, Lunch inside 11:30 to 14:00\u201d). A habit has one ideal time, read from the latest end of work hours when the form opens; a day whose work hours end earlier keeps that time, not its own last 30 min",
    750: "The entry fills a flexible meeting every 2 weeks, 30 min, P2, that needs at least one guest (E2E: \u201clibrary entries 32, 34 and 37: flexible meetings repeat at their period with the guests, and the priority link offers time over P3 and P4 habits\u201d). It does not check that the guests are external",
    756: "The entry fills the mirroring form with busy-only copies (E2E: \u201clibrary mirroring entries 38 and 39 copy busy time only between job calendars, both ways, never copying a copy\u201d). It adds no two-way behavior: the user adds one policy in each direction",
    757: "The entry fills the mirroring form with busy-only copies (E2E: \u201clibrary mirroring entries 38 and 39 copy busy time only between job calendars, both ways, never copying a copy\u201d). It adds no mesh of calendars: the user adds one policy for each pair",
})
# --- end U09 ---

# --- merge: rows that need the work of more than one stream ---
E2E.update({282: ["s1_habit_es", "s1_task_color", "s4_labels"]})
E2E_NOTES.update({282: "Habits, focus time, buffers and tasks have their own color (stream s1); a mirroring policy has a color override (stream s4)"})
# Rows this round did not build, each with the concrete reason.
BLOCKED[451] = "Needs Google and Microsoft calendar accounts; mirroring between calendars of two CalDAV accounts is built (rows 453, 460)"
PARTIAL[145] = ("Google sign-in takes the name when it makes the user, and each sync takes the time zone from the primary Google "
                "calendar. Not built: the picture is read but not kept or shown, the name does not follow later changes, and week "
                "start, time format and date format are not read from Google. Google sign-in has no E2E (row 510). The editable "
                "profile fields are built (row 146)")
BLOCKED[491] = "Needs a Google Workspace account: the trigger is Google calendar sharing"
BLOCKED[492] = "Needs a Google Workspace account: the help covers Workspace sharing and Gmail-made events"
BLOCKED[493] = "Needs Google or Microsoft accounts that subscribe to the iCloud calendar; a CalDAV server connects directly"
BLOCKED[519] = "Needs a Google Workspace domain and a super admin"
BLOCKED[671] = "Needs Google Meet (a Google account and the Calendar conference API)"
for n in [268, 293]:
    BLOCKED[n] = "Needs a Slack app and a Slack test workspace"
BLOCKED[344] = "Needs the vendor apps of third-party agenda tools (Docs notes, Lattice, Fellow)"
for n in [664, 665, 666, 667, 668]:
    BLOCKED[n] = "The pricing page names it and gives no behavior to build (plans-feature-inventory.md open questions); it also needs meeting notes, transcripts or a room provider"
# --- end merge ---

# --- U08: mirroring copy rules, accounts and webhook delivery ---
T.update({
    "u8_answers": "the owner's answer and role decide a copy's free/busy; the no-reply setting applies to every policy; details copy free events (rules 21, 22; account-level setting)",
    "u8_allday": "all-day events: none by default, then busy ones, then all; a copy of an all-day event is all-day (rules 19, 24)",
    "u8_hours": "copy only during work hours: events fully outside are skipped, an overlapping one is copied in full; the checkbox is saved (rule 20)",
    "u8_privacy": "privacy: busy-only copies say Busy with no details; private details copies keep the details, are marked private, and copy free events as free (rules 22, 26)",
    "u8_type": "the calendar type of a policy sets the label and the category color of its copies (rules 27, 28)",
    "u8_resync": "turning a policy off and on runs a full re-sync: a drifted copy and changes made while it was off are all put right (rule 9)",
    "u8_taskcal": "tasks on personal hours go to that set's task calendar; work-hours tasks stay on the main calendar (rule 21, AT-6)",
    "u8_reconnect": "an account whose login stops working shows Disconnected, pauses its policies and nothing else; reconnect resumes them (rules 14-16, AT-5)",
    "u8_urls": "with private receivers off, http, localhost and IP hosts are refused and a public https host is kept; the operator setting allows loopback (fields table, rule 13)",
    "u8_timeout": "an answer after 10 seconds is a failure and is cut at 10 seconds; only 200, 201, 202 and 204 count as success (rules 8, 12, 14)",
    "u8_suspend": "an endpoint that fails for the whole period is suspended, gets no new requests and its admins get an email; Resume sends the waiting request (rule 15)",
})
E2E.update({
    456: ["u8_resync"], 467: ["u8_allday"], 468: ["u8_hours"], 470: ["u8_answers"],
    471: ["u8_answers"], 472: ["u8_answers"], 473: ["m_follow", "u8_answers", "u8_privacy"],
    475: ["u8_privacy"], 476: ["u8_privacy"], 480: ["u8_type"], 506: ["u8_taskcal"],
    934: ["u8_urls"], 936: ["u8_timeout"], 938: ["u8_suspend"],
})
E2E_NOTES.update({
    471: "One setting on the Settings page for every policy, stored with the account settings",
    473: "Label and busy-only copies skip free events; details copies are free",
    476: "Copies get the private class (CalDAV CLASS:PRIVATE, Google visibility private)",
    506: "Each hours set has a calendar for task chunks on the Settings page",
    934: "The E2E server runs with private receivers off for this test (WEBHOOK_ALLOW_PRIVATE)",
    938: "The 24-hour period is a setting (WEBHOOK_SUSPEND_AFTER_SECONDS), 4 seconds in the test",
})
BLOCKED[510] = ("Needs a Microsoft 365 account and a Microsoft Graph provider, which is not built; "
                "Google sign-in (OAuth with PKCE) and Google Calendar sync are built. The Google Calendar run (docs/e2e-google-run.md) "
                "proves sync for a Google user, but it connects that user with the operator command connect-google-oauth, "
                "so \u201cSign in with Google\u201d on the sign-in page has no E2E")
BLOCKED[513] = ("Needs a Microsoft 365 account and a Microsoft Graph provider, which is not built; a second CalDAV account "
                "is added with CalDAV E2E (\u201ca user adds a second CalDAV account and removes it after a confirmation\u201d), "
                "and Google accounts connect through Google sign-in. That test skips on Google, because it adds CalDAV accounts, and "
                "the Google Calendar run (docs/e2e-google-run.md) connects its one Google user with the operator command, "
                "so adding a Google account in the UI has no E2E")
PARTIAL[517] = ("Disconnect, paused policies and reconnect have full UI E2E on CalDAV (\u201c" + T["u8_reconnect"] + "\u201d): "
                "the server rejects the stored password and the user types a new one; a Google account reconnects through Google sign-in "
                "with the account's email as the hint and refuses another identity (unit tests). Items that write to a calendar of the "
                "disconnected account show no error state yet (rule 16): their events stay as they are")
# --- end U08 ---

# --- U03: core planning ---
T.update({
    "u03_spacing": "the time between chunks of a task is a setting: once a day puts each chunk on its own day, 2 hours keeps a 2-hour gap (TSK-14)",
    "u03_calendar": "each hours set has a calendar for task chunks; chunks of tasks in that set go there (TSK-50, TSK-51, HRS-12)",
    "u03_calendar_keep": "a new calendar for task chunks moves placed chunks there at the same times and saves no hours; a calendar that is not the user's is refused (HRS-6, HRS-7, HRS-12, TSK-50)",
    "u03_order": "inside one level meetings go first, then habits, then tasks; a higher level goes before all of them (PRI-1, PRI-3, SCH-62, SCH-64, SCH-70)",
    "u03_urgency": "the urgency setting decides whether a low task that is short of time goes first (PRI-5, SCH-66, SCH-77, SCH-79)",
    "u03_urgency_48": "with the 48-hour urgency mode a low task due within 48 hours goes up one level, a task due later does not (SCH-78)",
    "u03_focus": "focus time goes after a P4 task, keeps the free/busy status set on it, and counts as P2 for booking links (PRI-20, PRI-21, DEF-40)",
    "u03_focus_near": "free focus time stays free inside the 12 hours before it starts (DEF-40)",
    "u03_series": "the level of a recurring external event applies to this event or to the whole series (events-external-priority rule 3, PRI-41)",
    "u03_other": "events of another connected calendar stay P1: the control is disabled with a note, and links never offer their time (events-external-priority rule 4, PRI-42)",
    "u03_meeting_hours": "flexible meetings use meeting hours: a change there moves the meeting, and tasks keep work hours (HRS-1, HRS-7)",
    "u03_ranges": "a day can have several ranges and copy to all copies them to every day that is on; chunks never span the gap (HRS-2, HRS-3, HRS-4, HRS-5)",
    "u03_moved": "a chunk moved in the calendar leaves its old time closed to that task only (CED-10)",
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
PARTIAL[78] = ("Each sync takes the home time zone from the primary Google calendar (src/server/sync/pull.ts), and the hours page "
               "shows the zone that hours apply in and an active trip (E2E on CalDAV and Google: \u201ca browser that reports UTC gets a "
               "warning\u2026\u201d). No E2E or unit test sets a Google Calendar time zone and checks that the home zone follows it")
# Row 90 stays partial: E2E does not cover buffers inside a level.
PARTIAL[90] = "E2E on CalDAV covers flexible meetings, habits, tasks, next-up tasks and focus time in the order (\u201cinside one level meetings go first, then habits, then tasks\u2026\u201d, \u201ca next-up task goes before other tasks of any level\u201d, \u201cfocus time goes after a P4 task\u2026\u201d); buffers inside a level have unit tests only"
# Row 76 stays partial: planning-hours.md says focus time, flexible meetings and
# booking links do not offer item-specific hours "yet", so only habits are built.
# --- end U03 ---

# --- U07: flexible meeting limits and actions, booking link settings ---
T.update({
    "u7_notice": "the move notice: an automatic move never starts sooner than the notice after the move, and a meeting with notice 0 takes the nearest time (MEET-02 rule 8)",
    "u7_notime": "with no time in a period, 'remove' leaves the period empty and 'keep' keeps the occurrence at its time as a marked conflict; both say why in the meeting and in the attention list, and the next period is placed (MEET-02 rules 13, 33)",
    "u7_manual": "manual actions: lock and unlock from the planner hold and free an occurrence; a resize in the calendar is kept and locks; a title edit is kept, a free/busy edit is written back (MEET-02 rules 7, 17-18, 21-22)",
    "u7_delete": "delete asks first: with email the guests get the cancelled times, without email they get nothing; both remove every future occurrence and the rules (MEET-02 rules 27-28)",
    "u7_url": "URL names: a title in use gets -2; the owner renames the URL, the old one stops working and a name in use is refused; up to 3 durations with a default that the page preselects (booking-links rules 4, 5; durations, defaultDuration)",
    "u7_range": "notice and range: no time inside the notice; the last day is a fixed date or today plus the rolling days; both survive a reload (booking-links rangeStart, rangeEnd; availability rule 6)",
    "u7_buffers": "buffers: times that leave no buffer before or after a busy event are not offered; at an address the travel time stays free while the link keeps it, and not after it is turned off (availability rule 10; booking-links rule 28)",
    "u7_locations": "locations, CC and calendar: the booker chooses one of the link's locations and adds CC guests; the busy event goes to the chosen calendar with the location, guests and manage links, and keeps them on reschedule (booking-links rules 12-13, locations, targetCalendar; page details form)",
    "u7_focus": "placed focus time is offered by a P1 link only (availability notes on classes; focus-time rule 32)",
    "u7_preferred": "preferred times: a time with nothing else on the calendar has a green dot and the legend explains it; a time over a free event is offered without the dot (availability rule 15; page rule 5)",
    "u7_travel_kind": "travel time follows the kind of the chosen location: an address keeps it free with or without commas, other text with commas does not, and a booker who picks the address is held to it (availability rule 10)",
    "u7_calendar_kept": "the calendar for booked events is kept when the editor saves while the calendar list cannot load (booking-links targetCalendar)",
    "u7_reminder_loc": "the reminder names the location the booker chose, not the link's default (rule 21; page details form)",
    "u7_cc_mail": "CC guests get the booked, rescheduled and cancelled emails with the chosen location and without the booker's links; an organizer in CC gets no second copy (rule 14; page details form)",
    "u25_privacy": "privacy and free/busy edits in the calendar are written back from the meeting's event settings; the organizer's description, location, color, note and guest edits are kept (MEET-02 rule 22)",
    "u25_move": "an automatic move, a lock and an unlock after the organizer's edits write only Tempoloom's own fields: the description, location, color, note and added guest stay (MEET-02 rules 21, 22, 37)",
    "u25_description": "a description edit alone in the calendar is kept with no lock and no write; lock and unlock keep it, and a later description edit in the form reaches every occurrence (MEET-02 rules 21-23)",
    "u25_settings": "a visibility change and a guest removal in the meeting settings write only those fields: the organizer's description, location, color, note and added guest stay (MEET-02 rule 22)",
    "u7_delete_series": "delete on rules attached to an existing series offers no cancel email: the series stays on the calendar and the guests get nothing (MEET-02 rule 28; MEET-01 rule 39)",
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
    364: "A resize of one occurrence in the calendar is kept and locks it, with full UI E2E on CalDAV (\u201c" + T["u7_manual"] + "\u201d). A resize of the following or all occurrences is not built: that scope is a choice of a recurring-series edit, and Tempoloom writes each occurrence as its own event (row 320), so no calendar offers the scope on its events",
    368: "Full UI E2E on CalDAV proves: a title edit and a resize are kept and lock the occurrence (\u201c" + T["u7_manual"] + "\u201d); privacy (CLASS) and free/busy edits are written back from the meeting's event settings, and the organizer's edits of description, location, color (COLOR), note (COMMENT) and an added guest stay through that write-back (\u201c" + T["u25_privacy"] + "\u201d), through an automatic move, a lock and an unlock (\u201c" + T["u25_move"] + "\u201d), and through a visibility change and a guest removal in the meeting settings (\u201c" + T["u25_settings"] + "\u201d); a description edit alone does not lock and gets no write, and a later description edit in the form replaces it on every following occurrence (rule 23; \u201c" + T["u25_description"] + "\u201d). Tempoloom writes only the fields it changed, through the provider's patch call, also on Google and on instances of an adopted series; these two have no E2E here. Not tested: a guest removed by the organizer. Not built: recurrence edits and the scope choice (one, following or all occurrences), because Tempoloom writes each occurrence as its own event, not as one recurring series (row 320)",
})
BLOCKED.update({
    392: "Meet needs a Google account and the Calendar conference API; Zoom needs a Zoom developer app and a Zoom test account; Gong needs a Gong app and a Gong test organization. The other options have full UI E2E on CalDAV: address, phone and other (text or URL), with a default and the booker's choice (\u201c" + T["u7_locations"] + "\u201d)",
    398: "A conference link needs Google Meet (a Google account and the Calendar conference API) or a Zoom developer app and a Zoom test account. The rest has full UI E2E on CalDAV: a busy event with the booker and CC guests invited, the chosen location and the manage links (\u201c" + T["u7_locations"] + "\u201d; \u201c" + T["b_book"] + "\u201d)",
})
# --- end U07 ---

# --- U16: mirroring rows that said only "Not implemented yet" ---
T.update({
    "u16_onboarding": "onboarding offers a first mirroring policy with one source and one destination (rule 11)",
    "u16_one_item": "the planner shows a source event and its copy as one item with the source details (rule 33)",
    "u16_p1": "copies and events on other connected calendars stay P1 (rule 34)",
    "u16_not_now": "Not now hides the first mirroring offer for good (rule 11)",
})
E2E.update({
    458: ["u16_onboarding", "u16_not_now"],
    485: ["u16_p1"],
    298: ["u03_other", "u16_p1"],
})
E2E_NOTES.update({
    458: "Tempoloom decision: the offer is a planner hint, shown while the user has no policy and has at least two calendars; the other policy fields keep their defaults. Not now hides it after a reload too",
    485: "A main-calendar event that is mirrored is one item with its copy (mirroring rule 33): its priority control is disabled at P1 with a note, because the copy keeps the time at P1. An event on another connected calendar is disabled at P1 with a note; a main-calendar event that is not mirrored keeps the control. The API refuses a level for the mirrored event, and a copy is not an external event for it",
    298: "Tempoloom decision: copies are not separate planner items (mirroring rule 33), so a mirrored event and its copy are one item. Its control is disabled at P1 with a note that the copies count as P1; the control of an event on another connected calendar is disabled at P1 with a note. The API refuses both",
})
BLOCKED.update({
    484: "The add-on part needs a Google Workspace Marketplace add-on (Calendar and Gmail) and a Google Workspace test account. The planner part has full UI E2E on CalDAV: the source event and its copy are one item that names its calendar, the calendars it is copied to and its details (\u201c" + T["u16_one_item"] + "\u201d)",
})
# --- end U16 ---
# --- U04: habits, focus time and buffers (first half of the partial rows) ---
T.update({
    "u4_hours": "a habit uses a named hours set or its own window, and a change of hours moves its events (rules 9-10; hours concept)",
    "u4_custom": "a custom frequency places a habit every N days, every N weeks on its days, or every N months (Frequency: custom)",
    "u4_move_day": "a weekly occurrence with no room on its day moves to the nearest other day of that week (rule 14)",
    "u4_adaptive": "an adaptive habit is free while it has room and turns busy when the calendar fills (rules 21-22, DEF-20)",
    "u4_lock": "lock and unlock one habit occurrence from the planner (rule 26, LCK-10)",
    "u4_progress": "the stats page shows each habit's progress: done and planned occurrences and hours (habit analytics)",
    "u4_focus_len": "focus blocks keep the shortest and longest length and stay in their hours set (rule 3; hours concept)",
    "u4_focus_accept": "an accepted invitation over focus time moves it; an unanswered one does not (rules 18-19)",
    "u4_focus_lock": "moving a focus event in the calendar locks it; a new event over it does not move it (rule 20)",
    "u4_focus_order": "focus time is placed after every other item, ranks in P4, and counts as P2 for booking links (rules 29-32)",
    "u4_focus_tag": "an event with the focus tag counts toward the weekly goal (counted time; #tl_focus)",
    "u4_buffers": "a user keeps several buffer automations, each with its own free or busy and visibility (rule 1; show_as, visibility)",
    "u4_buffer_prio": "a P1 buffer takes the time of a P3 habit; a P4 buffer gives way to it (rules 11, 17)",
    "u4_buffer_conflict": "the conflict setting keeps a buffer with the conflict marker or removes it (rule 16)",
    "u4_travel_len": "the user sets the travel length; travel time is skipped where a busy event blocks it (travel rules 3, 9)",
    "u4_flight": "an event set to the flight category by hand gets airport time instead of travel time (travel rules 4-6)",
    "u4_travel_keep": "travel buffers follow their event and keep a length the user changed (travel rules 10-11; buffers rule 14)",
    "u4_buffer_lock": "a buffer moved and resized in the calendar locks there and stops following its event (CED-1, CED-2; buffers rule 14)",
})
E2E.update({
    154: ["u4_hours", "s3_item_hours"], 156: ["habit", "h_weekly", "s2_monthly", "u4_custom"],
    161: ["u4_move_day"], 165: ["u4_adaptive"], 178: ["u4_lock"], 193: ["u4_progress", "s1_category"],
    196: ["u4_focus_len"], 197: ["u4_focus_len"], 202: ["u4_focus_accept"], 203: ["u4_focus_lock"],
    206: ["u4_focus_order"], 209: ["u4_focus_tag"], 219: ["u4_buffers", "u4_buffer_conflict"],
    225: ["u4_buffer_prio"], 226: ["u4_buffer_conflict"], 228: ["u4_buffers"],
    238: ["u4_travel_len"], 242: ["u4_flight"], 243: ["u4_travel_keep", "u4_buffer_lock"], 244: ["u4_travel_len"],
})
E2E_NOTES.update({
    156: "Custom is every N days, weeks or months, set with Interval in the habit form and counted from the start date (or the save date) when the interval is first saved; a later start date keeps the cadence",
    193: "Each habit shows its events in the range, how many have ended, and their hours; work and personal habit hours are in the time breakdown",
    206: "On the booking side a placed focus event counts as P2: a P1 link offers its time and a P2 link does not",
    238: "One travel length in the travel buffer's form sets both sides: 5 to 240 minutes, step 5, 30 by default",
    243: "A length changed at the buffer's free edge is kept for that event while the event exists, and the buffer does not lock; a buffer moved off its event locks",
})
BLOCKED.update({
    208: "Needs a Google Workspace account: native focus-time events exist only in Google Calendar. Their event type is counted in code, and on CalDAV the focus tag gives the same result (row 209)",
})
# --- end U04 ---

# --- U05: event tags, time away, colors, markers and external priority ---
T.update({
    "u5_tags": "travel tags in the title, the description and the user's own RSVP note add travel time; #tl_flight adds airport time and #tl_trip only the travel category, also at an address; a removed tag removes its buffers (events-tags rules 16-18, places 1-3, edge cases 4-5)",
    "u5_quick": "a busy event titled only #tl_busy turns free and still keeps tasks out; a longer title stays busy (events-tags rules 11-15)",
    "u5_focus": "an event tagged #tl_focus counts toward the weekly focus goal, so less focus time is placed (events-tags rule 20, AT 6)",
    "u5_away": "out-of-office time blocks habits and tasks and counts as vacation from 8 hours, else as a personal commitment; #tl_free in its title lets habits and tasks back (events-out-of-office rules 1, 6, 7; AT 3-5)",
    "u5_away_conflict": "a habit that keeps conflicts is skipped on time away and kept as a conflict on plain busy time (events-out-of-office rules 2, 12)",
    "u5_holiday": "a company holiday blocks the day once the user answers yes or maybe to its invitation; an unanswered one and a free holiday do not (events-out-of-office rules 9-10)",
    "u5_guests": "a meeting gets a new category and color when its guests change in the calendar (category detection rules 1, 3)",
    "u5_repaint": "a new category color repaints events that ended too; Repaint all events puts back colors changed in the calendar, at most twice a minute (color rules 8, 11, 12)",
    "u5_markers": "chosen markers after the title replace the defaults on new and changed events; the planner shows plain titles; back before the title rewrites them (settings; rules 1, 5, 7)",
    "u5_series": "a priority for one occurrence of a series changes only that one; for the whole series it changes every occurrence (rules 2, 3, 5)",
    "u5_fixed": "an event of another connected calendar, which a copy mirrors to the main calendar, shows a fixed P1 with the reason (rule 4)",
    "u5_copies": "copies of travel buffers on mirrored calendars show what each policy shows, while the main calendar keeps them with the travel marker (buffers-travel outputs)",
})
E2E.update({
    245: ["s1_kinds", "u5_copies"],
    253: ["u5_quick"],
    254: ["u5_tags"],
    255: ["u5_tags"],
    256: ["u5_tags"],
    257: ["u5_focus"],
    259: ["u5_tags"],
    262: ["u5_away"],
    263: ["u5_away"],
    278: ["u5_guests"],
    283: ["c_paint", "u5_repaint"],
    285: ["c_paint", "u5_repaint"],
    292: ["u5_markers"],
    297: ["u5_series"],
})
E2E_NOTES.update({
    245: "A travel buffer is the one managed event that mirroring copies, so its copy follows the policy",
    253: "Quick block: the event turns free within one run",
    259: "On CalDAV the RSVP note is the X-RESPONSE-COMMENT of the user's own attendee line; a COMMENT on the event is the organizer's text and is not read (edge case 5)",
    262: "Exactly 8 hours is vacation; stats show personal commitments on their own line",
    285: "Repaint all events is a button in the Colors section; it counts toward the same limit of 2 a minute",
    292: "Settings, Title markers: one field for each state marker and a position before or after the title",
})
PARTIAL[261] = (
    "Out-of-office events are read from the Google event type outOfOffice and, on CalDAV, from "
    "X-MICROSOFT-CDO-BUSYSTATUS:OOF, as Outlook-style clients write it. Full UI E2E passes on CalDAV (Radicale) "
    f"only: \u201c{T['u5_away']}\u201d; \u201c{T['u5_away_conflict']}\u201d. "
    "Limit: the Google event type has no E2E. Both tests skip on Google, because they write out-of-office events "
    "as raw CalDAV objects, and they came after the Google Calendar run (docs/e2e-google-run.md); "
    "the outOfOffice event type has unit tests (tests/unit/categories.test.ts, tests/unit/plan.test.ts)"
)
PARTIAL[265] = (
    f"Full UI E2E passes on CalDAV (Radicale): \u201c{T['u5_holiday']}\u201d. "
    "Limit: an invitation that lists only a mailing list, not the user, blocks before the user answers, "
    "because Tempoloom cannot see the user's own answer; holiday feeds are row 266. No Google E2E: the test skips on Google, "
    "because it writes the invitations as raw CalDAV objects, and it came after the Google Calendar run (docs/e2e-google-run.md)"
)
PARTIAL[284] = ("Painting skips an event that the calendar refuses (status 400 or 403) and goes on (src/server/planner/repaint.ts). "
                "No test proves it: a CalDAV server lets the owner change every event, no unit test sends a refused color write, and "
                "no Google E2E paints a mail-made or birthday event")
BLOCKED[317] = "The chat app channel needs a Slack app and a Slack test workspace; the daily digest by email, at a time the user sets, has full UI E2E on CalDAV (\u201clibrary entry 'Flag meeting problems' turns on the checks and an email digest of open, not ignored, issues at the chosen time, once a day\u201d)"
# --- end U05 ---

# --- U06: flexible meeting rules (tests/e2e/meeting-rules.spec.ts) ---
T.update({
    "mr_hours": "a colleague's hours count in the colleague's time zone, an optional user does not count, my hours only and item-specific hours replace everyone's hours (rules 11, 21, 35; edge case 1)",
    "mr_freq": "frequency: every day, every 3 days, every month on a day or an Nth weekday, every 2 months, and every 2 weeks from a start date (concepts frequency; rule 10)",
    "mr_prio": "priority: a P1 meeting moves a P3 habit, a P4 meeting goes before focus time, and adaptive defense turns busy when the day is tight or the occurrence is locked (rules 14-15, 23-25, 30)",
    "mr_rank": "rank and priority come from the automation list: a drag swaps two meetings that want one slot and another drag changes the priority; an hours change and an edit of the rules place them again (rules 23, 33; edge case 9; MEET-02 rules 4-5)",
    "mr_settings": "event settings, description and start date reach every occurrence, on the main calendar of another account (concepts visibility, reminders, targetCalendar, startDate; rules 9, 38)",
    "mr_defense": "adaptive defense writes busy within 12 hours and free later; always busy and always free keep their value (rules 30-31)",
    "mr_many": "no limit on meetings per organizer, and stats count flexible meetings as one-to-one or group time next to booked meetings (rule 36; analytics summary)",
    "mr_series": "a series every 3 weeks fills the form with its frequency read-only, refuses another frequency or a start date when added, keeps its instances when saved, and keeps its frequency read-only when edited, where other ideal days move its instances (rules 1, 10)",
})
E2E.update({
    324: ["mr_hours"], 328: ["mr_freq", "mr_series"], 331: ["mr_hours"], 332: ["mr_settings", "mr_rank"],
    333: ["mr_prio"], 334: ["mr_rank"], 336: ["mr_prio"], 339: ["mr_hours"],
    341: ["mr_prio", "mr_defense"], 342: ["mr_settings", "mr_defense"], 343: ["mr_settings"],
    346: ["mr_settings"], 349: ["mr_rank"], 350: ["mr_many"], 353: ["mr_many", "x_stats"],
    356: ["mr_rank", "mr_hours"],
})
E2E_NOTES.update({
    324: "The optional guest is a user here who is busy and outside the time zone of the meeting hours",
    328: "Custom is every N days, weeks or months (N 1 to 52), counted from the start date or the creation day; monthly is a day of the month or an Nth weekday; a month without its ideal day, or whose ideal day has passed, gets no new occurrence (unit test); a month whose ideal day is past the planning window waits for it; an adopted series repeats daily or every N weeks from its first instance",
    331: "Item-specific hours are a private hours set of the meeting, used alone",
    332: "A start date on a new meeting delays it; an edit that sets a later start date pauses it until then",
    339: "The colleague works in America/New_York; the organizer in Europe/Berlin",
    341: "Busy within 12 hours (DEF-30), when the occurrence has the last free slot of its day, or when it is locked",
    342: "Visibility and reminders use the shared event settings (CLASS, VALARM on CalDAV)",
    343: "The markdown is written as plain text to every occurrence (CNT-13); the planner details panel renders it (CNT-12)",
    346: "The calendar is the main calendar of any connected account, set at creation; that account is the organizer of each occurrence",
    349: "The rules list is the Automations page, grouped by priority; a drag changes rank or priority and places the meetings again",
    353: "Flexible meetings count as one-to-one or group time by their number of people",
    356: "An edit of the rules, a rank or priority change, and an hours change of the organizer or of an attendee who is a user here place future occurrences again, outside the move limit; an edit of the title, notes or location keeps the times, and an attendee's time zone change or new meeting hours set also places again (unit tests)",
})
BLOCKED[345] = "Needs Google Meet (a Google account), the Zoom vendor app and Google Workspace room resources; an address or a custom text or link is written as the location of every occurrence (E2E: \u201c" + T["mr_settings"] + "\u201d)"
# --- end U06 ---

# --- U30: exact blocked and partial reasons (audit of the blocked rows) ---
T.update({
    "u30_weekly_counts": "the weekly report counts work tasks and work habits as solo work and personal tasks, personal habits and a personal calendar's events as personal time; turned off and on, it goes out, also on an out-of-office Friday",
    "u30_weekly_change": "work hours changed during the week move that week's report to the new last workday (edge case 3)",
    "u30_weekly_who": "only users who signed in, are active and have a working calendar account get the weekly report: never signed in, deactivated or disconnected users get none (rule 5)",
    "u30_weekly_thu": "with work hours Monday to Thursday 10:00 to 18:00 the weekly report goes out on Thursday between 10:00 and 11:00, and not on Friday",
    "u30_weekly_clock": "the server sends the weekly report by its own clock in the first work hour of Friday",
    "u30_weekly_none": "without work hours the weekly report goes out on Friday between 09:00 and 10:00, and an empty week has zero totals",
})
E2E.update({
    631: ["u9_weekly", "u30_weekly_counts"],
    632: ["u9_weekly", "u30_weekly_thu", "u30_weekly_clock", "u30_weekly_none", "u30_weekly_counts", "u30_weekly_change",
          "u30_weekly_who"],
    633: ["u9_weekly", "u30_weekly_counts", "u30_weekly_none"],
    505: ["s1_habit_es", "mr_settings"],
})
E2E_NOTES.update({
    631: "On for a new user; the switch is in Settings, and off and on again survive a reload",
    632: ("Rules 3-5 and edge cases 1, 2, 3, 5: the last weekday with work hours, its first work hour, Friday 09:00 without work hours, "
          "the work hours in force at send time after a change during the week, the week counted up to the send time; only users who "
          "signed in, are not deactivated and have a connected calendar account get it (the never-signed-in user has a working account "
          "through the team's calendar access); "
          "the operator command weekly-reports --now runs one tick of the server's email worker, and one test lets the server's own "
          "clock (TEST_CLOCK_START) reach the send hour"),
    633: ("Meetings are events with other invitees; solo work is work tasks, work habits and events without invitees; personal time is "
          "tasks and habits on personal hours and events of a calendar that a mirroring policy labels personal (the test event's title "
          "has no personal keyword)"),
    505: "Habits and flexible meetings write to the calendar chosen at creation; the edit form shows it disabled",
})
PARTIAL.update({
    944: ("One MCP URL per instance (/mcp), shown on the Account page, with full UI E2E on CalDAV (\u201c" + T["s7_mcp_read"] + "\u201d). "
          "Any MCP client that can send a bearer token connects with a personal API key. Not built: OAuth 2.1 with PKCE and a consent page "
          "(Fields: Authorization), which clients that sign in only with OAuth need; it is buildable on the server"),
    945: ("Read tools answer at once and change nothing, and write tools stage the change in preview mode with a link to it, with full UI E2E on CalDAV "
          "(\u201c" + T["s7_mcp_read"] + "\u201d; \u201c" + T["s7_mcp_stage"] + "\u201d). Limits: apply_staged_changes called by the client has unit "
          "tests only (tests/unit/mcp.test.ts), and no test proves that write tools respect hours sets (rule 4)"),
    946: ("Built with full UI E2E on CalDAV: view schedule, find meeting times, analyze the week, create, move and delete events as staged changes, "
          "and review and apply them (\u201c" + T["s7_mcp_read"] + "\u201d; \u201c" + T["s7_mcp_stage"] + "\u201d). Not built: tools to respond "
          "to invitations, protect focus time and record work sessions; they are buildable"),
    947: ("A client is disconnected by deleting its personal API key: the key gets 401 at once (\u201c" + T["acct_keys"] + "\u201d). "
          "No test checks that deleting a key keeps the calendar connections and events (rules 6, 7). Not built: per-client OAuth grants with a Revoke action (rule 8), which come with MCP OAuth (row 944)"),
    953: ("Any client that sends the personal API key as a bearer token uses the same URL, with full UI E2E on CalDAV (\u201c" + T["s7_mcp_read"] + "\u201d). "
          "Not built: OAuth sign-in for clients that support only OAuth; it is buildable on the server (row 944)"),
})

# Chat rows: the assistant chat needs a language model, which the owner must supply.
G2 = "Needs an LLM provider and key from the owner (gate G2)"
CHAT_BUILT = "; preview mode and the MCP server, which the assistant chat would use, are built"
for n in [6, 47, 316, 369, 569, 582, 609, 612, 627, 661, 662, 672, 674, 675, 676, 677, 678, 679, 680, 681,
          682, 684, 685, 686, 687, 688, 689, 718]:
    BLOCKED[n] = G2 + CHAT_BUILT
for n in [723, 724, 730, 732, 733, 734, 735, 736, 738, 739, 740, 742, 749]:
    BLOCKED[n] = G2 + ": a prompt entry opens the assistant chat"
BLOCKED[568] = G2 + ": the switch turns off the assistant chat, so without the chat it has no effect to prove"
BLOCKED[683] = (G2 + " for the nightly review by chat, and a Slack app and a Slack test workspace for the chat-app channel; "
                "the morning email digest of meeting checks is built (row 317)")
BLOCKED[769] = G2 + " for the chat; the other parts of the baseline are built (preview mode, automations, issues, insights, MCP server)"
BLOCKED[130] = G2 + " for the chat panel; the automations panel and the suggested tasks in the planner are built"

# Rows that need a named outside account, vendor app or API.
SLACK = "Needs a Slack app and a Slack test workspace"
ZOOM = "Needs a Zoom developer app and a Zoom test account"
GONG = "Needs a Gong app and a Gong test organization"
TASK_APPS = "Needs a task-app integration: a developer app and a test account at Todoist, ClickUp, Asana, Jira or Linear"
GOOGLE_TASKS = "Needs a Google account and the Google Tasks API (an OAuth client with the Tasks scope)"
TODOIST = "Needs a Todoist developer app and a Todoist test account"
ASANA = "Needs an Asana developer app and an Asana test workspace"
CLICKUP = "Needs a ClickUp developer app and a ClickUp test workspace"
JIRA_ROVO = "Needs a Jira Cloud test site whose admin allowlists the Atlassian Rovo MCP server"
JIRA_APP = "Needs an Atlassian Marketplace app and a Jira Cloud test site"
LINEAR = "Needs a Linear OAuth app and a Linear test workspace"
RAYCAST = "Needs a Mac with Raycast to run the Raycast extension, a macOS client of the Tempoloom API"
WORKSPACE_ADDON = "Needs a Google Workspace Marketplace add-on (Calendar and Gmail) and a Google Workspace test account"
OUTSIDE = {
    SLACK: [236] + list(range(785, 822)),
    ZOOM: [822, 823, 825, 826, 827, 828, 829, 830],
    ZOOM + ", and a Slack app and a Slack test workspace": [824],
    GONG: [831, 832, 833, 834],
    TASK_APPS: [26, 67, 835] + list(range(837, 847)) + [859],
    GOOGLE_TASKS: [847, 848, 849, 850, 851, 852, 853, 854, 856, 857, 858],
    "Needs a Google account and the Gmail API (an OAuth client with a Gmail scope)": [855],
    TODOIST: list(range(860, 870)),
    ASANA: list(range(870, 878)),
    CLICKUP: list(range(878, 887)),
    JIRA_ROVO: [887, 888],
    JIRA_APP: list(range(889, 903)),
    LINEAR: list(range(903, 915)),
    RAYCAST: [448] + list(range(915, 927)),
    WORKSPACE_ADDON: list(range(954, 964)),
    ("Needs the developer app and a test account of at least one task or chat tool (Slack, Todoist, Asana, ClickUp, Jira, Linear or Zoom): "
     "the connect, consent and disconnect flow has no provider to run against"): list(range(777, 783)),
    "Needs a Zapier Developer Platform app and a Zapier account; personal API keys, which a Zapier app would use, are built (row 927)": [928, 929],
    "Needs a Zoom developer app and a Zoom test account, or Google Meet (a Google account and the Calendar conference API)": [436],
    "Needs a Microsoft 365 test account and a Microsoft Entra app registration for Microsoft Graph; the Graph calendar provider is not built": [
        520, 521, 526, 527, 528, 529, 530, 531, 532, 533, 534, 535, 536, 669, 670],
}
for reason, ns in OUTSIDE.items():
    for n in ns:
        BLOCKED[n] = reason
BLOCKED[19] = "Needs a Slack app and a Slack test workspace, or a Gmail add-on and a Google Workspace test account: the tasks come from chat or mail messages"
BLOCKED[66] = "Needs a Google Workspace Marketplace add-on for Google Calendar and a Google Workspace test account; priorities change in the planner and the task and habit forms"
BLOCKED[147] = BLOCKED[518] = (
    "Needs a Google account and the Google Tasks and Gmail APIs: only the Google Tasks and Gmail features (rows 847 to 858) ask for more Google access. "
    "Google sign-in asks for the calendar scopes up front (with include_granted_scopes); CalDAV has no permission scopes")
BLOCKED[446] = BLOCKED[447] = WORKSPACE_ADDON + "; the same actions exist on the Booking links page (rows 440 to 443)"
BLOCKED[948] = ("Needs a paid ChatGPT plan and a listing in the ChatGPT app directory, or a ChatGPT plan with custom connectors; it also needs MCP OAuth "
                "on the server, which is not built and is buildable (row 944)")
BLOCKED[949] = ("Needs a Claude account (Claude Desktop or the Claude web app) to add a custom connector; the connector signs in with MCP OAuth, "
                "which is not built on the server and is buildable (row 944). The MCP server with API keys is built (rows 697 to 699)")
BLOCKED[950] = ("Needs Claude Code and an Anthropic account; claude mcp add with an HTTP URL signs in with MCP OAuth, which is not built on the server "
                "and is buildable (row 944). The MCP server with API keys is built (rows 697 to 699)")
BLOCKED[951] = ("Needs a Claude account to show the per-tool settings, which are a Claude feature. Tempoloom's part is built: each tool has a name, a "
                "description, readOnlyHint and destructiveHint (unit tests in tests/unit/mcp.test.ts; E2E lists the tools: \u201c" + T["s7_mcp_read"] + "\u201d)")
BLOCKED[836] = (TASK_APPS + " for imported tasks. A saved search over Tempoloom tasks on a habit and on focus time has full UI E2E "
                "on CalDAV (\u201c" + T["s2_habit_tasks"] + "\u201d; \u201c" + T["s2_focus_tasks"] + "\u201d)")
BLOCKED[952] = ("Needs the Cursor app; its HTTP MCP entry signs in with MCP OAuth, which is not built on the server and is buildable (row 944). "
                "The MCP server with API keys is built (rows 697 to 699)")

# Rows that are not software, or have no evidence to build from.
BLOCKED[595] = "Not software: a guided pilot and rollout is a human service of the vendor company"
BLOCKED[655] = "Not software: a support tier, security reviews and company onboarding are human services of the vendor company"
BLOCKED[653] = BLOCKED[654] = "No spec and no evidence of inputs or formulas: a calculator widget on the marketing site"
BLOCKED[773] = "No evidence: the source service is closed and its export file format is not in the evidence"
BLOCKED[770] = "Not needed: no legacy users (platform-current-version rule 11)"

# Buildable rows that no unit has built yet. Rows that units U31 to U33 and PR #23 build now keep their text.
PLANNED = "Buildable; not built yet (planned)"
for n in [36, 38, 40, 102, 118, 121, 122, 123, 128, 129, 140, 144, 167, 169, 170, 183, 185, 187, 189,
          201, 205, 232, 326, 327, 340, 347, 361, 362, 365, 370, 375, 542, 543, 635, 636, 637, 775, 776, 783, 784]:
    BLOCKED[n] = PLANNED
BLOCKED[92] = PLANNED + ": the reason for each move and skip, and a view per item; the change log of every calendar write is built (src/server/change-log.ts)"
BLOCKED[507] = PLANNED + ": the link's events go to the calendar chosen on the link (\u201c" + T["u7_locations"] + "\u201d); the choice of an added account, whose primary calendar gets the events and sends the invitations, is not built"
BLOCKED[540] = PLANNED + ": the Repair action; looking up one event with its change log is built (src/server/diagnosis.ts)"
BLOCKED[322] = (PLANNED + ": the Google free/busy query for attendees who are not users here (the Google client has a freeBusy method that no code calls); "
                "its proof needs a Google account. The availability of attendees who are users here is E2E-proven (rows 321, 339)")
# --- end U30 ---

# --- U32: calendar edits and locks, part A (tests/e2e/chunk-edits.spec.ts, auto-lock.spec.ts) ---
T.update({
    "u32_autolock": "auto-lock per kind: from 01:00 a Sunday-start week locks habits, each day locks meetings by default and focus time, off locks nothing; later events wait until the setting is turned off and on (LCK-30 to LCK-33)",
    "u32_unlock": "a delete, a reschedule, a guest's decline and the user's own decline end a lock: the item is placed again away from the locked time (LCK-40, CED-27, CED-30)",
    "u32_first": "moving the first chunk later moves the task's start, so no chunk goes before it; moving it earlier sets an earlier start (CED-11)",
    "u32_drag": "a planner drag of the first chunk sets the task's start, so no chunk goes before it (CED-11, CED-50)",
    "u32_due": "a chunk moved past the due date makes every chunk of its task busy (CED-12, DEF-12)",
    "u32_resize": "a shorter chunk gives its minutes back to the task and a longer chunk takes them from the rest (CED-13, CED-14)",
    "u32_past": "past chunks: a delete brings the work back and reopens a done task; a shorter past chunk gives its minutes back (CED-13, CED-21, CED-22)",
})
E2E.update({
    99: ["mr_prio", "mr_defense"], 106: ["u32_autolock"], 107: ["u32_unlock"], 110: ["u32_first", "u32_drag"],
    111: ["u32_due"], 112: ["u32_resize", "u32_past"], 114: ["u32_past"],
})
E2E_NOTES.update({
    99: "The same rule as row 341: busy within 12 hours (DEF-30) or when the occurrence has the last free slot of its day",
    106: ("The lock run has the hour from 01:00 in the planning zone of the date (LCK-31, proposed default; a trip uses its zone); "
          "a week runs only on its first day, from the calendar week start (LCK-33; CalDAV has no such setting, so the E2E sets it through the settings API); "
          "only off to on locks at once (LCK-32); the first run of a kind without a record only records the period, and a missed hour is not run later"),
    107: "A deleted task chunk is placed again from the next day; a habit reschedule, a required guest's decline and the user's own decline move the locked occurrence",
})
# --- end U32 ---

# --- U35: next-up queue and priorities views (next-up-queue.spec.ts, priorities.spec.ts) ---
T.update({
    "u35_rank": "dragging a task inside the next-up queue changes its rank, and the scheduler places the queue in the new order (NXT-2, NXT-3, NXT-9)",
    "u35_arrows": "the up and down arrows and drag and drop add a task to the next-up queue and take it out (NXT-5, NXT-10, NXT-11)",
    "u35_panel": "the planner tasks panel adds a task to the next-up queue with its up arrow (NXT-6)",
    "u35_page": "the priorities page shows P1 to P4 columns; a drag or the level menu changes the level, with kind and hours filters and a column width (PRI-51, PRI-52, NXT-6)",
    "u35_view": "the planner priorities view groups items by level and kind, with a level menu, drag and drop, search and edit (PRI-53)",
    "u35_sticky": "an up arrow click moves only the task it adds to the next-up queue; other tasks keep their events (SCH-88, NXT-5)",
    "u35_lock": "a level change on the priorities page leaves a locked task chunk in place (NXT-4, PRI-13)",
    "u35_edit": "the task edit form edits every field and saves a total that is not a multiple of 15 minutes (PRI-50, PRI-53)",
})
E2E.update({
    42: ["u35_rank"],
    63: ["u35_page", "u35_lock"],
    64: ["u35_view", "u35_edit"],
})
E2E_NOTES.update({
    63: "The priorities page is its own page in the main navigation; it lists tasks, habits, flexible meetings, buffers, booking links and focus time (fixed at P4). The column width is kept in the browser",
    64: "The view opens from the Priorities button on the planner's now line",
})
BLOCKED[43] = ("Needs the Google Calendar add-on's developer app and a test account (rows 954 to 963) and the Slack app and a test "
               "workspace for the add action there (NXT-6); the built part has E2E on CalDAV: the up and down arrows and drag and drop "
               "into and out of the dashed queue area on the tasks page, the up arrow in the planner tasks panel and on the priorities "
               "page, done leaving the queue, and an up arrow that moves no other task (\u201c" + T["u35_arrows"] + "\u201d; \u201c"
               + T["u35_panel"] + "\u201d; \u201c" + T["u35_page"] + "\u201d; \u201c" + T["u35_sticky"] + "\u201d)")
# --- end U35 ---

# Google Calendar proof. docs/e2e-google-run.tsv records a full E2E run on Google
# (a "# commit <sha>" line, then status, test id, title per line; docs/e2e-google-run.md
# says how it ran and how to regenerate the file). Each T[key] is the exact title of one
# test in tests/e2e, and the build stops when it is not, so a renamed test cannot drop a
# Google claim in silence. The test of a key is the line whose title equals T[key]; the
# build stops when a key matches more than one line. A key is proven on Google when its
# test passed and its test() call is the same now as at the run commit (CHANGED_AFTER
# otherwise). A key with no line was added after the run; a key whose test did not pass
# was skipped or did not pass there.
GOOGLE_RUN = os.path.join(ROOT, "docs/e2e-google-run.tsv")
E2E_DIR = os.path.join(ROOT, "tests/e2e")
TEST_CALL = re.compile(r'\btest\(\s*("(?:[^"\\\n]|\\.)*")')

def e2e_titles():
    """The title of each test("...") call in tests/e2e/*.ts."""
    titles = set()
    for f in glob.glob(f"{E2E_DIR}/*.ts"):
        src = open(f, encoding="utf8").read()
        for m in TEST_CALL.finditer(src):
            titles.add(json.loads(m.group(1)))
    return titles

def check_titles():
    titles = e2e_titles()
    bad = [k for k, text in T.items() if text not in titles]
    for k in bad:
        print(f"test key {k}: no test in tests/e2e has the title \u201c{T[k]}\u201d", file=sys.stderr)
    if bad:
        sys.exit(f"{len(bad)} test keys in T are not test titles; make each T text equal its test title")

def google_run():
    """(commit of the run, {key: [(status, test id)]})."""
    run, commit = {}, None
    for line in open(GOOGLE_RUN, encoding="utf8"):
        if line.startswith("# commit "):
            commit = line.split()[2]
        elif line.strip():
            st, test_id, title = line.rstrip("\n").split("\t")
            run.setdefault(title, []).append((st, test_id))
    if not commit or not re.fullmatch(r"[0-9a-f]{40}", commit):
        sys.exit("docs/e2e-google-run.tsv has no \"# commit <sha>\" line with the full commit of the run")
    status = {key: run.get(text, []) for key, text in T.items()}
    for key, hits in status.items():
        if len(hits) > 1:
            sys.exit(f"test key {key} matches {len(hits)} tests in docs/e2e-google-run.tsv")
    return commit, status

GOOGLE_RUN_COMMIT, GOOGLE_RUN_STATUS = google_run()

# The source of a test() call: from "test(" to its closing parenthesis.
OPEN, CLOSE = "([{", ")]}"
REGEX_AFTER = set("(,=:[!&|?{};+-*%<>~^")

def call_end(src, i):
    """Index after the parenthesis that closes the one at src[i]. Skips strings,
    template literals, comments and regular expression literals."""
    stack, n = [], len(src)
    while i < n:
        c = src[i]
        if c == "}" and stack and stack[-1] == "${":
            stack.pop()
            i = template_end(src, i + 1, stack)
            continue
        if c in OPEN:
            stack.append(c)
        elif c in CLOSE:
            if not stack or OPEN[CLOSE.index(c)] != stack[-1]:
                raise ValueError(f"unbalanced {c!r} at offset {i}")
            stack.pop()
            if not stack:
                return i + 1
        elif c in "'\"":
            i += 1
            while src[i] != c:
                i += 2 if src[i] == "\\" else 1
        elif c == "`":
            i = template_end(src, i + 1, stack)
            continue
        elif src.startswith("//", i):
            i = src.index("\n", i)
            continue
        elif src.startswith("/*", i):
            i = src.index("*/", i) + 2
            continue
        elif c == "/":
            before = src[:i].rstrip()
            if not before or before[-1] in REGEX_AFTER or re.search(r"\b(return|typeof|in|of)$", before):
                i += 1
                in_class = False
                while in_class or src[i] != "/":
                    if src[i] == "\\":
                        i += 1
                    elif src[i] == "[":
                        in_class = True
                    elif src[i] == "]":
                        in_class = False
                    i += 1
        i += 1
    raise ValueError("no closing parenthesis")

def template_end(src, i, stack):
    """Scan a template literal from src[i] (after ` or a closing }); stop after its
    closing ` or at a ${, which goes on the stack."""
    while True:
        c = src[i]
        if c == "\\":
            i += 2
        elif c == "`":
            return i + 1
        elif src.startswith("${", i):
            stack.append("${")
            return i + 2
        else:
            i += 1

def test_calls(src):
    """{title: [(line, normalized source of the test() call)]} of one file. The
    normalized source drops leading and trailing blanks of each line and empty lines,
    so moving a test or changing its indent does not count as a change."""
    calls = {}
    for m in TEST_CALL.finditer(src):
        start = m.start()
        end = call_end(src, src.index("(", start))
        body = "\n".join(l.strip() for l in src[start:end].splitlines() if l.strip())
        line = src.count("\n", 0, start) + 1
        calls.setdefault(json.loads(m.group(1)), []).append((line, body))
    return calls

def git(*args):
    r = subprocess.run(["git", "-C", ROOT, *args], capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"git {' '.join(args)} failed: {r.stderr.strip()}. The Google proof check needs the "
                 f"run commit {GOOGLE_RUN_COMMIT} in the clone (CI: actions/checkout with fetch-depth: 0)")
    return r.stdout

def changed_after_run():
    """Keys whose test passed in the Google run but whose test() call is not the same
    now (in the working tree) as at the run commit."""
    head = {}
    for f in glob.glob(f"{E2E_DIR}/*.ts"):
        for title, calls in test_calls(open(f, encoding="utf8").read()).items():
            head.setdefault(title, []).extend(calls)
    then, changed = {}, set()
    for key, hits in GOOGLE_RUN_STATUS.items():
        if not hits or hits[0][0] != "passed":
            continue
        path, line = hits[0][1].rsplit(":", 1)
        if path not in then:
            then[path] = test_calls(git("show", f"{GOOGLE_RUN_COMMIT}:{path}"))
        old = then[path].get(T[key], [])
        if [l for l, _ in old] != [int(line)]:
            sys.exit(f"test key {key}: {hits[0][1]} is not the test \u201c{T[key]}\u201d at commit {GOOGLE_RUN_COMMIT}")
        now = head.get(T[key], [])
        if len(now) != 1:
            sys.exit(f"test key {key}: {len(now)} tests in tests/e2e have the title \u201c{T[key]}\u201d")
        if now[0][1] != old[0][1]:
            changed.add(key)
    return changed

GOOGLE_CHANGED = changed_after_run()

# Why a test did not pass in the Google run: (singular, plural) phrases.
ADDED_AFTER, SKIPPED, NOT_PASSED, CHANGED_AFTER = "added after", "skipped", "not passed", "changed after"
GOOGLE_MISSING_TEXT = {
    ADDED_AFTER: ("was added after", "were added after"),
    SKIPPED: ("was skipped in", "were skipped in"),
    NOT_PASSED: ("failed in", "failed in"),
    CHANGED_AFTER: ("changed after", "changed after"),
}

def google_missing(key):
    """Why the test of a key is not proven on Google (ADDED_AFTER, SKIPPED,
    NOT_PASSED or CHANGED_AFTER), or None when it passed there and its test() call
    did not change since. A failed, timed-out or interrupted test is NOT_PASSED."""
    hits = GOOGLE_RUN_STATUS[key]
    if not hits:
        return ADDED_AFTER
    if hits[0][0] == "passed":
        return CHANGED_AFTER if key in GOOGLE_CHANGED else None
    return SKIPPED if hits[0][0] == "skipped" else NOT_PASSED

def e2e_status(row_id, keys):
    tests = "; ".join(f"\u201c{T[k]}\u201d" for k in keys)
    note = f" {E2E_NOTES[row_id]}." if row_id in E2E_NOTES else ""
    missing = {k: why for k in keys if (why := google_missing(k))}
    if not missing:
        return "done (Google)", f"Full UI E2E passes on CalDAV (Radicale) and on Google Calendar (docs/e2e-google-run.md): {tests}.{note}"
    reasons = set(missing.values())
    if len(missing) == len(keys) and len(reasons) == 1:
        subject = "the test" if len(keys) == 1 else "all these tests"
        why = f"{subject} {GOOGLE_MISSING_TEXT[reasons.pop()][len(keys) > 1]} the Google run"
    else:
        why = "; ".join(f"\u201c{T[k]}\u201d {GOOGLE_MISSING_TEXT[r][0]} the Google run" for k, r in missing.items())
    return "done (CalDAV)", (f"Full UI E2E passes on CalDAV (Radicale): {tests}.{note} "
                             f"Not proven on Google Calendar (docs/e2e-google-run.md): {why}.")

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
    check_titles()
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
    counts = {"done (Google)": 0, "done (CalDAV)": 0, "partial": 0, "blocked": 0}
    for r in rows:
        counts[r[5]] += 1
    header = open(f"{STAGING}/parity-header.md", encoding="utf8").read().rstrip()
    out = [header, "", "## Summary", "",
           f"- Rows: {len(rows)}",
           f"- done (CalDAV): {counts['done (CalDAV)']}",
           f"- done (Google): {counts['done (Google)']}",
           f"- partial: {counts['partial']}",
           f"- blocked: {counts['blocked']}", "",
           "\"done (CalDAV)\" means a full UI E2E test passes against a real CalDAV server (Radicale in a",
           "loopback container): Playwright drives the Tempoloom UI, the real API and scheduler write to the",
           "calendar, and the test checks the calendar, a page reload and persistence. The suite runs in CI",
           "on every push. \"done (Google)\" rows passed the same tests against Google Calendar too, in the",
           "run recorded in docs/e2e-google-run.md; rows whose tests skip on Google stay \"done (CalDAV)\".",
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
