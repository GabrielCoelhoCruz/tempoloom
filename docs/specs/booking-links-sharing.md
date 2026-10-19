# Sharing booking links

Spec id: SPEC-LINK-05
Evidence: E-0205 (ev_e2940d16a99b), E-0138 (ev_9d7dfaf21591), E-0174 (ev_9d19dd2729f9), E-0164 (ev_e9f6693710f9), E-0163 (ev_aa5715921a1a), E-0162 (ev_a6662888f654), E-0063 (ev_1f870480468c), E-0173 (ev_cc5ae996c9b1), E-0217 (ev_cec6f530162a), E-0136 (ev_caafaaaf01b4), E-0055 (ev_4afbb658ac95), E-0007 (ev_e10aa7cec1e9)
Status of evidence: public docs only

## Summary

Users share booking links in several ways. Link groups put related links on
one booking page. A one-off link changes a link's settings for one meeting
without changing the saved link. Shared times let the user paste a few
chosen times into a message. Embeds put a booking page on a website. A
calendar and mail add-on puts links and times into emails (E-0007,
E-0163).

## Concepts and inputs

### Pages and link groups

| Field | Type | Default | Allowed values | Evidence |
|---|---|---|---|---|
| `title` | string | required | 1 to 120 characters | E-0205 |
| `slug` | string | derived from `title` (SPEC-LINK-01 rule 4) | `a-z`, `0-9`, `-`; unique on the instance | E-0205 |
| `links` | ordered list of link ids | empty | links the user owns | E-0205 |
| `branding` | enum | copied from the team default | see SPEC-LINK-03 | E-0055 |

Built-in pages (E-0205, E-0063):

| Page | URL | Listed links |
|---|---|---|
| Main booking page | the user's root slug | links with `page` = `main` |
| Hidden | none | links with `page` = `hidden`; reachable by direct URL only |
| Team links | none | links where the user is a co-organizer |

Proposed URL scheme: a page is `<BASE_URL>/book/<page slug>`, and a link is
`<BASE_URL>/book/<page slug>/<link slug>`. A hidden link uses the owner's
root slug as page slug.

### One-off link fields (E-0138, E-0163)

| Group | Field | Notes |
|---|---|---|
| Details | `inviteeEmail`, `inviteeName` | prefilled on the booking page |
| Details | `pageTitle` | booking page title |
| Details | `meetingTitle` | event title |
| Details | `organizers` with `hours` | add or remove organizers, change hours |
| Scheduling | `priority` | P1 to P4 |
| Scheduling | `durations`, `defaultDuration` | as SPEC-LINK-01 |
| Scheduling | `rangeStart`, `rangeEnd` | as SPEC-LINK-01 |
| Scheduling | `useTravelBuffer`, `useRecoveryBuffer` | as SPEC-LINK-01 |
| Link options | `slug` | custom URL part |
| Link options | `locations` | as SPEC-LINK-01 |
| Link options | `reminder` | as SPEC-LINK-01 |

All other fields copy the source link at creation.

### Shared times

| Field | Type | Default | Allowed values | Evidence |
|---|---|---|---|---|
| `dates` | list of dates | empty | 1 to 5 dates | E-0138 |
| `times` | list of starts | empty | offered starts on the chosen dates | E-0138 |
| `format` | enum | `buttons` | `buttons`, `text` | E-0138 |
| `showRanges` | boolean | false | start and end instead of start only | E-0138 |
| `includeLinks` | boolean | true | `text` format only | E-0138 |
| `template` | text | Proposed: `Here are some times that work for me ({timezone}):\n{times}\nOr pick another time: {link}` | text with variables | E-0138 |
| `timezone` | IANA zone | the user's calendar zone | any | E-0138 |

Template variables (names are Proposed; E-0138 lists their meaning):
`{duration}` (default duration), `{link}` (booking page URL), `{times}`
(the time list), `{timezone}` (zone name).

## Behavior

### Link groups and pages

1. The user creates a group from the links page: title, slug (defaults
   from the title), and the links to include. Saving publishes the group
   page (E-0205).
   Tempoloom decision: the URL name fills in from the title until the user
   edits it; a URL name in use by any booking page or group, or one of
   `o`, `manage` and `embed` (used by other URLs), is refused. A new group
   copies the team's branding default, as a new booking page does.
2. The link form has a page field to put a link in a group, in the main
   page, or in hidden (E-0063, E-0205, E-0163).
3. A group page lists its links. The booker picks one and gets that link's
   booking page (E-0205, E-0162).
