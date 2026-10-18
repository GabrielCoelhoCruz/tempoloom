# Parity rows: B-habits-focus-buffers

| Feature | Evidence | Spec | Notes |
|---|---|---|---|
| Create a habit (blank form, template, create button, assistant chat) | E-0081, E-0082, E-0043 | habits-automation.md#creation-and-editing | |
| Habit template library | E-0082, E-0004, E-0081 | habits-automation.md#creation-and-editing | presets in automations-library.md |
| Habit title with emoji | E-0082, E-0085 | habits-automation.md#concepts-and-inputs | |
| Habit priority P1 to P4 | E-0142, E-0082, E-0141 | habits-automation.md#concepts-and-inputs | |
| Habit rank inside a priority group | E-0043, E-0141 | habits-automation.md#scheduler-interaction | current version |
| Habit category (work or personal) and color | E-0082 | habits-automation.md#concepts-and-inputs | |
| Habit hours: hours set or one-off window | E-0082, E-0081, E-0172 | habits-automation.md#placement | |
| Habit duration range (ideal and shortest length) | E-0082, E-0081 | habits-automation.md#placement | |
| Habit frequency: daily, weekly, monthly, custom | E-0082, E-0004 | habits-automation.md#frequency | legacy evidence for detail |
| Habit ideal days | E-0004, E-0081 | habits-automation.md#placement | |
| Habit ideal time | E-0082, E-0081 | habits-automation.md#placement | |
| Habit start date | E-0082 | habits-automation.md#concepts-and-inputs | |
| Unplaceable habit: keep as conflict with warning marker, or remove | E-0082, E-0081 | habits-automation.md#placement | default not observed |
| Habit move to another day of the week | E-0081, E-0130 | habits-automation.md#placement | |
| Habit notes copied to event description (markdown) | E-0082 | habits-automation.md#outputs | |
| Habit visibility (details or busy only) | E-0082, E-0081, E-0004 | habits-automation.md#concepts-and-inputs | |
| Habit defense modes (always free, adaptive, always busy) | E-0196, E-0081, E-0142 | habits-automation.md#defense-free-or-busy | |
| Habit switches from free to busy as the calendar fills | E-0081, E-0196, E-0181, E-0089 | habits-automation.md#defense-free-or-busy | formula in planning-defense.md |
| Habit target calendar (set at creation only) | E-0082, E-0004 | habits-automation.md#concepts-and-inputs | |
| Habit guests (no availability check, no notices) | E-0082 | habits-automation.md#concepts-and-inputs | legacy evidence |
| Habit avoid-duplicates keywords | E-0082 | habits-automation.md#placement | legacy evidence |
| Habit auto-decline of interruptions | E-0082 | habits-automation.md#auto-decline | legacy evidence |
| Habit dependencies (before, not after, not same day) | E-0082 | habits-automation.md#placement | legacy evidence |
| Habit reminders | E-0043, E-0004 | habits-automation.md#concepts-and-inputs | |
| Habit location | E-0004 | habits-automation.md#concepts-and-inputs | marketing only |
| Habit task filter | E-0081 | habits-automation.md#task-filter | |
| Turn a solo recurring event into a habit | E-0081 | habits-automation.md#creation-and-editing | |
| Preview of habit impact before apply | E-0081, E-0043 | habits-automation.md#creation-and-editing | preview mode spec owns UI |
| Habit auto-rescheduling around conflicts | E-0081, E-0082, E-0004 | habits-automation.md#scheduler-interaction | |
| Habits never take time from external or booking-link events | E-0142, E-0141 | habits-automation.md#scheduler-interaction | |
| Lock and unlock a habit occurrence | E-0181, E-0081, E-0130 | habits-automation.md#actions-on-one-occurrence | |
| Moving a habit occurrence locks it | E-0081, E-0130, E-0181 | habits-automation.md#actions-on-one-occurrence | |
| Skip a habit occurrence | E-0081, E-0130, E-0181 | habits-automation.md#actions-on-one-occurrence | |
| Deleting a habit event in the calendar re-places it | E-0081, E-0130 | habits-automation.md#actions-on-one-occurrence | |
| Reschedule a habit occurrence to a chosen time | E-0130, E-0181 | habits-automation.md#actions-on-one-occurrence | |
| Snooze a habit occurrence | E-0181, E-0130 | habits-automation.md#actions-on-one-occurrence | legacy evidence |
| Log past work on a habit | E-0082, E-0130 | habits-automation.md#actions-on-one-occurrence | legacy evidence |
| Start habits when placed or manually | E-0048 | habits-automation.md#actions-on-one-occurrence | legacy evidence |
| Disable and enable a habit | E-0072, E-0043 | habits-automation.md#lifecycle | |
| Snooze a habit until a date | E-0072 | habits-automation.md#lifecycle | legacy evidence |
| Delete a habit (past events kept, no restore) | E-0072 | habits-automation.md#lifecycle | |
| Search habits | E-0082 | habits-automation.md#creation-and-editing | legacy evidence |
| Edit a habit from any habit event | E-0082 | habits-automation.md#creation-and-editing | |
| Done marker on past habit occurrences | E-0085 | habits-automation.md#outputs | |
| Team habit templates | E-0004, E-0170 | teams-settings-templates.md | owned by group E |
| Habit analytics and progress | E-0004 | analytics-personal-stats.md | owned by group E |
| Focus goal automation: weekly goal | E-0077, E-0078, E-0015 | focus-time.md#focus-goal-automation-proactive-mode | |
| Focus daily minimum and maximum | E-0077, E-0078 | focus-time.md#focus-goal-automation-proactive-mode | |
| Focus block minimum and maximum length | E-0077, E-0078, E-0015 | focus-time.md#concepts-and-inputs | maximum is legacy evidence |
| Focus scheduling hours | E-0077, E-0070 | focus-time.md#concepts-and-inputs | |
| Focus proactive and reactive modes | E-0078, E-0071, E-0095, E-0015 | focus-time.md#focus-goal-automation-reactive-mode-legacy-evidence | current help maps reactive to meeting overload |
| Focus event title, description, visibility, target calendar | E-0078 | focus-time.md#concepts-and-inputs | |
| Focus auto-decline with message | E-0077, E-0078, E-0070, E-0015 | focus-time.md#behavior-of-placed-focus-events-both-automations | |
| Hide focus time from booking links | E-0078 | focus-time.md#scheduler-interaction | legacy evidence |
| Focus moves when an accepted event overlaps | E-0077, E-0078, E-0071 | focus-time.md#behavior-of-placed-focus-events-both-automations | |
| Moving a focus event locks it | E-0077, E-0078 | focus-time.md#behavior-of-placed-focus-events-both-automations | |
| Deleting a focus event skips that range | E-0077, E-0078 | focus-time.md#behavior-of-placed-focus-events-both-automations | |
| Reschedule focus with a minimum delay | E-0071 | focus-time.md#behavior-of-placed-focus-events-both-automations | legacy evidence |
| Focus placed after all other items, pinned P4, P2 once placed | E-0077, E-0141, E-0090, E-0078 | focus-time.md#scheduler-interaction | |
| Work tasks and work habits count toward focus goal | E-0078, E-0083, E-0095 | focus-time.md#counted-time | |
| Native Google focus-time events count toward goal | E-0078 | focus-time.md#counted-time | Workspace only |
| Focus tag counts any event toward goal | E-0078, E-0203 | focus-time.md#counted-time | tag name proposed |
| Focus goal progress and "goal not reached" notice | E-0077, E-0015 | focus-time.md#outputs | |
| Shared task list on focus events | E-0077 | focus-time.md#behavior-of-placed-focus-events-both-automations | |
| Meeting overload automation: daily and weekly meeting caps | E-0070, E-0095, E-0043 | focus-time.md#behavior | |
| Meeting overload: minimum block, hours, auto-decline | E-0070 | focus-time.md#concepts-and-inputs | |
| Rename focus events to tell automations apart | E-0070 | focus-time.md#concepts-and-inputs | |
| Team focus time template | E-0170 | focus-time.md#team-focus-template-and-company-focus-policy | legacy; model in teams-settings-templates.md |
| Company focus policy by department, team or role | E-0017, E-0015 | focus-time.md#team-focus-template-and-company-focus-policy | enterprise; model in teams-policies.md |
| Focus goal benchmarks and role recommendations | E-0015, E-0017 | teams-policies.md | marketing only; owned by group E |
| Focus analytics and enterprise reports | E-0015, E-0017 | analytics-organization.md | owned by group E |
| Buffer automations, many per user | E-0051, E-0043 | buffers-automation.md#creating-and-editing | |
| Buffer side (before, after, both) and lengths | E-0051, E-0009 | buffers-automation.md#concepts-and-inputs | |
| Buffer event filter (text, attendees, count, category, length, title, tag) | E-0051 | buffers-automation.md#event-filter | |
| Buffer filter from plain-language description | E-0051 | buffers-automation.md#creating-and-editing | |
| Live list of matching events in filter editor | E-0051 | buffers-automation.md#creating-and-editing | |
| Buffer calendar scope (one or all) | E-0051 | buffers-automation.md#concepts-and-inputs | |
| Buffer priority | E-0051, E-0141 | buffers-automation.md#conflicts | |
| Buffer conflict setting (remove or keep as conflict) | E-0051 | buffers-automation.md#conflicts | |
| Buffer reminders on or off | E-0051 | buffers-automation.md#concepts-and-inputs | |
| Buffer busy or free and visibility | E-0043, E-0052, E-0049 | buffers-automation.md#concepts-and-inputs | |
| Buffer templates: recovery, prep, travel, airport | E-0051, E-0009 | buffers-automation.md#templates | |
| Recovery buffer after meetings (all or video only) | E-0052, E-0049, E-0069 | buffers-automation.md#templates | |
| No buffer between back-to-back meetings | E-0052, E-0069 | buffers-automation.md#placement | |
| Recovery buffer yields to a habit at its last slot | E-0069 | buffers-automation.md#conflicts | legacy evidence |
| Buffer follows its meeting when it moves | E-0052 | buffers-automation.md#placement | |
| Company buffer policy | E-0019 | buffers-automation.md#company-buffer-policy-marketing-evidence | enterprise; model in teams-policies.md |
| Buffer and travel time analytics | E-0009, E-0019 | analytics-personal-stats.md | owned by group E |
| Chat status during breaks | E-0009 | integrations-slack.md | owned by group F |
| Travel buffers for events with a physical address | E-0052, E-0049, E-0009 | buffers-travel.md#which-events-get-travel-time | |
| Default travel length setting | E-0052, E-0049 | buffers-travel.md#concepts-and-inputs | |
| Address detection needs two commas | E-0052 | buffers-travel.md#which-events-get-travel-time | legacy evidence |
| No map lookup for travel time | E-0052 | buffers-travel.md#which-events-get-travel-time | |
| Flight detection and airport time (2 h before, 1 h after) | E-0052, E-0207, E-0203, E-0009 | buffers-travel.md#flights | |
| Set event category to flight by hand | E-0052 | buffers-travel.md#flights | |
| Travel buffers follow the event and keep manual length | E-0052 | buffers-travel.md#placement-and-updates | |
| Travel buffer skipped when time is blocked | E-0052 | buffers-travel.md#placement-and-updates | |
| Travel buffer visibility (public, or mirroring policy) | E-0052 | buffers-travel.md#outputs | |
| Travel tags ignored on privacy-hidden mirrored copies | E-0207 | buffers-travel.md#placement-and-updates | |
| Break buffer between task and habit events | E-0052, E-0009 | buffers-breaks.md#behavior | legacy evidence |
| `#tl_free`: busy for others, free for tasks and habits | E-0203, E-0201 | events-tags.md#tl_free-and-no-meeting-days | |
| No-meeting day (all-day or block) | E-0201, E-0004, E-0015 | events-tags.md#tl_free-and-no-meeting-days | |
| Weekly no-meeting day | E-0201 | events-tags.md#tl_free-and-no-meeting-days | |
| Team no-meeting day | E-0201 | events-tags.md#tl_free-and-no-meeting-days | |
| `#tl_busy`: free for others, busy for tasks and habits | E-0161, E-0203 | events-tags.md#tl_busy | |
| Quick block event titled only `#tl_busy` | E-0161 | events-tags.md#tl_busy | |
| `#tl_travel` forces travel buffers | E-0203, E-0207, E-0052, E-0049 | events-tags.md#travel-flight-and-trip-tags | |
| Flight tag | E-0203, E-0207 | events-tags.md#travel-flight-and-trip-tags | tag name proposed |
| Trip tag (travel category, no buffer) | E-0203, E-0207 | events-tags.md#travel-flight-and-trip-tags | tag name proposed |
| Focus tag | E-0203, E-0078 | events-tags.md#tl_focus | tag name proposed |
| `#tl_nosync` tag | E-0203 | events-tags.md#tag-list | rules in sync-calendar-mirroring.md |
| Tags read from title, description and RSVP note | E-0203, E-0207 | events-tags.md#where-tempoloom-looks | |
| All-day busy event blocks managed items | E-0111, E-0023 | events-out-of-office.md#behavior | |
| Google out-of-office events recognized | E-0111 | events-out-of-office.md#behavior | |
| Out-of-office time classed as vacation or personal commitment (8 h) | E-0111 | events-out-of-office.md#concepts-and-inputs | |
| Out-of-office with `#tl_free` keeps tasks and habits | E-0111 | events-out-of-office.md#behavior | |
| Free all-day events ignored | E-0111 | events-out-of-office.md#behavior | |
| Company holiday calendar (busy events, accepted) | E-0111 | events-out-of-office.md#company-holidays | |
| Custom holiday feed instead of built-in holidays | E-0111 | events-out-of-office.md#company-holidays | |
| Managed items move around time off | E-0023, E-0015, E-0004 | events-out-of-office.md#behavior | |
| Chat status and auto-reply during out-of-office | E-0111, E-0023 | events-out-of-office.md#behavior | details in integrations-slack.md |
| Team out-of-office calendar | E-0023 | teams-ooo-calendar.md | owned by group E |
| Home time zone (from browser, editable) | E-0107, E-0013 | timezones-home-and-travel.md#behavior | |
| Travel time zones with dates, several allowed | E-0107 | timezones-home-and-travel.md#behavior | |
| Booking links follow the travel time zone | E-0107 | timezones-home-and-travel.md#behavior | |
| Prompt on browser time zone change and on return home | E-0107, E-0222 | timezones-home-and-travel.md#behavior | |
| Two time columns in planner | E-0107 | timezones-home-and-travel.md#behavior | |
| Automatic event categories (team, one-on-one, external, solo, personal, travel) | E-0087 | events-categories-and-colors.md#categories | |
| Deep and shallow solo work split | E-0087 | events-categories-and-colors.md#categories | |
| Change an event's category by hand | E-0087 | events-categories-and-colors.md#category-detection | |
| Category re-detected when attendees change | E-0047 | events-categories-and-colors.md#category-detection | |
| Automatic color coding by category | E-0047 | events-categories-and-colors.md#color-rules | |
| Color scope: managed events only or all events | E-0047 | events-categories-and-colors.md#color-rules | |
| 12 color choices (11 event colors plus calendar color) | E-0047 | events-categories-and-colors.md#color-settings | |
| Item color overrides (habit, task, mirroring policy) | E-0047 | events-categories-and-colors.md#color-rules | |
| Repaint past and future events on change | E-0047 | events-categories-and-colors.md#color-rules | |
| Skip events Google does not allow to recolor | E-0047 | events-categories-and-colors.md#color-rules | |
| Color reset and scope-change limit | E-0135 | events-categories-and-colors.md#color-rules | legacy evidence |
| Free, busy and lock title markers | E-0085, E-0089 | events-title-emoji.md#marker-table | |
| Done and partly done title markers | E-0085 | events-title-emoji.md#marker-table | |
| Conflict title marker | E-0082 | events-title-emoji.md#marker-table | |
| Personal, flight and travel markers | E-0085 | events-title-emoji.md#marker-table | |
| User emoji kept after the marker | E-0085, E-0043 | events-title-emoji.md#behavior | |
| Remove a template's emoji | E-0085 | events-title-emoji.md#behavior | |
| Custom marker choice and position | E-0085 | events-title-emoji.md#settings | plan-gated in reference |
| Chat status emoji from event emoji | E-0085 | events-title-emoji.md#behavior | details in integrations-slack.md |
| Set priority of an external event | E-0104, E-0141 | events-external-priority.md#behavior | |
| External events default to P1 and are never overbooked | E-0104, E-0141 | events-external-priority.md#scheduler-interaction | |
| Lowered external event offered only by higher booking links | E-0104, E-0141 | events-external-priority.md#behavior | |
| Priority change for one event or whole series | E-0104 | events-external-priority.md#behavior | legacy evidence |
| Mirrored and connected-calendar events fixed at P1 | E-0104 | events-external-priority.md#behavior | legacy evidence |
| Automation types (habit, focus, meeting overload, buffer, flexible meeting, meeting check) | E-0043 | automations-overview.md#automation-types | |
| Shared automation form (name, event settings, rules) | E-0043 | automations-overview.md#shared-fields | |
| Create automation from library, create button or assistant chat | E-0043, E-0081, E-0077, E-0070, E-0051 | automations-overview.md#creating | |
| "Added" badge on used templates | E-0043 | automations-overview.md#creating | |
| Preview automation impact before apply | E-0043, E-0081, E-0077, E-0070, E-0051 | automations-overview.md#creating | |
| Automation list grouped by priority | E-0043, E-0141 | automations-overview.md#the-list | |
| Drag to rank or change priority | E-0043, E-0141 | automations-overview.md#the-list | |
| Filter automation list by type | E-0043 | automations-overview.md#the-list | |
| Disable or remove an automation | E-0043 | automations-overview.md#the-list | |
| Focus automations pinned to P4 | E-0077, E-0070, E-0141 | automations-overview.md#the-list | |
| Meeting check: overlapping commitments | E-0134 | automations-meeting-quality.md#built-in-checks | |
| Meeting check: attendee declined or not free | E-0134 | automations-meeting-quality.md#built-in-checks | |
| Meeting check: unanswered invitation | E-0134 | automations-meeting-quality.md#built-in-checks | |
| Meeting check: missing video link | E-0134 | automations-meeting-quality.md#built-in-checks | |
| Meeting checks on by default, disable each | E-0134 | automations-meeting-quality.md#behavior | |
| Ignore an issue for one event or the series | E-0134 | automations-meeting-quality.md#behavior | |
| Issues tab in planner | E-0134 | automations-meeting-quality.md#behavior | |
| Issues in assistant chat | E-0134 | automations-meeting-quality.md#behavior | |
| Daily digest by email, chat app or both | E-0134 | automations-meeting-quality.md#behavior | |
| Company meeting checks (admin-only, organizer gets flag) | E-0134 | automations-meeting-quality.md#company-checks | team admins |
