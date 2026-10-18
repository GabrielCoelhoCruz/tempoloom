# Outgoing webhooks for booking links

Spec id: SPEC-INT-13
Evidence: E-0155 (ev_a3fb80e71423), E-0037 (ev_667181ea1a73), E-0214 (ev_62d8c6933ca7)
Status of evidence: public docs only

## Summary

A team admin creates webhook endpoints in team settings, and team members
attach them to their booking links. When an invitee books, reschedules or
cancels a meeting through such a link, Tempoloom sends a signed JSON POST
request to each attached endpoint. CRMs and automation platforms use this
to start follow-up work.

## Concepts and inputs

### Scope and evidence

This spec owns the delivery contract. `booking-links.md` (group C) owns
the booking link editor and should refer to this spec for the webhook
field. E-0214 is a group C page; this spec uses it for the delivery
details.

### Fields

Webhook endpoint (per team):

| Field | Type | Default | Rules |
|---|---|---|---|
| `id` | id | generated | |
| `name` | string, 1 to 100 chars | none | Required. |
| `url` | URL | none | Required. Must use `https`. Host must not be `localhost`, a `localhost` variant (such as `*.localhost`), or an IP address literal (such as `127.0.0.1`). |
| `secret` | string, 32 to 128 chars | generated on create | The admin may type a value instead, and may regenerate it. |
| `status` | enum `active`, `suspended` | `active` | See rule 15. |
| `created_by` | user id | | |

Booking link field: `webhook_endpoint_ids`, a list of zero or more endpoint
ids of the link owner's team.

Event types (Tempoloom names; the reference uses its own names for the same
three events):

| Type | When |
|---|---|
| `booking_link.meeting.created` | An invitee books a meeting through the link. |
| `booking_link.meeting.updated` | A booked meeting changes, usually a reschedule. |
| `booking_link.meeting.cancelled` | A booked meeting is cancelled. |