4. The user can edit a group's title, slug and links (E-0205).
5. A change of a group's slug, or a move of a link to another page, breaks
   all URLs shared before for that group or link. The form warns before it
   saves (E-0205).
   Tempoloom decision: the group form warns as soon as its URL name or its
   links change; the link form warns as soon as the page change moves the
   link to another URL. Main and hidden links share the main page URL, so
   a move between them keeps the URL and needs no warning. A link taken out
   of a group goes back to the main page.
6. Delete group: the user chooses one option (E-0205):
   - keep the links by moving them to another page, then remove the
     group; or
   - remove the group together with every link in it.
   Tempoloom decision: "move" offers the main page, hidden, or another
   group. Deleting links keeps their booked events (SPEC-LINK-01 rule 20).
7. The links page shows a copy-URL action for each group (E-0205).

### One-off links

8. From any link card, including team links where the user is a
   co-organizer, the user opens the personalize action (E-0138, E-0163).
9. The personalize form shows the fields of the one-off table, prefilled
   from the source link (E-0138).
10. Copy link saves the one-off link and copies its URL (E-0138).
11. A one-off link is not listed on the links page and on no booking page
    (E-0138).
12. Changes to a one-off link never change the source link (E-0138).
13. The creator, logged in, can open the one-off URL and edit it (E-0138).
    Tempoloom decision: the creator owns the one-off link; its page shows
    "Edit this link" to the creator and its organizers, with the same form.
14. A one-off link expires 30 days after creation. After that, its URL shows
    an "expired" page and offers no times (E-0138, E-0163, E-0217).
    Tempoloom decision: the operator can change the lifetime with
    `ONEOFF_LINK_DAYS` (default 30); it applies to existing one-off links
    too. Bookings made through an expired link can still be rescheduled and
    cancelled.
15. Proposed URL: `<BASE_URL>/book/o/<slug>`, where the default slug is a
    random token of 16 lowercase letters and digits.
    Tempoloom decision: as proposed; a custom slug must be unique among all
    one-off links on the instance.
16. Bookings through a one-off link count against the source link's
    `maxPerDay` and `maxPerWeek` (Proposed) and fire the source link's
    webhooks (Proposed).

### Shared times

