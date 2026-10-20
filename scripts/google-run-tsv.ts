// Converts a Playwright JSON report of the Google Calendar E2E run into
// docs/e2e-google-run.tsv: one line per test with its status, test id
// (tests/e2e/<file>:<line>) and title, sorted by file name (punctuation ignored),
// then line.
//
//   node scripts/google-run-tsv.ts <report.json> > docs/e2e-google-run.tsv
//
// The status is the status of the test's last result (passed, skipped, failed,
// timedOut or interrupted). The report itself is a local file; it is not committed.
import { readFileSync } from "node:fs";

type Result = { status: string };
type Spec = { title: string; line: number; tests: { results: Result[] }[] };
type Suite = { title: string; file: string; specs?: Spec[]; suites?: Suite[] };

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/google-run-tsv.ts <playwright-report.json>");
  process.exit(2);
}
const report = JSON.parse(readFileSync(path, "utf8")) as { suites: Suite[] };

const rows: { file: string; line: number; status: string; title: string }[] = [];
function collect(suite: Suite, describe: string[]): void {
  for (const spec of suite.specs ?? []) {
    const title = [...describe, spec.title].join(" › ");
    for (const test of spec.tests) {
      const status = test.results.at(-1)?.status ?? "skipped";
      rows.push({ file: suite.file, line: spec.line, status, title });
    }
  }
  for (const child of suite.suites ?? []) collect(child, [...describe, child.title]);
}
for (const suite of report.suites) collect(suite, []);

// Files in English collation order with punctuation ignored, as GNU sort orders them.
const files = new Intl.Collator("en", { ignorePunctuation: true });
rows.sort((a, b) => files.compare(a.file, b.file) || a.line - b.line);
for (const row of rows) {
  if (/[\t\n]/.test(row.title))
    throw new Error(`a tab or newline in the title of ${row.file}:${row.line}`);
}
process.stdout.write(
  rows.map((r) => `${r.status}\ttests/e2e/${r.file}:${r.line}\t${r.title}\n`).join(""),
);
