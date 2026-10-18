# Parity rows: E-team-analytics-ai

Group topics: teams, team settings, team out-of-office calendar, team
policies, personal stats, team stats, organization analytics, weekly
reports, single sign-on and provisioning, plans, assistant chat, preview
mode, MCP server, pomodoro timer, meeting cost calculator, automation
library, executive assistant use, current version baseline.

| Feature | Evidence | Spec | Notes |
|---|---|---|---|
| Team created for each new user, creator is admin | E-0093, E-0101 | teams-membership.md#behavior | admin role inferred |
| Prompt to create a team with same-domain colleagues | E-0093, E-0101 | teams-membership.md#behavior | |
| Invite members by email (several at once, optional message, optional admin) | E-0093 | teams-membership.md#behavior | |
| Copy invite link from the member table | E-0093 | teams-membership.md#behavior | |
| Revoke a pending invitation | E-0093 | teams-membership.md#behavior | |
| Accept invitation: existing user joins at once, new user onboards first | E-0093, E-0101 | teams-membership.md#behavior | |
| Request to join a discoverable team; admin approves or rejects | E-0093, E-0101 | teams-membership.md#behavior | team needs 2+ members |
| Join a team automatically when the join mode allows | E-0101, E-0102 | teams-membership.md#behavior | |
| Join mode setting: invite only, request, automatic | E-0102 | teams-membership.md#concepts-and-inputs | default request |
| Leave a team; sole admin blocked; data kept | E-0101 | teams-membership.md#behavior | |
| Remove a team member, seat freed | E-0127 | teams-membership.md#behavior | |
| Give or remove admin role | E-0127, E-0102 | teams-membership.md#behavior | |
| Seat usage bar above member table | E-0093 | teams-membership.md#behavior | optional instance limit |
| Seat overage: scheduling continues, adding members blocked | E-0093 | teams-membership.md#behavior | buying seats is non-goal |
| Maximum team size per tier | E-0093, E-0003 | teams-membership.md#concepts-and-inputs | instance setting in Tempoloom |
| Free tier cannot invite members | E-0093 | teams-membership.md#behavior | plan-gated in reference; no gate proposed |
| Team settings restricted to admins | E-0102 | teams-settings-templates.md#behavior | |
| Invite permission: admins only or all members | E-0102 | teams-settings-templates.md#concepts-and-inputs | default unknown |
| Team habit templates in onboarding and on habits page | E-0102 | teams-settings-templates.md#behavior | legacy only |
| Default work and meeting hours for new members | E-0102, E-0182 | teams-settings-templates.md#behavior | legacy only |
| Team focus time template as recommendation | E-0170, E-0102, E-0003 | teams-settings-templates.md#behavior | legacy only; large-team tier in reference |
| Team defaults apply only to members who join later | E-0102, E-0170 | teams-settings-templates.md#behavior | |
| Team-wide assistant chat switch with disabled notice | E-0158 | teams-settings-templates.md#behavior | current version |
| Prompt to enable assistant chat after sign-up | E-0158 | teams-settings-templates.md#behavior | |
| Team booking link branding page | E-0102 | teams-settings-templates.md#concepts-and-inputs | owned by booking link specs |
| Team webhooks page | E-0102 | teams-settings-templates.md#concepts-and-inputs | owned by integrations-webhooks.md |
| Team billing page, change plan, buy seats | E-0102, E-0093, E-0003 | none | non-goal |
| Team out-of-office calendar configuration (name, owner, shared calendar) | E-0171, E-0003 | teams-ooo-calendar.md#behavior | large-team tier in reference |
| Out-of-office participants from write access and group members | E-0171 | teams-ooo-calendar.md#behavior | |
| Copy full-day time away to the shared calendar | E-0171, E-0023, E-0014 | teams-ooo-calendar.md#behavior | |
| Partial-day time away shown with exact times or as all-day | E-0171, E-0023 | teams-ooo-calendar.md#behavior | admin setting |
| Count all-day busy events as time away | E-0171 | teams-ooo-calendar.md#behavior | admin setting |
| Allow non-admins to create out-of-office calendars | E-0171 | teams-ooo-calendar.md#behavior | default on |
| One person in several out-of-office calendars | E-0171 | teams-ooo-calendar.md#behavior | |
| Managed events move off time away | E-0023, E-0014 | teams-ooo-calendar.md#behavior | owned by events-out-of-office.md |
| Chat-app status and auto-reply during time off | E-0023 | teams-ooo-calendar.md#open-questions | marketing only |
| Assistant chat answer on who is away | E-0023 | teams-ooo-calendar.md#open-questions | marketing only |
| Automatic enrollment of new teammates in out-of-office calendars | E-0023 | teams-ooo-calendar.md#open-questions | marketing only |
| Time-away tracking in stats | E-0023 | analytics-personal-stats.md#concepts-and-inputs | vacation bucket |
| Team policy model scoped by directory attributes | E-0017, E-0018, E-0019, E-0020, E-0021 | teams-policies.md#behavior | marketing only; mostly proposed |
| Company focus time policy | E-0017, E-0014, E-0003 | teams-policies.md#behavior | enterprise tier; marketing only |
| Company buffer policy | E-0019, E-0014 | teams-policies.md#behavior | marketing only |
| Meeting agenda policy: remind, adjust, auto-decline | E-0018, E-0014 | teams-policies.md#behavior | marketing only |
| Agenda templates per meeting type | E-0018 | teams-policies.md#behavior | marketing only |
| Calendar fragmentation policy and baseline report | E-0020, E-0014 | teams-policies.md#behavior | marketing only |
| Chat-app status policy with do-not-disturb | E-0021, E-0014 | teams-policies.md#behavior | status mechanics in integrations-slack.md |
| Tasks and booking links created from the chat app | E-0021 | teams-policies.md#behavior | owned by integrations-slack.md |
| Policy progress reports | E-0017, E-0018, E-0019, E-0020, E-0021 | teams-policies.md#behavior | |
| Benchmark targets per role | E-0017, E-0018, E-0019, E-0020, E-0021 | teams-policies.md#open-questions | not specced; data unknown |
| Guided pilot and rollout services | E-0014, E-0017, E-0020 | none | non-goal (service) |
| Stats page with personal and team tabs | E-0180, E-0076 | analytics-personal-stats.md#concepts-and-inputs | legacy panels |
| Stats grouping by day, week or auto | E-0180, E-0194 | analytics-personal-stats.md#concepts-and-inputs | |
| Stats range: quick picks, custom, up to 12 weeks back | E-0180, E-0194 | analytics-personal-stats.md#behavior | |
| Stats for future dates (capacity planning) | E-0180, E-0011 | analytics-personal-stats.md#behavior | |
| Time breakdown panel by category | E-0180, E-0011 | analytics-personal-stats.md#behavior | |
| Time breakdown trend panel | E-0180 | analytics-personal-stats.md#behavior | |
| Work habits and tasks panel | E-0180 | analytics-personal-stats.md#behavior | |
| Deep versus shallow work, most productive weekday | E-0180, E-0011 | analytics-personal-stats.md#behavior | 2-hour threshold |
| Work-life balance panel | E-0180, E-0011 | analytics-personal-stats.md#behavior | |
| People met panel | E-0180 | analytics-personal-stats.md#behavior | personal view only |
| Meeting breakdown panel with heaviest and lightest weekday | E-0180, E-0011 | analytics-personal-stats.md#behavior | |
| Highlights panel (focus held, booking link meetings, breaks, travel) | E-0180, E-0194 | analytics-personal-stats.md#behavior | |
| Current-version insights patterns | E-0183, E-0148 | analytics-personal-stats.md#behavior | thin evidence |
| Ask assistant chat about own stats | E-0011, E-0022 | analytics-personal-stats.md#behavior | |
| Planned versus actual time | E-0011 | analytics-personal-stats.md#behavior | marketing only; proposed definition |
| Log time on tasks and habits | E-0074, E-0003, E-0011 | analytics-personal-stats.md#behavior | owned by planning-task-progress.md |
| AI advice to get more focus | E-0011 | analytics-personal-stats.md#open-questions | marketing only |
| Team stats as averages, no individual values | E-0194, E-0180, E-0074 | analytics-team-stats.md#behavior | small-team tier in reference |
| Time in meetings distribution panel | E-0194, E-0180 | analytics-team-stats.md#behavior | thresholds proposed |
| Team stats for future dates | E-0194 | analytics-team-stats.md#behavior | |
| Team insights grouped by department and manager line | E-0183 | analytics-team-stats.md#behavior | see organization analytics |
| Organization reports at company, department, team and person level | E-0012, E-0014 | analytics-organization.md#behavior | enterprise tier in reference |
| Analytics filters from directory attributes, including custom ones | E-0169, E-0012, E-0020 | analytics-organization.md#concepts-and-inputs | |
| Deep work score with benchmarks | E-0012 | analytics-organization.md#behavior | formula proposed |
| Focus time reports and average focus session length | E-0012, E-0017 | analytics-organization.md#behavior | |
| Calendar fragmentation tracking | E-0012, E-0020 | analytics-organization.md#behavior | |
| Meeting time, meeting type split, average daily meeting load | E-0012 | analytics-organization.md#behavior | |
| Custom past and future ranges with week-over-week trends | E-0012 | analytics-organization.md#behavior | |
| Organization analytics exports | E-0012, E-0014, E-0003 | analytics-organization.md#behavior | CSV proposed |
| Free, travel and break time tracking | E-0012 | analytics-organization.md#behavior | |
| Meeting cost across the workforce | E-0012 | analytics-organization.md#behavior | |
| Assistant chat answers on workforce analytics | E-0012 | analytics-organization.md#behavior | |
| Analytics include provisioned users who never signed in; 24-hour refresh | E-0169 | analytics-organization.md#behavior | needs calendar grant |
| Analytics-only seats | E-0003 | analytics-organization.md#open-questions | add-on in reference |
| Policy analysis and industry benchmark reports | E-0012 | analytics-organization.md#behavior | announced, not shipped |
| Weekly report email on by default, opt-out in settings | E-0215, E-0003 | analytics-weekly-reports.md#behavior | legacy only |
| Weekly report sent in first hour of the last workday | E-0215 | analytics-weekly-reports.md#behavior | legacy only |
| Weekly report totals: personal, solo work, meetings | E-0215, E-0011 | analytics-weekly-reports.md#behavior | legacy only |
| Weekly report changing calendar facts | E-0215 | analytics-weekly-reports.md#behavior | fact set proposed |
| Weekly report next week preview | E-0215 | analytics-weekly-reports.md#behavior | legacy only |
| Weekly report priorities section | E-0215 | analytics-weekly-reports.md#behavior | legacy only |
| Share top half of weekly report (link, X, LinkedIn, Facebook) | E-0215 | analytics-weekly-reports.md#behavior | legacy only |
| Sign in with Google or Microsoft | E-0179 | admin-sso-provisioning.md#behavior | |
| SSO through an external identity provider (OIDC) | E-0179, E-0169, E-0014 | admin-sso-provisioning.md#behavior | enterprise tier; SAML unclear |
| SSO-only mode or SSO plus Google sign-in | E-0178 | admin-sso-provisioning.md#behavior | |
| SSO enabled for one team in an organization | E-0178 | admin-sso-provisioning.md#behavior | |
| Directory provisioning (SCIM) with attribute mapping | E-0169, E-0014, E-0182 | admin-sso-provisioning.md#behavior | |
| Domain capture into the enterprise team | E-0169, E-0003 | admin-sso-provisioning.md#behavior | enterprise tier |
| Google service account with domain-wide delegation | E-0204, E-0169 | admin-sso-provisioning.md#concepts-and-inputs | |
| Microsoft tenant-wide admin consent | E-0169 | admin-sso-provisioning.md#behavior | permissions unknown |
| Provisioned users use no seat until first sign-in | E-0169 | admin-sso-provisioning.md#behavior | |
| Paced provisioning of large imports | E-0169 | admin-sso-provisioning.md#behavior | |
| Admin API for provisioning users and calendars | E-0204 | admin-sso-provisioning.md#behavior | API not observed |
| Plan tiers and prices | E-0003 | none | non-goal |
| Discounts (student, nonprofit, startup, switching provider) and annual billing | E-0003 | none | non-goal |
| Payment methods | E-0003 | none | non-goal |
| Free trial | E-0074 | none | non-goal |
| ROI calculator on the pricing page | E-0003 | none | non-goal (marketing widget) |
| Time-loss calculator on the enterprise page | E-0014 | none | non-goal (marketing widget) |
| Support tier, security reviews, company onboarding | E-0003, E-0014, E-0182 | none | non-goal (service) |
| Scheduling window limit per tier (booking links exempt) | E-0003, E-0182 | plans-feature-inventory.md#behavior | instance setting |
| Connected calendar count limit | E-0003 | plans-feature-inventory.md#concepts-and-inputs | instance setting |
| Calendar mirroring count limit | E-0003 | plans-feature-inventory.md#concepts-and-inputs | plan card and table disagree |
| Booking link count limit | E-0003 | plans-feature-inventory.md#behavior | instance setting |
| Automation count limit per seat | E-0003 | plans-feature-inventory.md#concepts-and-inputs | instance setting |
| Assistant chat usage level per tier | E-0003 | plans-feature-inventory.md#concepts-and-inputs | numbers unknown |
| Chat memories limit on free tier | E-0003 | plans-feature-inventory.md#concepts-and-inputs | |
| Read-only AI tool access on free tier | E-0003 | plans-feature-inventory.md#behavior | instance setting |
| Meeting notes placed into buffers | E-0003 | plans-feature-inventory.md#concepts-and-inputs | pricing page only |
| AI-drafted follow-up email or chat message after meetings | E-0003 | plans-feature-inventory.md#concepts-and-inputs | pricing page only |
| Meeting transcript sync | E-0003 | plans-feature-inventory.md#concepts-and-inputs | pricing page only |
| Room or resource decline alert | E-0003 | plans-feature-inventory.md#concepts-and-inputs | pricing page only |
| Task suggestions from meetings | E-0003 | plans-feature-inventory.md#concepts-and-inputs | pricing page only |
| MCP for Microsoft Copilot | E-0003 | plans-feature-inventory.md#concepts-and-inputs | pricing page only |
| Microsoft Teams support | E-0003 | plans-feature-inventory.md#concepts-and-inputs | pricing page only |
| Add Google Meet automatically | E-0003 | plans-feature-inventory.md#concepts-and-inputs | pricing page only |
| Daily digest of conflicts and agenda | E-0003, E-0158 | assistant-chat.md#behavior | |
| Scheduling that uses the org chart | E-0003 | plans-feature-inventory.md#open-questions | enterprise tier; no detail |
| Assistant chat panel in the planner | E-0158, E-0183, E-0022 | assistant-chat.md#behavior | current version |
| Create, move, resize, delete events by chat | E-0158, E-0022, E-0183 | assistant-chat.md#behavior | |
| Answer invitations by chat | E-0022 | assistant-chat.md#behavior | |
| Find time with colleagues by chat | E-0158, E-0022 | assistant-chat.md#behavior | |
| Fix conflicts and rearrange days by chat | E-0158, E-0022, E-0183 | assistant-chat.md#behavior | |
| Create and change automations by chat | E-0158, E-0043, E-0022 | assistant-chat.md#behavior | |
| Suggest tasks for today and events to automate | E-0158, E-0183 | assistant-chat.md#behavior | |
| Answer questions about Tempoloom from user docs | E-0158 | assistant-chat.md#behavior | |
| Approval before any change | E-0158, E-0022 | assistant-chat.md#behavior | |
| Nightly review and morning digest by email or chat app | E-0158 | assistant-chat.md#behavior | one digest with meeting checks |
| Recommendations action; review the week in view | E-0158 | assistant-chat.md#behavior | |
| Chat memories: create, list, delete; suggestion only | E-0158, E-0003 | assistant-chat.md#behavior | |
| Role-based memories need directory data | E-0158 | assistant-chat.md#behavior | |
| Meeting agendas and prep plans by chat | E-0022 | assistant-chat.md#behavior | marketing only |
| Team scheduling policies created by chat | E-0022 | teams-policies.md#open-questions | marketing only |
| Chat usage limit message | E-0003 | assistant-chat.md#behavior | quota proposed |
| Stage proposed changes in preview mode | E-0158, E-0133, E-0183 | assistant-preview-mode.md#behavior | |
| Accept or discard each staged change | E-0158 | assistant-preview-mode.md#behavior | |
| Final review list before apply | E-0158 | assistant-preview-mode.md#behavior | |
| Attendees notified only at apply | E-0158, E-0148 | assistant-preview-mode.md#behavior | |
| Leave changes pending; turn preview mode off | E-0158 | assistant-preview-mode.md#behavior | persistence proposed |
| Turn preview mode on by hand | E-0148, E-0183 | assistant-preview-mode.md#behavior | |
| Preview of a new or edited automation's impact | E-0043 | assistant-preview-mode.md#behavior | |
| MCP server for any compatible AI tool | E-0133, E-0183, E-0022 | assistant-mcp-server.md#behavior | |
| Read schedule, find time, week summary, meeting prep through MCP | E-0133, E-0022 | assistant-mcp-server.md#behavior | tool set proposed |
| Staged writes through MCP | E-0133 | assistant-mcp-server.md#behavior | |
| Setup guides for ChatGPT, Claude, Cursor | E-0133 | assistant-mcp-server.md#summary | owned by integrations-ai-tools.md |
| Pomodoro timer with work, short break and long break phases | E-0016, E-0115 | tools-pomodoro-timer.md#behavior | public tool, not in planner |
| Long break after four sessions | E-0016, E-0115 | tools-pomodoro-timer.md#behavior | |
| Remaining time in the browser tab title | E-0016 | tools-pomodoro-timer.md#behavior | |
| Reset and phase tabs | E-0115, E-0016 | tools-pomodoro-timer.md#behavior | |
| Timer task list | E-0016, E-0115 | tools-pomodoro-timer.md#behavior | |
| Custom phase lengths | E-0115, E-0016 | tools-pomodoro-timer.md#concepts-and-inputs | |
| Auto-start next phase | E-0115, E-0016 | tools-pomodoro-timer.md#behavior | default unclear |
| Alarm sound choice and sound toggle | E-0115, E-0016 | tools-pomodoro-timer.md#concepts-and-inputs | |
| Background audio | E-0115, E-0016 | tools-pomodoro-timer.md#behavior | |
| Mini window | E-0115, E-0016 | tools-pomodoro-timer.md#behavior | |
| Counters for today, week, month and streak | E-0016 | tools-pomodoro-timer.md#behavior | |
| Timer stats view | E-0115, E-0016 | tools-pomodoro-timer.md#behavior | |
| Timer link in managed event descriptions | E-0115, E-0016 | tools-pomodoro-timer.md#behavior | |
| Meeting cost calculator inputs | E-0024 | tools-meeting-cost-calculator.md#concepts-and-inputs | |
| Cost per meeting and annual cost | E-0024 | tools-meeting-cost-calculator.md#behavior | 48 vs 52 weeks conflict |
| Calculator reset | E-0024 | tools-meeting-cost-calculator.md#behavior | |
| Automation library with group tabs and "Added" badge | E-0043, E-0001 | automations-library.md#behavior | |
| Library prompt entries open assistant chat | E-0001 | automations-library.md#behavior | split of entries inferred |
| Library entry 1: Recovery after large meetings (buffer) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 2: Prep before executive meetings (buffer) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 3: Prep before interviews (buffer) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 4: Agenda drafts for my meetings (meeting_check) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 5: Back-plan work from due dates (chat_prompt) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 6: What to do now (chat_prompt) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 7: Executive weekly focus (focus_time) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 8: Recovery day after heavy meeting days (meeting_overload) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 9: Flag meeting problems (meeting_check) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 10: Airport travel time (buffer) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 11: End-of-day wrap-up (habit) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 12: Customer onboarding meeting plan (chat_prompt) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 13: Prep before customer meetings (buffer) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 14: Work rhythm review (chat_prompt) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 15: Cross-team meeting time (chat_prompt) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 16: Burnout risk review (chat_prompt) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 17: Team meeting health review (chat_prompt) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 18: Urgent review meeting (chat_prompt) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 19: Break after long meetings (buffer) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 20: Adaptive workday (chat_prompt) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 21: Conflict fixes (chat_prompt) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 22: Plan my day (chat_prompt) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 23: Peak-energy focus (focus_time) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 24: Task re-ranking (chat_prompt) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 25: Deep work protection (focus_time) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 26: Meeting load cap (meeting_overload) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 27: Breaks after meeting runs (buffer) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 28: Travel for external meetings (buffer) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 29: Focus before customer meetings (buffer) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 30: Sales call prep and debrief (buffer) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 31: Prep task suggestions (chat_prompt) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 32: Recurring client meetings (flexible_meeting) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 33: Weekly no-meeting day (no_meeting_day) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 34: One-on-ones (flexible_meeting) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 35: Weekly writing time (habit) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 36: Weekly reading time (habit) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 37: Priority booking link (booking_link) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 38: Mirror calendars after a merger or role change (calendar_mirroring) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 39: Mirror calendars across several jobs (calendar_mirroring) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 40: Daily walk (habit) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 41: Exercise (habit) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 42: Coding time (habit) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 43: Weekly planning (habit) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 44: Email catch-up (habit) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 45: Meditation (habit) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Library entry 46: Lunch (habit) | E-0001 | automations-library.md#concepts-and-inputs | title-only evidence; preset proposed |
| Delegated access for assistants | E-0074, E-0099, E-0003 | teams-executive-assistant-use.md#behavior | owned by accounts-delegated-access.md |
| Team booking pages directory | E-0074 | teams-executive-assistant-use.md#behavior | legacy only |
| Three default booking links for a new user | E-0074 | teams-executive-assistant-use.md#behavior | legacy only; owned by booking-links.md |
| Habit templates common for executives | E-0074 | teams-executive-assistant-use.md#behavior | legacy only; owned by habits-automation.md |
| Current version baseline (planner, chat, preview, automations, issues, insights, MCP) | E-0183, E-0148, E-0043 | platform-current-version.md#behavior | |
| Upgrade banner and self-serve upgrade from legacy | E-0183 | platform-current-version.md#behavior | not needed: no legacy users |
| Tasks suggested in focus time instead of own events | E-0183 | platform-current-version.md#behavior | owned by planning-tasks.md |
| Recommendations and issues list | E-0183, E-0148 | platform-current-version.md#behavior | detection in automations-meeting-quality.md |
| Import from a closed competitor's export file | E-0182, E-0075 | platform-current-version.md#behavior | non-goal: source closed, format unknown |
| Advice to turn off other scheduling tools first | E-0182, E-0075 | platform-current-version.md#behavior | proposed onboarding hint |
