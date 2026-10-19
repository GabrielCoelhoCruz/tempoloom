# Feature parity

This table lists every feature of the reference product that we found in its
public documentation (and, later, in a logged-in test account). See
`docs/clean-room.md` for how evidence is collected and cited.

Status values:

- **done (CalDAV)**: implemented, and a passing full UI E2E test against a
  real CalDAV calendar proves it (real events created, moved and deleted;
  reload and persistence checked). The last column names the tests.
- **done (Google)**: done (CalDAV), and every test that proves the row also
  passed against a Google Calendar account in the recorded Google run
  (`docs/e2e-google-run.md`, test list in `docs/e2e-google-run.tsv`). A row
  with a test that skipped on Google, or a test added after the run, stays
  done (CalDAV). The two counts do not overlap: done (CalDAV) counts the rows
  proven on CalDAV only.
- **partial**: implemented, but only unit tests prove it, or a part of the
  spec is missing. The last column says which.
- **blocked**: not implemented yet, or a non-goal. The last column gives the
  reason.

Evidence ids (`E-…`) refer to the private evidence index. Spec links point to
`docs/specs/`.
