# Clean-room process

Tempoloom matches the functions of an existing commercial calendar planner
(the "reference product"). We build it without its code, assets or text.

## Rules

1. Observation and implementation are separate steps.
   - Spec writers observe the reference product's public pages and a
     throwaway test account with [REA](https://github.com/morluto/rea), at
     human pace.
   - They write behavior specs in `docs/specs/` in their own words: what a
     feature does, its inputs, outputs, edge cases and observed API shapes.
   - Implementers write code only from those specs.
2. The repository never contains the reference product's JavaScript, CSS,
   images, logos, copied text or name.
3. Raw captures (REA Evidence, HAR files, exported scripts) stay outside the
   repository. Tokens and cookies are redacted. Specs cite them by a neutral
   evidence id (`E-0001`) and the REA Evidence id (`ev_…`).
4. No high-volume or automated load on the reference product. No real user
   data; only throwaway test accounts.

## Evidence ids

- `E-0001` to `E-0999`: public pages (marketing site and help docs).
- `L-0001` and up: observations of the logged-in test account.

The private index that maps each id to its source is kept with the raw
evidence, outside this repository.
