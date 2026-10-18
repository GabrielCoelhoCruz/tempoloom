# Feature parity: F-integrations

| Feature | Evidence | Spec | Notes |
|---|---|---|---|
| Integrations page with one card per tool | E-0002 | integrations-overview.md#behavior | |
| "Suggest a tool" request link | E-0002 | integrations-overview.md#behavior | |
| Connect an integration through the provider consent flow | E-0153, E-0154, E-0143, E-0146, E-0151, E-0156 | integrations-overview.md#behavior | |
| Choose a workspace or site during connect | E-0143, E-0146, E-0151, E-0153 | integrations-overview.md#behavior | |
| Admin approval needed by the provider workspace | E-0153, E-0143, E-0146, E-0151, E-0156 | integrations-overview.md#behavior | |
| Second consent for AI tool access | E-0146 | integrations-overview.md#behavior | current only |
| Disconnect an integration; existing events stay | E-0153, E-0154, E-0143, E-0146, E-0149, E-0151, E-0156, E-0152 | integrations-overview.md#behavior | |
| Detect access revoked on the provider side | E-0080, E-0149 | integrations-overview.md#behavior | legacy check interval 5 to 10 min |
| Google Calendar card | E-0029, E-0002 | integrations-overview.md#behavior | sync behavior owned by group D |
| Outlook Calendar card | E-0033, E-0002 | integrations-overview.md#behavior | sync behavior owned by group D |
| Install the Slack app and link the account | E-0153, E-0175, E-0035 | integrations-slack.md#install-and-link | plan-gated in reference |
| Link several Slack workspaces | E-0175 | integrations-slack.md#install-and-link | legacy only |
| Slack app home agenda with join and open actions | E-0175 | integrations-slack.md#app-home | legacy only |
| Slack app home task list with actions and new task | E-0175 | integrations-slack.md#app-home | legacy only |
| Slack app home booking links | E-0175, E-0021 | integrations-slack.md#app-home | |
| Slack app home settings view | E-0175 | integrations-slack.md#app-home | legacy only |
| Agenda slash command | E-0175 | integrations-slack.md#slash-commands | legacy only |
| Settings slash command | E-0175, E-0225 | integrations-slack.md#slash-commands | legacy only |
| Create a task with a slash command and options | E-0175, E-0021 | integrations-slack.md#slash-commands | |
| Share a booking link with a slash command | E-0175 | integrations-slack.md#slash-commands | legacy only |
| Create a task from a Slack message | E-0175, E-0021 | integrations-slack.md#create-a-task-from-a-message | |
| Slack messages for new, changed and cancelled meetings | E-0175, E-0035 | integrations-slack.md#notifications-and-digests | |
| Slack message before an event starts | E-0175 | integrations-slack.md#notifications-and-digests | lead time unknown |
| Slack conflict messages, with scheduler-movable events excluded | E-0175 | integrations-slack.md#notifications-and-digests | legacy only |
| Daily digest in Slack | E-0175 | integrations-slack.md#notifications-and-digests | legacy only |
| Weekly digest in Slack | E-0175 | integrations-slack.md#notifications-and-digests | legacy only |
| Action buttons on Slack messages (RSVP, open, resolve) | E-0175 | integrations-slack.md#notifications-and-digests | legacy only |
| Notification settings in Slack and in the web app | E-0175, E-0153 | integrations-slack.md#notifications-and-digests | |
| Duplicate-notification hint for other calendar apps | E-0175 | integrations-slack.md#notifications-and-digests | |
| Slack status sync on and off | E-0050, E-0153, E-0035 | integrations-slack.md#status-sync | |
| Status by event category | E-0050, E-0021 | integrations-slack.md#status-sync | legacy detail |
| "Busy" status for all events | E-0050 | integrations-slack.md#status-sync | legacy only |
| Custom status text and emoji per category, with title placeholder | E-0050, E-0021 | integrations-slack.md#status-sync | legacy detail |
| Do Not Disturb per event category | E-0050 | integrations-slack.md#status-sync | extra Slack permission |
| Outside-hours status and Do Not Disturb | E-0050 | integrations-slack.md#status-sync | legacy only |
| Only busy events set a status | E-0050 | integrations-slack.md#status-sync | legacy only |
| Overlap rule: most recently updated event wins | E-0050 | integrations-slack.md#status-sync | legacy only |
| Status cleared when the event is removed or moved | E-0050, E-0021 | integrations-slack.md#status-sync | |
| Manual status clear is respected | E-0050 | integrations-slack.md#status-sync | legacy only |
| Choose which calendars feed Slack | E-0175 | integrations-slack.md#status-sync | legacy only |
| Automatic Do Not Disturb during focus time | E-0035, E-0021 | integrations-slack.md#status-sync | current |
| Status reset by turning sync off and on | E-0225 | integrations-slack.md#troubleshooting-surface | legacy only |
| Hint when another app overrides the status | E-0225 | integrations-slack.md#troubleshooting-surface | detection rule proposed |
| Assistant chat inside Slack | E-0035 | integrations-slack.md#assistant-chat-in-slack-current-version | current; group E owns chat |
| Organization-wide Slack status policy by role or team | E-0021 | integrations-slack.md#organization-status-policy | enterprise; group E owns policies |
| Disconnect Slack in the web app | E-0153 | integrations-slack.md#disconnect-and-uninstall | |
| Revoke own Slack authorization or remove the app from a workspace | E-0112, E-0153 | integrations-slack.md#disconnect-and-uninstall | |
| Connect Zoom | E-0156, E-0038, E-0227 | integrations-video-conferencing.md#zoom-connect-and-disconnect | plan-gated in reference |
| Disconnect or uninstall Zoom | E-0156, E-0227 | integrations-video-conferencing.md#zoom-connect-and-disconnect | |
| Slack status follows Zoom join and leave, also for ad hoc calls | E-0189, E-0227, E-0156, E-0038 | integrations-video-conferencing.md#zoom-call-presence | needs Slack |
| Do Not Disturb for important Zoom calls | E-0156, E-0038 | integrations-video-conferencing.md#zoom-call-presence | "important" undefined |
| Join Zoom meetings from the Planner | E-0156, E-0038 | integrations-video-conferencing.md#zoom-links-and-planner | |
| Zoom links on booking links and flexible meetings | E-0227, E-0156 | integrations-video-conferencing.md#zoom-links-and-planner | |
| Keep hand-added Zoom details on a flexible meeting series | E-0168 | integrations-video-conferencing.md#zoom-links-and-planner | legacy only |
| Zoom transcripts after meetings | E-0156, E-0038 | integrations-video-conferencing.md#zoom-transcripts-and-buffers | depends on Zoom settings |
| Recovery buffer after Zoom meetings | E-0156, E-0038 | integrations-video-conferencing.md#zoom-transcripts-and-buffers | |
| Connect Gong once per organization (team admin) | E-0157 | integrations-video-conferencing.md#gong | |
| Gong user matching by email and auto provisioning | E-0157 | integrations-video-conferencing.md#gong | |
| Gong link on booked meetings (reusable or unique) | E-0157 | integrations-video-conferencing.md#gong | |
| Disconnect Gong | E-0157 | integrations-video-conferencing.md#gong | |
| Imported tasks in the task list with source, project and label filters | E-0192, E-0149, E-0154, E-0143 | integrations-task-sync.md#current-task-list | current |
| Saved task search attached to focus time or a habit | E-0192, E-0149, E-0154, E-0143, E-0146, E-0151 | integrations-task-sync.md#current-task-list | current |
| Import scope rules (assigned, in scope, required fields, open state) | E-0197, E-0057, E-0118, E-0122 | integrations-task-sync.md#import-scope | |
| Sync rules with order, containers, labels, action, hours set | E-0197, E-0187, E-0057, E-0185 | integrations-task-sync.md#sync-rules-todoist-clickup-legacy-evidence | legacy only |
| Fallback rule when no sync rule matches | E-0187, E-0185 | integrations-task-sync.md#sync-rules-todoist-clickup-legacy-evidence | legacy only |
| Default work and personal labels created on connect | E-0197, E-0187, E-0057, E-0185 | integrations-task-sync.md#sync-rules-todoist-clickup-legacy-evidence | legacy only |
| Include tasks without due dates, per rule | E-0197, E-0096, E-0057 | integrations-task-sync.md#sync-rules-todoist-clickup-legacy-evidence | legacy only |
| Title options block (duration, due, not before, priority, type, next up, no split) | E-0067, E-0096, E-0175 | integrations-task-sync.md#title-options-grammar | legacy only |
| Chunk event title with project prefix and source link | E-0197, E-0057, E-0044 | integrations-task-sync.md#field-mapping | legacy only |
| Priority mapping from each task app; Tempoloom changes not written back | E-0197, E-0057, E-0044, E-0118, E-0122 | integrations-task-sync.md#field-mapping | legacy detail |
| Write-back comment with next chunk, progress and at-risk marker | E-0197, E-0057 | integrations-task-sync.md#write-back | legacy only |
| Assigning an item to a teammate blocks the teammate's time | E-0025, E-0036, E-0031, E-0032 | integrations-task-sync.md#teammates | marketing only |
| Connect Google Tasks | E-0149, E-0030 | integrations-google-tasks.md#connect | Google Calendar only |
| Dedicated synced Google Tasks list | E-0080 | integrations-google-tasks.md#connect | legacy only |
| Several Google accounts for Google Tasks | E-0080 | integrations-google-tasks.md#connect | legacy only |
| Two-way create, edit, complete, reopen and delete | E-0080 | integrations-google-tasks.md#import-and-two-way-sync | legacy only |
| Google Tasks without due date: default or none | E-0067, E-0080 | integrations-google-tasks.md#import-and-two-way-sync | legacy only |
| Options block parsed and removed from the Google task title | E-0067 | integrations-google-tasks.md#import-and-two-way-sync | legacy only |
| Google Tasks details become task notes and event description | E-0067 | integrations-google-tasks.md#import-and-two-way-sync | legacy only |
| Priority change written back to Google Tasks | E-0067 | integrations-google-tasks.md#import-and-two-way-sync | legacy; mechanism unknown |
| Gmail message to task | E-0067, E-0030 | integrations-google-tasks.md#import-and-two-way-sync | |
| Default task duration estimate for Google Tasks | E-0030, E-0067 | integrations-google-tasks.md#import-and-two-way-sync | |
| Repeating Google Tasks import as new tasks | E-0080 | integrations-google-tasks.md#repeating-to-dos | legacy only |
| Disconnect Google Tasks (revoke grant or delete list) | E-0149, E-0080 | integrations-google-tasks.md#disconnect | |
| Faster sync on paid plans | E-0080 | integrations-task-sync.md#sync-timing | legacy; plan-gated in reference |
| Connect Todoist | E-0154, E-0036, E-0197 | integrations-todoist.md#connect | plan-gated in reference |
| Warning about duplicates with Todoist's own calendar connection | E-0197 | integrations-todoist.md#connect | legacy only |
| Todoist import requirements (due date, assignee, not recurring) | E-0197, E-0096 | integrations-todoist.md#import | legacy only |
| Todoist rules map tasks to work, personal or custom hours | E-0187, E-0197 | integrations-todoist.md#import | legacy only |
| Duration from Todoist duration field, brackets or 1-hour default | E-0096, E-0036 | integrations-todoist.md#import | |
| Todoist due date and deadline mapping | E-0096 | integrations-todoist.md#import | legacy only |
| Todoist priority mapping | E-0197, E-0096, E-0036 | integrations-todoist.md#import | |
| Todoist chunk event title and comment | E-0197 | integrations-todoist.md#display-and-write-back | legacy only |
| Todoist completion and reopen | E-0197 | integrations-todoist.md#completion | legacy only |
| Disconnect Todoist | E-0154, E-0197 | integrations-todoist.md#disconnect | |
| Connect an Asana workspace | E-0143, E-0025 | integrations-asana.md#connect-current-version | plan-gated in reference |
| Import assigned Asana tasks with estimate, due date and priority | E-0025, E-0143 | integrations-asana.md#connect-current-version | marketing detail |
| Add the app to Asana projects (web browser only) | E-0044 | integrations-asana.md#legacy-flow-legacy-evidence | legacy only |
| Schedule button and sync form inside Asana | E-0044, E-0184 | integrations-asana.md#legacy-flow-legacy-evidence | legacy only |
| Other project members sync the same Asana task | E-0044, E-0184 | integrations-asana.md#legacy-flow-legacy-evidence | legacy only |
| Asana priority mapping, with "Custom" prompt | E-0044 | integrations-asana.md#priority | mapping unclear |
| Asana chunk event title with project prefix | E-0044 | integrations-asana.md#display | legacy only |
| Disconnect Asana, admin deauthorize, remove widget | E-0143, E-0044 | integrations-asana.md#disconnect | |
| Connect one or more ClickUp workspaces | E-0146, E-0028, E-0057 | integrations-clickup.md#connect | plan-gated in reference |
| Check required ClickApps | E-0057 | integrations-clickup.md#connect | legacy only |
| ClickUp import requirements (one assignee, due date, estimate, active status) | E-0057 | integrations-clickup.md#import | legacy only |
| Track ClickUp time from the calendar | E-0028 | integrations-clickup.md#import | marketing only |
| ClickUp fields two-way except title and priority | E-0057 | integrations-clickup.md#updates | legacy only |
| ClickUp priority mapping | E-0057, E-0028 | integrations-clickup.md#updates | |
| ClickUp comment with schedule and progress | E-0057 | integrations-clickup.md#updates | legacy only |
| ClickUp status groups complete and reopen tasks | E-0057 | integrations-clickup.md#completion | legacy only |
| Disconnect ClickUp | E-0146, E-0057 | integrations-clickup.md#disconnect | |
| Connect Jira through the Rovo MCP server, after admin allowlist | E-0150 | integrations-jira.md#connect-current-version | current; Starter plan or higher in reference |
| Jira data available to AI tools | E-0150 | integrations-jira.md#connect-current-version | current |
| Marketplace install by a Jira admin and per-user enable | E-0118 | integrations-jira.md#legacy-install-legacy-evidence | legacy only |
| Required Jira issue screen fields | E-0118 | integrations-jira.md#legacy-install-legacy-evidence | legacy only |
| Jira import requirements and missing-field notice | E-0118 | integrations-jira.md#import | legacy only |
| Manual or automatic Jira sync | E-0118, E-0119 | integrations-jira.md#import | legacy only |
| Sync Jira issues without due dates | E-0118, E-0119 | integrations-jira.md#import | legacy only |
| Due date from the earliest of due date, fix version and sprint end | E-0118, E-0031 | integrations-jira.md#import | |
| Start date from issue, then sprint, then default delay | E-0118 | integrations-jira.md#import | legacy only |
| Any Jira estimate type sets block size | E-0031 | integrations-jira.md#concepts-and-inputs | marketing only |
| Jira priority mapping | E-0118, E-0031 | integrations-jira.md#concepts-and-inputs | Lowest unmapped |
| Tempoloom panel in the Jira issue | E-0118, E-0119 | integrations-jira.md#issue-panel | legacy only |
| Work logged in Jira as chunks run | E-0118 | integrations-jira.md#work-logging-and-completion-legacy-evidence | legacy only |
| Jira Done completes the task; Tempoloom done does not close Jira | E-0118 | integrations-jira.md#work-logging-and-completion-legacy-evidence | legacy only |
| Deleted Jira issue deletes the task | E-0118 | integrations-jira.md#work-logging-and-completion-legacy-evidence | legacy only |
| Several Jira sites with separate settings | E-0118, E-0119 | integrations-jira.md#several-sites | legacy only |
| Connect a Linear workspace | E-0151, E-0032, E-0122 | integrations-linear.md#connect | plan-gated in reference |
| Linear team selection and label-only sync mode | E-0123, E-0122 | integrations-linear.md#concepts-and-inputs | legacy only |
| Linear import requirements (estimate, priority, not backlog) | E-0122, E-0116 | integrations-linear.md#import | legacy only |
| Linear estimate to duration table | E-0121, E-0032 | integrations-linear.md#concepts-and-inputs | legacy table |
| Linear priority mapping | E-0122, E-0032 | integrations-linear.md#import | |
| Due date from the earlier of due date and cycle end | E-0122, E-0032 | integrations-linear.md#due-dates-and-cycles | |
| Sync Linear issues without due dates | E-0122, E-0123 | integrations-linear.md#due-dates-and-cycles | legacy only |
| Higher priority gets an earlier due date in a cycle | E-0122 | integrations-linear.md#due-dates-and-cycles | legacy; offsets unknown |
| Linear workflow states drive sync, start, completion and delete | E-0116 | integrations-linear.md#workflow-states | legacy only |
| Link attachment on the synced Linear issue | E-0122 | integrations-linear.md#display | legacy only |
| Private Linear projects through a Linear webhook | E-0186 | integrations-linear.md#private-projects-legacy-evidence | legacy only |
| Disconnect Linear | E-0151 | integrations-linear.md#disconnect | |
| Install the Raycast extension and sign in | E-0152, E-0034, E-0137 | integrations-raycast.md#install-and-sign-in | macOS only |
| Calendar menu bar with next event and countdown | E-0040, E-0152, E-0034 | integrations-raycast.md#calendar-menu-bar | |
| Join, start and complete from the menu bar | E-0040, E-0034, E-0152 | integrations-raycast.md#calendar-menu-bar | |
| Number of upcoming events in the menu bar | E-0040 | integrations-raycast.md#calendar-menu-bar | legacy only |
| My Calendar command with free or busy state | E-0137 | integrations-raycast.md#my-calendar | legacy only |
| Create Task form in Raycast | E-0062, E-0034, E-0137 | integrations-raycast.md#create-task | |
| Task link copied after creation | E-0062 | integrations-raycast.md#create-task | legacy only |
| Quick Task one-line syntax | E-0062, E-0137 | integrations-raycast.md#quick-task | legacy only |
| Booking links list and copy in Raycast | E-0210, E-0152, E-0034 | integrations-raycast.md#booking-links | |
| Personalize and share a one-off link from Raycast | E-0210 | integrations-raycast.md#booking-links | legacy only |
| Custom hotkeys for commands | E-0166 | integrations-raycast.md#hotkeys | Raycast feature |
| Uninstall the Raycast extension | E-0137, E-0152 | integrations-raycast.md#uninstall | |
| Personal API keys with expiry and regenerate | E-0137, E-0061 | integrations-api-keys-zapier.md#api-keys | legacy only |
| Connect Zapier with an API key | E-0061 | integrations-api-keys-zapier.md#zapier | legacy; unofficial in reference |
| Create tasks from other apps through Zapier | E-0061 | integrations-api-keys-zapier.md#zapier | legacy only |
| Webhook endpoints in team settings, admin only | E-0155, E-0037, E-0214 | integrations-webhooks.md#endpoint-management | Business and Enterprise in reference |
| Generated or typed webhook secret, with regenerate | E-0155, E-0214 | integrations-webhooks.md#endpoint-management | |
| Attach one or more endpoints to a booking link | E-0155, E-0037, E-0214 | integrations-webhooks.md#endpoint-management | booking link editor owned by group C |
| Remove or delete a webhook | E-0155 | integrations-webhooks.md#endpoint-management | |
| HTTPS only; no localhost or IP hosts | E-0155, E-0037, E-0214 | integrations-webhooks.md#concepts-and-inputs | |
| Webhook on booking created, rescheduled, cancelled | E-0155, E-0037, E-0214 | integrations-webhooks.md#delivery | |
| 10-second response limit and success codes | E-0155, E-0037, E-0214 | integrations-webhooks.md#delivery | |
| Retry with backoff and Retry-After | E-0214 | integrations-webhooks.md#delivery | |
| Endpoint suspended after 24 hours of failures | E-0214 | integrations-webhooks.md#delivery | |
| Duplicate and out-of-order delivery contract | E-0155, E-0037, E-0214 | integrations-webhooks.md#delivery | |
| Webhook payload with meeting, attendee, organizer and link data | E-0155, E-0037, E-0214 | integrations-webhooks.md#payload | |
| Custom data passthrough (5 parameters, 512 bytes) | E-0037, E-0214 | integrations-webhooks.md#payload | |
| Date-based payload versions | E-0214 | integrations-webhooks.md#payload | |
| HMAC SHA-256 signature header | E-0155, E-0037, E-0214 | integrations-webhooks.md#signature | |
| One MCP server URL for any AI client | E-0133, E-0026, E-0027, E-0147 | integrations-ai-tools.md#shared-rules | current; group E owns tools |
| Read tools answer at once; writes go to the change preview | E-0026, E-0027, E-0133, E-0144 | integrations-ai-tools.md#shared-rules | current |
| AI capability set (schedule, find time, events, RSVP, focus, analysis, work sessions) | E-0144, E-0145, E-0147, E-0026, E-0027 | integrations-ai-tools.md#concepts-and-inputs | current |
| Disconnect an AI client; calendar access stays | E-0144, E-0145, E-0147 | integrations-ai-tools.md#shared-rules | |
| ChatGPT app | E-0144, E-0026, E-0002 | integrations-ai-tools.md#chatgpt | current; needs paid ChatGPT plan |
| Claude Desktop and web connector | E-0145, E-0027, E-0002 | integrations-ai-tools.md#claude | current |
| Claude Code setup | E-0145, E-0027 | integrations-ai-tools.md#claude | current |
| Per-tool permissions in Claude | E-0027 | integrations-ai-tools.md#claude | client feature |
| Cursor setup | E-0147 | integrations-ai-tools.md#cursor | current |
| Other MCP clients | E-0133 | integrations-ai-tools.md#other-mcp-clients | current |
| Install the calendar add-on, per user or for a Workspace domain | E-0136 | integrations-calendar-add-on.md#install-and-link | legacy only |
| Add-on Priorities tab | E-0136 | integrations-calendar-add-on.md#tabs | legacy only |
| Add-on Tasks tab with search and new task | E-0136 | integrations-calendar-add-on.md#tabs | legacy only |
| Add-on Habits tab | E-0136 | integrations-calendar-add-on.md#tabs | legacy only |
| Add-on flexible meetings tab | E-0136 | integrations-calendar-add-on.md#tabs | legacy only |
| Add-on booking links tab with personalize and share | E-0136 | integrations-calendar-add-on.md#tabs | legacy only |
| Add-on card for an opened managed event | E-0136 | integrations-calendar-add-on.md#event-context-card | legacy only |
| Add-on shows the source of a mirrored copy | E-0136 | integrations-calendar-add-on.md#event-context-card | legacy only |
| Add-on sync check and Repair button | E-0160 | integrations-calendar-add-on.md#event-context-card | legacy only |
| Booking links from Gmail through the add-on | E-0136 | integrations-calendar-add-on.md#gmail | group C owns the flow |
