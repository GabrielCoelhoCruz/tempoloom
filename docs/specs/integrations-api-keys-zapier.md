# Personal API keys and the Zapier integration

Spec id: SPEC-INT-12
Evidence: E-0061 (ev_a5e880592e52), E-0137 (ev_2dae93b7631b)
Status of evidence: public docs only

## Summary

A user can create personal API keys in Tempoloom. Clients such as the legacy
Raycast extension and Zapier use a key to act for the user. With Zapier,
the user can create Tempoloom tasks from events in other apps. All evidence
is legacy. The reference calls its Zapier guide unofficial, and its support
does not cover Zap problems.

## Concepts and inputs

Personal API key:

| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | string, 1 to 100 chars | none | For example "Raycast". |
| `expires` | enum: 30 days, 90 days, 1 year, never | never | The reference recommends "never" for Raycast so that the user does not need to make a new key. Options other than "never" are Proposed. |
| `secret` | string | generated | Shown once, at creation. |
| `created_at`, `last_used_at` | timestamp | | |

Zapier connection: a Zapier account connection of the app "Tempoloom" that
stores one personal API key.

## Behavior

### API keys

1. The user opens Settings > Developer > API keys. (Location: Proposed
   default.)
2. The user enters a name, chooses an expiry, and clicks Generate. Tempoloom
   shows the key once, with a copy button.
3. A request with a valid key acts as the key's user, with the same rights
   as the user in the web app.
4. The list shows each key's name, expiry and last use. A Regenerate action
   replaces the secret and invalidates the old one at once. A Delete action
   removes the key.
5. An expired or deleted key gets HTTP 401 on every request.

### Zapier

6. Requirement: a Tempoloom account and a Zapier account. In the reference,
   the entry plan and all paid plans can use Zapier.
7. To connect, the user adds a connection in Zapier, searches for
   Tempoloom, and pastes a personal API key in the API key field.
8. Zapier checks the key with one API call. On success, the connection is
   ready for Zaps.
9. Zap actions: "Create task" with the task fields of `planning-tasks.md`
   (title, duration, due date, priority, notes, hours set). The reference
   evidence names only task creation; other actions and triggers are open
   questions.
10. A task created through Zapier is a normal task. The scheduler places it
    like any task.
11. Booking link events reach Zapier through outgoing webhooks
    (`integrations-webhooks.md`). The Zapier app does not need its own
    booking triggers for this.

## Outputs

- API key records; one-time secret display.
- Tasks created through the API, with their chunks.

## Edge cases

1. The user loses the key: it cannot be shown again; the user regenerates
   it, and every client that used it must get the new key.
2. A Zap sends a task with no duration: the user's default duration applies.
3. A Zap sends a due date in the past: Proposed default: the API rejects it
   with HTTP 422 and a message.
4. A Zap sends many tasks fast: Proposed default: rate limit of 60 requests
   per minute per key, HTTP 429 with `Retry-After`.

## Observed API shapes

Not yet observed. Legacy evidence shows the key format as groups of letters
and digits joined by hyphens.

## Open questions

1. Which Zapier triggers and actions does the reference offer?
2. Does the current version still have personal API keys, or only OAuth?
3. Which expiry options does the reference offer besides "never"?
4. Where in the settings does the reference put API keys?

## Acceptance tests

1. Create and use a key.
   - Setup: Tempoloom user with a Google Calendar test account.
   - Action: create a key "test", expiry never. Call the create-task API
     with the key: title "API task", duration 1 hour, due in 2 work days.
   - Expected: the task exists in the web app and its 1-hour chunk is in
     Google Calendar before the due date.
   - Reload: reload the web app and Google Calendar; the task remains.
2. Regenerate invalidates the old key.
   - Action: regenerate the key; call the API with the old secret, then
     with the new one.
   - Expected: the old secret gets 401; the new one works.
   - Reload: the key list shows one key "test".
3. Zapier creates a task.
   - Setup: Zapier test account; Zap with a schedule trigger and the
     Tempoloom "Create task" action.
   - Action: run the Zap once.
   - Expected: the task exists in Tempoloom and its chunks are in Google
     Calendar.
   - Reload: same after reload.
