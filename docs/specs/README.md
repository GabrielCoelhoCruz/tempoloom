# Behavior specs

Each file describes one feature: what it does, its inputs and outputs, its
edge cases, and the end-to-end tests that prove it. Specs are written from
observation of the reference product (see `../clean-room.md`), in our own
words, using the names in `../glossary.md`.

Code is written from these specs. When the code and a spec disagree, fix one
of them in the same change.

## Template

```markdown
# <Feature name>

Spec id: SPEC-<AREA>-<NN>
Evidence: E-0123 (ev_…), E-0124 (ev_…)
Status of evidence: public docs only | public docs + logged-in observation

## Summary
Two to four sentences: what the user gets.

## Concepts and inputs
Fields with type, default and allowed range.

## Behavior
Numbered, testable rules. Each rule is one sentence or a short list.

## Outputs
Calendar events created or changed (title, time, free/busy, color,
description), notifications, and UI state.

## Edge cases
Numbered list.

## Observed API shapes
Request and response shapes seen in logged-in observation, value-free.
"Not yet observed" until then.

## Open questions
What the public evidence does not settle.

## Acceptance tests
E2E scenarios against a real Google Calendar test account. Each scenario:
setup, action, expected calendar state, reload check.
```
