## Group C: flexible meetings and booking links

| Feature | Evidence | Spec | Notes |
|---|---|---|---|
| Flexible meeting: attach rules to an existing recurring meeting | E-0176 | meetings-flexible.md#setup | current version |
| Flexible meeting: create a new series from a form | E-0177, E-0046 | meetings-flexible.md#setup | legacy only |
| Invite anyone by email; attendees need no account | E-0073, E-0177, E-0176 | meetings-flexible.md#organizer-and-attendees | |
| Attendee availability from instance users and Google free/busy | E-0073, E-0176 | meetings-flexible.md#concepts-and-inputs | |
| Warning for an attendee without calendar visibility | E-0073 | meetings-flexible.md#setup | |
| Optional attendees ignored for availability | E-0177, E-0223, E-0131 | meetings-flexible.md#organizer-and-attendees | |
| Attendee time zones shown on the form | E-0177 | meetings-flexible.md#setup | |
| Availability map of attendees' hours overlap | E-0177, E-0223 | meetings-flexible.md#setup | legacy only |
| Organizer sets hours for one attendee | E-0177, E-0223 | meetings-flexible.md#setup | legacy only |
| Frequency: daily, weekly, monthly, custom | E-0177 | meetings-flexible.md#concepts-and-inputs | legacy only; adopted series keep their recurrence |
| Ideal day and ideal time | E-0177, E-0176 | meetings-flexible.md#placement | |
| Duration with a shorten-to minimum | E-0176, E-0177, E-0223 | meetings-flexible.md#placement | |
| Hours mode: everyone's meeting hours, organizer's hours, item-specific hours | E-0176, E-0177, E-0172 | meetings-flexible.md#placement | |
| Start date that delays or pauses a meeting | E-0177 | meetings-flexible.md#concepts-and-inputs | legacy only |
| Meeting priority P1 to P4, default P2 | E-0113, E-0177 | meetings-flexible.md#concepts-and-inputs | |
| Rank order inside one priority level | E-0176, E-0043 | meetings-flexible.md#scheduler-and-other-calendars | current version |
| Meeting displaces lower-priority tasks, habits, meetings; never external or booked events | E-0113, E-0104, E-0141 | meetings-flexible.md#scheduler-and-other-calendars | |
| Meetings placed before focus time | E-0090, E-0141 | meetings-flexible.md#scheduler-and-other-calendars | |
| Attendee users see each occurrence as P1 | E-0113 | meetings-flexible.md#scheduler-and-other-calendars | legacy only |
| Unanswered conflicting invitations do not block | E-0131 | meetings-flexible.md#placement | |
| Best common time across attendees and time zones | E-0006, E-0177, E-0131 | meetings-flexible.md#placement | |
| Cadence kept after an occurrence moves | E-0131 | meetings-flexible.md#placement | legacy only |
| Adaptive free-to-busy defense | E-0092, E-0177 | meetings-flexible.md#defense | legacy only; 12 vs 24 hours conflict |
| Event settings: busy or free, visibility, reminders | E-0043 | meetings-flexible.md#concepts-and-inputs | current version |
| Description and agenda on every occurrence (markdown) | E-0177, E-0039 | meetings-flexible.md#description-agenda-and-location | |
| Third-party agenda tools stay attached after moves | E-0039, E-0176 | meetings-flexible.md#description-agenda-and-location | Docs notes, Lattice, Fellow |
| Conference link, address, custom location, room resource | E-0177, E-0168 | meetings-flexible.md#description-agenda-and-location | Zoom via SPEC-INT-03 |
| Target calendar on any connected account | E-0177 | meetings-flexible.md#concepts-and-inputs | fixed after creation |
| Dependencies between meetings and habits | E-0177 | meetings-flexible.md#placement | legacy only; stored on the habit |
| Preview of changes before saving rules | E-0043 | meetings-flexible.md#setup | current version |
| Rules list grouped by priority, drag to reorder | E-0176, E-0043 | meetings-flexible.md#outputs | current version |
| No limit on meetings per organizer | E-0073 | meetings-flexible.md#organizer-and-attendees | plan-gated in reference |
| 1:1 and group meetings | E-0177, E-0046 | meetings-flexible.md#organizer-and-attendees | |
| Agenda policies: detection, reminders, auto-decline, templates, generated agendas | E-0018 | meetings-flexible.md#open-questions | owned by teams-policies.md |
| Meeting analytics | E-0006 | analytics-personal-stats.md#summary | owned by group E |
| Automatic move on conflict | E-0131, E-0176, E-0006 | meetings-flexible-rescheduling.md#triggers-for-an-automatic-move | |
| Automatic move when a required attendee declines | E-0131, E-0046 | meetings-flexible-rescheduling.md#triggers-for-an-automatic-move | |
| Re-placement after a rule or hours change | E-0105, E-0172 | meetings-flexible-rescheduling.md#triggers-for-an-automatic-move | |
| Minimum lead time for moves | E-0176 | meetings-flexible-rescheduling.md#limits-on-automatic-moves | current version |
| Auto-reschedule policy: none, 1, 3 or 5 moves per day | E-0176 | meetings-flexible-rescheduling.md#limits-on-automatic-moves | current version |
| Conflict flag with suggested times | E-0176 | meetings-flexible-rescheduling.md#limits-on-automatic-moves | current version |
| No time found: remove, or keep in conflict with a warning | E-0176, E-0131, E-0177, E-0223 | meetings-flexible-rescheduling.md#limits-on-automatic-moves | |
| Auto-lock by day or week | E-0176, E-0045, E-0046, E-0108 | meetings-flexible-rescheduling.md#limits-on-automatic-moves | values from legacy pages |
| Priority boost after missed periods | E-0113, E-0177 | meetings-flexible-rescheduling.md#limits-on-automatic-moves | legacy only |
| Manual move locks the occurrence | E-0131, E-0176, E-0046, E-0105 | meetings-flexible-rescheduling.md#manual-actions-by-the-organizer | |
| Resize one occurrence or following ones | E-0131 | meetings-flexible-rescheduling.md#manual-actions-by-the-organizer | |
| Reschedule action: same day or another day | E-0131, E-0046 | meetings-flexible-rescheduling.md#manual-actions-by-the-organizer | legacy only |
| Skip action; delete in calendar skips the period | E-0131, E-0046 | meetings-flexible-rescheduling.md#manual-actions-by-the-organizer | |
| Lock and unlock in the Planner | E-0176, E-0046, E-0045 | meetings-flexible-rescheduling.md#manual-actions-by-the-organizer | |
| Edits in Google Calendar kept; privacy and free/busy written back | E-0131, E-0039 | meetings-flexible-rescheduling.md#manual-actions-by-the-organizer | |
| Move a week of meetings through the assistant chat | E-0176 | meetings-flexible-rescheduling.md#manual-actions-by-the-organizer | owned by assistant-chat.md |
| Attendee reschedule or skip in a 1:1 | E-0177, E-0088 | meetings-flexible-rescheduling.md#actions-by-attendees | legacy only |
| Disable a meeting | E-0097, E-0043 | meetings-flexible-rescheduling.md#disable-and-delete | |
| Delete a meeting, with or without attendee notice | E-0097 | meetings-flexible-rescheduling.md#disable-and-delete | |
| Change log per occurrence | E-0092, E-0223 | meetings-flexible-rescheduling.md#reporting | |
| Attention list of unplaced occurrences | E-0223 | meetings-flexible-rescheduling.md#reporting | |
| Skipped periods shown on the meeting | E-0092 | meetings-flexible-rescheduling.md#reporting | legacy only |
| Daily at-risk digest email | E-0223 | meetings-flexible-rescheduling.md#reporting | E-0125 calls it planned |
| Guest update emails on meeting changes | E-0223 | meetings-flexible-rescheduling.md#reporting | setting owned by planning-notifications.md |
| Start-time intervals (:00, :15, :30, :45) for meetings and links | E-0167, E-0198 | meetings-start-intervals.md#behavior | |
| Root slug and main booking page | E-0162, E-0173 | booking-links.md#setup-and-link-list | |
| Starter links created at setup | E-0162, E-0173 | booking-links.md#setup-and-link-list | |
| Create and edit a booking link | E-0163, E-0063 | booking-links.md#setup-and-link-list | |
| Link title, description, event title with organizer and attendee variables | E-0063, E-0163 | booking-links.md#concepts-and-inputs | |
| Custom link URL slug | E-0063 | booking-links.md#concepts-and-inputs | |
| Up to 3 durations with a default | E-0063, E-0162, E-0163, E-0217, E-0138 | booking-links.md#concepts-and-inputs | |
| Target calendar for booked events | E-0063, E-0007 | booking-links.md#concepts-and-inputs | |
| Hours per organizer, meeting hours by default | E-0063, E-0163, E-0172, E-0173 | booking-links.md#concepts-and-inputs | |
| Link priority P1 to P4 | E-0063, E-0163, E-0165, E-0007 | booking-links.md#concepts-and-inputs | |
| Minimum notice (soonest booking time) | E-0063, E-0163 | booking-links.md#concepts-and-inputs | |
| Booking horizon, up to 100 days or a date | E-0063, E-0163 | booking-links.md#concepts-and-inputs | not limited by planning window |
| Buffers before and after; travel and recovery buffers | E-0163, E-0063, E-0138 | booking-links.md#concepts-and-inputs | |
| Maximum bookings per day or week | E-0063, E-0163, E-0198 | booking-links.md#concepts-and-inputs | plan-gated in reference |
| Location options with a default (Meet, Zoom, Gong, address, phone, custom) | E-0063, E-0217, E-0173 | booking-links.md#concepts-and-inputs | |
| Screening questions | E-0063, E-0163, E-0173 | booking-links.md#concepts-and-inputs | plan-gated in reference |
| Reminder email before the meeting | E-0063, E-0163, E-0138 | booking-links.md#reminder-email | |
| Redirect URL after booking | E-0063, E-0163, E-0217 | booking-links.md#booking | plan-gated in reference |
| Link cards with actions; change priority from the card | E-0173, E-0165 | booking-links.md#setup-and-link-list | |
| Hidden links reachable by direct URL | E-0063, E-0163, E-0205 | booking-links.md#setup-and-link-list | |
| Booking creates a busy event with invite, conference and manage links | E-0063, E-0217, E-0088 | booking-links.md#booking | |
| Booked events never overbooked by managed items | E-0165, E-0141, E-0113 | booking-links.md#scheduler-and-other-calendars | |
| Booking moves lower-priority managed events | E-0141, E-0162, E-0088 | booking-links.md#scheduler-and-other-calendars | |
| Confirmation, update and cancel emails | E-0217 | booking-links.md#booking | |
| Booker reschedules from link or confirmation page | E-0217, E-0007 | booking-links.md#reschedule-and-cancel | |
| Booker cancels from link or confirmation page | E-0217 | booking-links.md#reschedule-and-cancel | |
| Unlimited booking links | E-0003 | booking-links.md#setup-and-link-list | plan-gated in reference |
| Webhook endpoints attached to a link | E-0214, E-0163 | booking-links.md#concepts-and-inputs | delivery in integrations-webhooks.md |
| Link priority opens time held by lower-priority events | E-0163, E-0165, E-0007, E-0162 | booking-links-availability.md#checks | |
| External events P1 by default; lowered ones offered by higher links | E-0165, E-0104, E-0141 | booking-links-availability.md#concepts-and-inputs | |
| Focus time offered only by P1 links | E-0141, E-0090 | booking-links-availability.md#concepts-and-inputs | |
| Checks: range, limits, start minutes, hours, buffers, conflicts | E-0198, E-0063 | booking-links-availability.md#checks | |
| Availability follows calendar changes live | E-0007 | booking-links-availability.md#checks | |
| Times listed per duration | E-0217 | booking-links-availability.md#candidate-times | |
| Preferred times with a green dot | E-0066, E-0217 | booking-links-availability.md#preferred-times | |
| Availability inspector with reasons per time | E-0198, E-0173 | booking-links-availability.md#availability-inspector | organizers only |
| Public booking page, no account needed | E-0217 | booking-links-booking-page.md#booking-page | |
| Duration picker on the page | E-0217 | booking-links-booking-page.md#booking-page | |
| Time zone picker that shows the actual zone | E-0217 | booking-links-booking-page.md#booking-page | |
| 12-hour or 24-hour time format | E-0217 | booking-links-booking-page.md#booking-page | |
| URL parameters for time zone, day, time, duration | E-0063 | booking-links-booking-page.md#booking-page | |
| Overlay my calendar for logged-in bookers | E-0217, E-0173 | booking-links-booking-page.md#booking-page | |
| Details form: name, email, CC, message, questions, location | E-0217, E-0063 | booking-links-booking-page.md#details-and-confirmation | |
| Confirmation page with reschedule and cancel | E-0217 | booking-links-booking-page.md#details-and-confirmation | |
| Round-robin host shown only after confirmation | E-0065, E-0163 | booking-links-booking-page.md#details-and-confirmation | |
| Branding: default, none or custom at team, group, link level | E-0055, E-0163 | booking-links-booking-page.md#branding | plan-gated in reference |
| Custom logo, banner and homepage link | E-0055 | booking-links-booking-page.md#branding | plan-gated in reference |
| Team links: all required organizers must be free | E-0066, E-0163, E-0162, E-0007 | booking-links-team.md#team-links | |
| Each co-organizer sets own hours on the link | E-0066, E-0163 | booking-links-team.md#team-links | |
| Optional co-organizers | E-0066, E-0163, E-0063 | booking-links-team.md#team-links | |
| Host organizer and host's conference integration | E-0063, E-0065 | booking-links-team.md#team-links | |
| Longest recovery buffer among organizers | E-0063 | booking-links-team.md#team-links | legacy only |
| Co-organizer permissions | E-0066, E-0065 | booking-links-team.md#team-links | |
| Round-robin links | E-0065, E-0163, E-0007 | booking-links-team.md#round-robin-links | plan-gated in reference |
| Round-robin with required or optional organizers | E-0065, E-0163 | booking-links-team.md#round-robin-links | |
| Round-robin load balance by fewest bookings | E-0065, E-0163 | booking-links-team.md#round-robin-links | |
| Preferred organizers in a round-robin pool | E-0065, E-0163 | booking-links-team.md#round-robin-links | |
| Round-robin reschedule keeps the same host | E-0065, E-0163 | booking-links-team.md#round-robin-links | |
| Conference integration required for every possible host | E-0065 | booking-links-team.md#round-robin-links | |
| Link groups with their own booking pages | E-0205, E-0162, E-0163 | booking-links-sharing.md#link-groups-and-pages | |
| Edit or delete a group; move or delete its links | E-0205 | booking-links-sharing.md#link-groups-and-pages | |
| Team links page group | E-0205 | booking-links-sharing.md#concepts-and-inputs | |
| One-off personalized links, 30-day expiry | E-0138, E-0163, E-0162, E-0217, E-0007 | booking-links-sharing.md#one-off-links | |
| Share chosen times (up to 5 dates) as buttons or text | E-0138, E-0173, E-0007 | booking-links-sharing.md#shared-times | |
| Shared-times template with variables, last edit kept | E-0138 | booking-links-sharing.md#shared-times | |
| Share by email and social networks | E-0174, E-0163 | booking-links-sharing.md#share-menu-and-embeds | |
| Website embeds: script, object, iframe, URL | E-0174, E-0163, E-0007 | booking-links-sharing.md#share-menu-and-embeds | |
| Embed redirect modes | E-0174 | booking-links-sharing.md#share-menu-and-embeds | |
| Calendar and Gmail add-on: copy, personalize, add to email, insert times | E-0164, E-0136, E-0007 | booking-links-sharing.md#calendar-and-mail-add-on | add-on shell in integrations-calendar-add-on.md |
| Gmail mobile flow for links and times | E-0164 | booking-links-sharing.md#calendar-and-mail-add-on | |
| One-off links and shared times from Raycast | E-0138 | integrations-raycast.md#booking-links | owned by group F |