17. From the personalize action of any link or one-off link, the user picks
    up to 5 dates, then selects offered times under each date (E-0138).
    Tempoloom decision: the dates are the next 14 days in the chosen zone
    (default: the user's calendar zone); the times are those the link offers
    for its default duration. Shared times start from the source link's
    personalize action; a one-off link's own page offers only "Edit".
18. Preview shows the result in the chosen `format` (E-0138):
    - `buttons`: one HTML button per time; each button opens the booking
      page with that time selected. Mail clients without HTML buttons show
      plain links.
    - `text`: plain text. With `includeLinks`, each time is a hyperlink
      that opens the booking page with that time selected.
    - `showRanges`: each item shows start and end.
19. In `text` format with `showRanges` on and `includeLinks` off, adjacent
    times merge into one range (E-0138). Example: 10:00 to 10:30 and 10:30
    to 11:00 become 10:00 to 11:00.
20. The user can edit the template. Tempoloom saves the last edited template
    per user and uses it next time (E-0138).
    Tempoloom decision: the template is saved on the server when the field
    loses focus and when the user copies the times. Buttons are links styled
    as buttons; their plain text fallback is "10:00 (URL)".
21. Copy times puts the result on the clipboard as HTML and as plain text
    (E-0138).
22. Time links use the booking page URL parameters `day`, `time`,
    `duration` and `tz` (SPEC-LINK-03).

### Share menu and embeds

23. The share action of a link card offers: copy URL, share by email (opens
    a mail draft with the URL), share on social networks (opens the
    network's share page with the URL), and embed (E-0174, E-0163).
    Tempoloom decision: the email draft is a `mailto:` link with the link
    title as subject and the proposed `shareMessage` ("Book a time with me:
    {link}") as body. The social networks are LinkedIn, X and Facebook,
    through their public share URLs in a new tab; no vendor API is used.
24. Embed formats (E-0174):
    - script: a script tag and a container; the script loads the page in a
      frame and resizes it (recommended; it follows page design changes);
    - object: an `<object>` tag;
    - iframe: an `<iframe>` tag;
    - URL: the plain URL.
    Tempoloom decision: the script, object and iframe codes load
    `<link URL>?embed=1&redirect=<mode>`. The script is `<BASE_URL>/embed.js`;
    it replaces each `.tempoloom-embed[data-url]` container with a frame and
    sets the frame's height from messages the embedded page sends. Object
    and iframe have a fixed height of 760 px. The container and the object
    hold a plain link to the booking page as a fallback.
25. Embed redirect mode, in the embed advanced options (E-0174):
    - `disabled` (default): no redirect after booking inside an embed;
    - `topPage`: the whole browser page goes to `redirectUrl`;
    - `frame`: only the frame goes to `redirectUrl`; the target page must
      allow framing.
    Tempoloom remembers the user's last choice (E-0174).
    Tempoloom decision: the choice is saved per user on the server when it
    changes, and goes into the code as `redirect=`. In `topPage` mode the
    embedded page navigates the top window and also asks the embed script
    to do it. Outside an embed the redirect works as SPEC-LINK-03 rule 17.
26. Embedded pages use the link's branding (E-0055).

### Calendar and mail add-on

27. The add-on shows the user's links in the side panel of Google Calendar
    and Gmail, and in the Gmail compose toolbar (E-0164, E-0136). The
    add-on shell belongs to `integrations-calendar-add-on.md` (SPEC-INT-15),
    whose rule 15 hands the Gmail sending flow to this spec.
28. For each link the add-on offers (E-0164):
    - copy URL;
    - personalize (one-off link and shared times, rules 8 to 22);
    - add to email (compose only): inserts the link's `shareMessage` with
      `{link}` replaced by the URL;
    - insert times (compose only): inserts the shared times into the draft.
29. On the Gmail mobile app, the personalize action opens in the default
    browser. When the user finishes, the browser page says it can be closed,
    and the add-on offers to insert the times into the draft (E-0164).

### Scheduler and other calendars

30. Sharing never writes to calendars. Bookings from one-off links, group
    pages and embeds follow SPEC-LINK-01 and SPEC-LINK-02.
31. When the priority of a one-off link is above its source link's, it
    offers more time over lower-priority managed events (E-0138, E-0163).
32. A one-off link that adds an organizer checks that organizer's calendar
    and hours (E-0138, E-0173).

## Outputs

- Group pages at their URLs.
- One-off links at their URLs, with expiry.
- Clipboard content for shared times (HTML and plain text).
- Embed code snippets.
- Add-on actions that insert text into Gmail drafts.

## Edge cases

1. A one-off link whose source link is deleted: the one-off link keeps
   working until it expires (Proposed).
2. A shared time that was booked by someone else before the recipient
   clicks: the booking page opens on that date with no time selected.
3. A group with no links: the group page says there are no links.
4. A group slug equal to a user's root slug: refused, because slugs are
   unique on the instance.
5. More than 5 dates selected: the sixth date cannot be selected (E-0138).
6. The embed host page blocks framing of Tempoloom: the script embed shows
   a plain link that opens the booking page (Proposed).

## Observed API shapes

Not yet observed.

## Open questions

1. Exact template variable names and the default template text.
2. Does a one-off link count against the source link's limits and fire its
   webhooks?
3. Can a team member other than the creator edit a one-off link?
4. Which social networks does the share menu offer?
5. Does the current version keep the calendar and mail add-on actions
   unchanged?

## Acceptance tests

Test accounts: A is a Tempoloom user with meeting hours 09:00 to 17:00,
start minutes :00 and :30, and an empty calendar next week. Link "Chat" (P4,
30 minutes) on the main page.

1. Group page
   - Setup: create group "Interviews" with links "Chat" and "Screen".
   - Action: open the group URL in a private window; pick "Chat"; book next
     Tuesday 10:00.
   - Expected: the group page lists both links; A's calendar has the
     booking.
   - Reload: the group page lists both links after reload.
2. Group slug change breaks old URLs
   - Setup: test 1 done.
   - Action: change the group slug.
   - Expected: the old group URL and the old link URL return "not found";
     the new URLs work.
   - Reload: same after reload.
3. One-off link
   - Setup: none.
   - Action: personalize "Chat": invitee name and email, priority P1,
     duration 45, copy link. Open the link in a private window.
   - Expected: the page prefills name and email and offers 45-minute times.
     "Chat" still offers 30 minutes and is unchanged. The one-off link is not
     on the main page.
   - Reload: both pages keep these settings after reload.
4. Shared times as text with merged ranges
   - Setup: none.
   - Action: personalize "Chat", pick next Tuesday, select 10:00 and 10:30,
     choose `text`, `showRanges` on, `includeLinks` off, copy times.
   - Expected: the clipboard text has one range 10:00 to 11:00.
   - Reload: reopening the form shows the last edited template.
5. Embed with redirect
   - Setup: "Chat" with an https `redirectUrl`. A test web page with the
     iframe embed code and redirect mode `topPage`.
   - Action: book through the embed.
   - Expected: after booking, the top page is the redirect URL; A's calendar
     has the event.
   - Reload: the event persists after reload.
