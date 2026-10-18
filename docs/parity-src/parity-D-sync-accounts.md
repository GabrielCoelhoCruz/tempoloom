# Parity rows: D-sync-accounts

| Feature | Evidence | Spec | Notes |
|---|---|---|---|
| Create a mirroring policy (source, destination, then preferences) | E-0064, E-0202, E-0109 | sync-calendar-mirroring.md#policy-management | |
| Pick source and destination from any added account, shared calendars included | E-0109, E-0053 | sync-calendar-mirroring.md#policy-management | |
| Mirror across providers (Google and Microsoft) | E-0053, E-0008 | sync-calendar-mirroring.md#policy-management | |
| Refuse a destination that is another account's main calendar | E-0202 | sync-calendar-mirroring.md#policy-management | |
| Policy list with one filter tab per account | E-0128 | sync-calendar-mirroring.md#policy-management | |
| Edit policy settings after creation | E-0128, E-0064 | sync-calendar-mirroring.md#policy-management | |
| Policy on/off toggle with throttle warning | E-0128 | sync-calendar-mirroring.md#policy-management | |
| Full re-sync by turning a policy off and on | E-0221 | sync-calendar-mirroring.md#policy-management | |
| Delete a policy with confirmation | E-0128 | sync-calendar-mirroring.md#policy-management | cannot be undone |
| First policy offered during onboarding | E-0128, E-0188 | sync-calendar-mirroring.md#policy-management | partly legacy |
| Two-way mirroring with two policies | E-0202 | sync-calendar-mirroring.md#policy-management | settings differ per direction |
| Many-calendar setups (full mesh of policies) | E-0058, E-0064 | sync-calendar-mirroring.md#policy-management | |
| Limit on number of policies per plan | E-0003, E-0064 | sync-calendar-mirroring.md#plan-limits-in-the-reference | plan-gated in reference; sources conflict |
| Copies kept 12 months ahead | E-0003 | sync-calendar-mirroring.md#copy-decision | |
| Copies are never copied again (no chaining) | E-0202 | sync-calendar-mirroring.md#copy-decision | |
| No-sync tag `#tl_nosync` in title or description | E-0064, E-0208, E-0126, E-0203 | sync-calendar-mirroring.md#copy-decision | |
| Skip events where the destination is already invited | E-0084 | sync-calendar-mirroring.md#copy-decision | |
| Declined events get no copy | E-0091 | sync-calendar-mirroring.md#copy-decision | |
| All-day event modes: none, busy only, all | E-0064, E-0084, E-0008 | sync-calendar-mirroring.md#copy-decision | default none |
| Copy only during work hours (per policy) | E-0064, E-0008 | sync-calendar-mirroring.md#copy-decision | |
| Email-created events copied as busy | E-0084 | sync-calendar-mirroring.md#copy-decision | |
| Response sets copy free/busy (accepted or tentative busy, no reply free) | E-0091 | sync-calendar-mirroring.md#copy-decision | |
| Setting for copies of events with no reply (free or busy) | E-0091 | sync-calendar-mirroring.md#account-level-setting | account-wide |
| Organizer who is not an attendee: copy is busy | E-0091 | sync-calendar-mirroring.md#copy-decision | |
| Free events: skipped with label or busy privacy, copied free with details | E-0084 | sync-calendar-mirroring.md#copy-decision | |
| Privacy option: label only (personal or work commitment) | E-0064, E-0008, E-0074, E-0188 | sync-calendar-mirroring.md#copy-appearance | only option on free plan |
| Privacy option: busy only | E-0064, E-0008, E-0074 | sync-calendar-mirroring.md#copy-appearance | plan-gated in reference |
| Privacy option: details, private visibility | E-0064, E-0008, E-0100 | sync-calendar-mirroring.md#copy-appearance | plan-gated in reference |
| Privacy option: details, calendar default visibility | E-0064, E-0008, E-0074 | sync-calendar-mirroring.md#copy-appearance | plan-gated in reference |
| Warning that admins can see private details | E-0064, E-0100 | sync-calendar-mirroring.md#copy-appearance | |
| Copy labels by category and calendar type (PTO, Travel, Flight, Meeting) | E-0064 | sync-calendar-mirroring.md#copy-appearance | |
| Calendar type per policy (business, personal, travel) | E-0064, E-0202 | sync-calendar-mirroring.md#copy-appearance | drives categories and stats |
| Color override per policy | E-0064, E-0058 | sync-calendar-mirroring.md#copy-appearance | |
| Copies never alert the user | E-0224 | sync-calendar-mirroring.md#copy-appearance | |
| Creator marker in copy description | E-0188 | sync-calendar-mirroring.md#copy-appearance | legacy evidence |
| Planner and add-on show a copy with its source details | E-0100, E-0136 | sync-calendar-mirroring.md#copy-appearance | add-on part legacy |
| Copies and other connected-calendar events are P1 | E-0104 | sync-calendar-mirroring.md#copy-appearance | legacy evidence |
| Copies follow source changes in near real time | E-0008, E-0029, E-0033, E-0053 | sync-calendar-mirroring.md#updates-and-deletes | |
| Copy removed when source is deleted | E-0188, E-0053 | sync-calendar-mirroring.md#updates-and-deletes | |
| Deleted or edited copy is put back | E-0117, E-0126, E-0100 | sync-calendar-mirroring.md#updates-and-deletes | |
| Full reconcile twice a day | E-0126 | sync-calendar-mirroring.md#updates-and-deletes | |
| Saved setting changes rewrite existing copies | E-0064 | sync-calendar-mirroring.md#updates-and-deletes | |
| Share source calendar with main account to see details | E-0219 | sync-calendar-mirroring.md#source-details-and-external-calendars | trigger unknown |
| Help for missing source details (Workspace sharing, Gmail events) | E-0219 | sync-calendar-mirroring.md#source-details-and-external-calendars | |
| iCloud and other calendars through Google or Microsoft | E-0059, E-0053, E-0114 | sync-calendar-mirroring.md#source-details-and-external-calendars | delays expected |
| Family calendar guidance (decline or tag) | E-0126 | sync-calendar-mirroring.md#edge-cases | |
| Duplicate view guidance (hide source calendar) | E-0100, E-0058 | sync-calendar-mirroring.md#edge-cases | |
| Connected calendar settings page | E-0060, E-0106, E-0041 | accounts-connected-calendars.md#choosing-connected-calendars | |
| Main calendar always connected | E-0060, E-0106 | accounts-connected-calendars.md#choosing-connected-calendars | |
| Calendars in a mirroring policy locked as connected | E-0106 | accounts-connected-calendars.md#choosing-connected-calendars | |
| Only full-access calendars listed; no holiday or group calendars | E-0060, E-0106 | accounts-connected-calendars.md#choosing-connected-calendars | |
| Calendar seen through two accounts listed once | E-0106 | accounts-connected-calendars.md#choosing-connected-calendars | |
| Category per connected calendar | E-0106 | accounts-connected-calendars.md#choosing-connected-calendars | |
| Connected calendar limit per plan; downgrade turns extras off | E-0060, E-0003 | accounts-connected-calendars.md#plan-limits-in-the-reference | plan-gated in reference; sources conflict |
| Availability comes from all connected calendars only | E-0060, E-0218, E-0114, E-0010 | accounts-connected-calendars.md#availability-set-which-calendars-count | |
| Managed events written to main calendar by default | E-0060, E-0114 | accounts-connected-calendars.md#write-targets-where-tempoloom-writes | |
| Target calendar for habits and flexible meetings, set at creation | E-0082 | accounts-connected-calendars.md#write-targets-where-tempoloom-writes | legacy evidence |
| Task calendar per hours set | E-0172, E-0125 | accounts-connected-calendars.md#write-targets-where-tempoloom-writes | |
| Booking-link events on the chosen account's primary calendar | E-0063 | accounts-connected-calendars.md#write-targets-where-tempoloom-writes | legacy evidence |
| Explain connected calendars versus mirroring | E-0218, E-0053, E-0086, E-0060 | accounts-connected-calendars.md#connected-calendars-versus-mirroring | |
| Shared calendars usable as connected calendars | E-0059, E-0106 | accounts-connected-calendars.md#shared-and-external-calendars | |
| Sign up with Google or Microsoft | E-0124, E-0029, E-0033, E-0211 | accounts-login-emails-permissions.md#sign-up-and-login | |
| Log in with any added email | E-0124 | accounts-login-emails-permissions.md#sign-up-and-login | |
| Login when an email belongs to several accounts | E-0124 | accounts-login-emails-permissions.md#sign-up-and-login | |
| Add a Google or Microsoft account | E-0041, E-0106 | accounts-login-emails-permissions.md#adding-and-removing-emails | |
| Remove an added account | E-0041 | accounts-login-emails-permissions.md#adding-and-removing-emails | |
| Change the main email | E-0094, E-0060 | accounts-login-emails-permissions.md#main-email | |
| Error when the email is main in another account, with fix | E-0094 | accounts-login-emails-permissions.md#main-email | |
| Disconnected status and reconnect | E-0094 | accounts-login-emails-permissions.md#disconnected-emails | |
| Google permissions asked per feature (incremental consent) | E-0079 | accounts-login-emails-permissions.md#provider-permissions | scope list not captured |
| Workspace admin approves the app for the domain | E-0029 | accounts-login-emails-permissions.md#provider-permissions | |
| Microsoft admin approval help flow | E-0220 | accounts-login-emails-permissions.md#provider-permissions | |
| On-premises Exchange rejected | E-0211 | accounts-login-emails-permissions.md#provider-permissions | not supported in reference |
| Give delegated access to a team member | E-0099, E-0074, E-0003 | accounts-delegated-access.md#behavior | legacy evidence; plan-gated in reference |
| Switch into the owner's account, banner, exit | E-0099, E-0074 | accounts-delegated-access.md#behavior | legacy evidence |
| Delegate cannot delete account, change accounts or API keys | E-0099, E-0074 | accounts-delegated-access.md#behavior | legacy evidence |
| Live updates with owner and delegate active at once | E-0099 | accounts-delegated-access.md#behavior | legacy evidence |
| All planning features on Outlook calendars | E-0211, E-0033, E-0003 | accounts-outlook-support.md#general | |
| Tags not read from Microsoft response notes | E-0211 | accounts-outlook-support.md#differences-from-google | |
| Warning: flexible meeting moves email Microsoft attendees | E-0211 | accounts-outlook-support.md#differences-from-google | |
| Less exact free/busy for Microsoft attendees without an account | E-0211 | accounts-outlook-support.md#differences-from-google | |
| Teams option hidden for Microsoft 365 Family | E-0211 | accounts-outlook-support.md#differences-from-google | |
| No color write-back to external Outlook events | E-0211 | accounts-outlook-support.md#differences-from-google | |
| Managed event colors as Outlook categories | E-0211 | accounts-outlook-support.md#differences-from-google | |
| Task events on Microsoft get a 15-minute reminder | E-0211 | accounts-outlook-support.md#differences-from-google | |
| Google focus-time event type off for Microsoft accounts | E-0211 | accounts-outlook-support.md#differences-from-google | |
| Delegated and shared Outlook mailboxes | E-0211, E-0033 | accounts-outlook-support.md#not-supported-in-the-reference | sources conflict |
| No Teams chat/status and no Outlook Tasks integration | E-0211 | accounts-outlook-support.md#not-supported-in-the-reference | not in reference |
| Troubleshooting help index | E-0159 | support-troubleshooting.md#troubleshooting-index | documentation |
| First steps when copies are missing | E-0221, E-0128 | support-troubleshooting.md#mirroring-not-working-first-steps | |
| Look up one event by its edit link | E-0221, E-0213 | support-troubleshooting.md#look-up-one-event | diagnosis view proposed |
| Repair one event | E-0160 | support-troubleshooting.md#look-up-one-event | legacy evidence; add-on only in reference |
| Event change history (Workspace audit log) | E-0213 | support-troubleshooting.md#event-history | own change log proposed |
| Booked invitees are not auto-accepted | E-0140 | support-troubleshooting.md#invitations-hidden-by-google-anti-spam-legacy-evidence | legacy evidence |
| Google anti-spam invitation guidance | E-0140 | support-troubleshooting.md#invitations-hidden-by-google-anti-spam-legacy-evidence | legacy evidence |
| Apple Calendar alert guidance for copies | E-0224 | support-troubleshooting.md#alerts-for-copies-on-apple-devices | |
| Guidance to stop managed events for good | E-0117 | support-troubleshooting.md#events-that-come-back-after-delete | |