Request headers:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-Tempoloom-Webhook-Type` | The event type. |
| `X-Tempoloom-Api-Version` | Payload version, date-based, for example `v2026-10-01`. |
| `X-Tempoloom-Signature-256` | `sha256=` followed by the base64 HMAC-SHA256 of the raw body, keyed with the endpoint secret. |

## Behavior

### Endpoint management

1. Only a team member with the admin role can create, edit and delete
   endpoints, under Team settings > Webhooks. The page has a "+ New" button.
2. Create: the admin enters a name and a URL. Tempoloom validates the URL
   (table above) and rejects an invalid one with a message under the field.
   Tempoloom generates a secret and shows it with a copy button. The admin
   may replace it with a typed value.
3. The admin can regenerate the secret. The new secret applies to the next
   request. The page tells the admin to update the receiver.
4. Any team member can attach endpoints to their own booking links in the
   booking link editor. A link can have several endpoints.
5. An endpoint sends nothing until at least one booking link uses it.
6. Removing an endpoint from a link stops requests for that link. Deleting
   an endpoint removes it from all links and stops all its requests.

### Delivery

7. For each event on a booking link, Tempoloom sends one POST request to
   each attached active endpoint.
8. Delivery counts as successful when the endpoint answers HTTP 200, 201,
   202 or 204 within 10 seconds. Any other result is a failure.
9. On failure, Tempoloom retries with exponential backoff. When the response
   has a `Retry-After` header, Tempoloom waits that long instead. Proposed
   default backoff: 30 s, 1 min, 2 min, 4 min, doubling up to 1 hour between
   tries.
10. Tempoloom tries to deliver each event once. In rare cases a receiver
    gets the same event more than once. Receivers dedupe by `request_id`.
11. Tempoloom tries to send events in the order they happened, but does not
    guarantee it. A receiver can get an `updated` event before the `created`
    event of the same meeting.
12. Tempoloom does not follow redirects. (Proposed default.)
13. Tempoloom does not send requests to private or loopback addresses after
    DNS resolution. (Proposed default; it extends the host rule.) An
    instance operator setting can allow private addresses for self-hosted
    receivers; it is off by default.
14. Request timeout is 10 seconds, the same as rule 8.
15. When every delivery to an endpoint has failed for over 24 hours, the
    endpoint becomes `suspended`. Tempoloom then sends no new requests to
    it. The webhooks page shows the suspended state. Proposed default: the
    admin can click Resume, and Tempoloom also emails the admins.

### Payload

16. The body is one JSON object. Top-level fields:
    - `type`: the event type;
    - `event_ts`: when the event happened (ISO 8601 UTC);
    - `webhook_sent_at`: when this request was sent;
    - `api_version`;
    - `request_id`: unique per event and endpoint (UUID v7 suggested);
    - `webhook_endpoint_id`;
    - `meeting` (created, cancelled), or `previous_meeting`, `new_meeting`
      and `change_reason` (updated).
17. A meeting object has:
    - `meeting_id`, `meeting_title`, `meeting_url`;
    - `booking_link_id`, `booking_link_title`, `booking_link_description`;
    - `start_time`, `end_time`, `scheduled_at`, and when they apply
      `rescheduled_at` and `cancelled_at`;
    - `participants`: list of hosts and other people on the link. Each has
      `is_host`, `email`, and when known `user_id` (Tempoloom users only),
      `name` and `time_zone` (`id`, `display_name`, `abbreviation`);
    - `attendee`: the invitee, with `id` (when the invitee is a Tempoloom
      user), `email`, `name`, `time_zone`;
    - `ccs`: extra guest emails;
    - `message`: the invitee's note;
    - `location`: with `conference` (for example `GOOGLE_MEET`, `ZOOM`,
      `GONG`) or a text location;
    - `answers`: the invitee's answers to booking questions;
    - `custom_data` (rules 18 to 21).
18. Custom data: the booking page URL can carry up to five query parameters
    whose names start with `data-`. Tempoloom passes them to the payload as
    `custom_data.data`, with the `data-` prefix removed from each key.
19. The total size of `custom_data.data` as minified JSON must be under 512
    bytes.
20. When there are more than five parameters or the size limit is passed,
    `custom_data.data` is empty and `custom_data.errors` contains
    `TRUNCATED`.
21. When a key or value cannot be serialized to JSON, `custom_data.errors`
    contains `UNSERIALIZABLE`.
22. Payload versions are date-based. A new version only adds fields. The
    endpoint gets the latest version unless the admin pins an older one.
    (Pinning: Proposed default.)

### Signature

23. The signature is `sha256=` + base64(HMAC-SHA256(secret, raw body)).
    Receivers compute the same value over the raw body and compare in
    constant time.
24. The webhooks page shows a short verification example. (The reference
    shows a NodeJS example.)

## Outputs

- HTTPS POST requests to endpoints, with the headers and body above.
- Endpoint list in team settings with status.
- No calendar changes.

## Edge cases

1. A meeting is booked, then cancelled within a second: both events are
   sent; the receiver may get them in either order.
2. A booking link has two endpoints and one is suspended: only the active
   one gets requests.
3. The secret is regenerated while retries are pending: the retries use the
   new secret. (Proposed default.)
4. The endpoint answers 3xx: failure (rule 12).
5. The booking link owner leaves the team: Proposed default: the team's
   endpoints are removed from that user's links.
6. Custom data with a key like `data-` and no name: the key is ignored and
   `custom_data.errors` stays empty. (Proposed default.)

## Observed API shapes

Public docs (E-0214) show the reference's body shape: the top-level and
meeting fields listed in rules 16 and 17, a vendor-prefixed type header, a
vendor-prefixed date-based version header, and a vendor-prefixed signature
header with a `sha256=` prefix and a base64 digest. The reference has three
payload versions; each newer one only adds fields: first, participant
entries for people who are not users; then, link title and description,
meeting title and meeting URL. Logged-in shapes: not yet observed.

## Open questions

1. Can a member see endpoints, or only pick them by name in the booking
   link editor?
2. How does a suspended endpoint become active again in the reference?
3. Does the reference send webhooks for other events (for example flexible
   meetings)? Its docs ask users to request more event types.
4. Which plans include webhooks? The help page says Business and
   Enterprise; the marketing header lists Starter too.

## Acceptance tests

Common setup: Tempoloom team with an admin and a member. The member has a
Google Calendar test account and a booking link. A test HTTPS receiver logs
requests and answers 200.

1. Booking sends a signed request.
   - Setup: admin creates endpoint "CRM" with the receiver URL; the member
     attaches it to the booking link.
   - Action: an invitee books a slot on `<booking url>?data-source=ad1`.
   - Expected: the event is in the member's Google Calendar. Within 30
     seconds, the receiver logs one POST with type
     `booking_link.meeting.created`, a valid signature for the secret,
     `custom_data.data.source` = `ad1`, and the meeting start and end that
     match the calendar event.
   - Reload: reload Google Calendar; the event remains. The receiver log
     keeps the request.
2. Reschedule and cancel.
   - Action: the invitee reschedules, then cancels.
   - Expected: the calendar event moves, then is removed. The receiver logs
     an `updated` event with old and new times, then a `cancelled` event.
   - Reload: the calendar has no event after reload.
3. URL validation.
   - Action: the admin tries `http://example.com/hook`,
     `https://localhost/hook` and `https://127.0.0.1/hook`.
   - Expected: each is rejected with a message; no endpoint is saved.
   - Reload: the list has no new endpoint.
4. Retry on failure.
   - Setup: the receiver answers 500 twice, then 200.
   - Action: book a slot.
   - Expected: the receiver logs 3 requests with the same `request_id`.
   - Reload: not applicable.
5. Too much custom data.
   - Action: book on a URL with six `data-` parameters.
   - Expected: the payload has an empty `custom_data.data` and `errors`
     contains `TRUNCATED`. The booking itself succeeds.
   - Reload: the calendar event remains.
6. Member cannot create endpoints.
   - Action: the member opens Team settings > Webhooks.
   - Expected: no "+ New" button; an API call to create an endpoint gets
     HTTP 403.
   - Reload: same after reload.
