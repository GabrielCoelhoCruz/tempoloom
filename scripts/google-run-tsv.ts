// Converts a Playwright JSON report of the Google Calendar E2E run into
// docs/e2e-google-run.tsv: a first line "# commit <sha>" with the full commit
// the run tested, then one line per test with its status, test id
// (tests/e2e/<file>:<line>) and title, sorted by file name (punctuation ignored),
// then line. scripts/build-parity.py compares each passed test with its source at
// that commit.
//
//   node scripts/google-run-tsv.ts <report.json> <commit> > docs/e2e-google-run.tsv
//
// The status is the status of the test's last result (passed, skipped, failed,
// timedOut or interrupted). A test with no result did not run (the run stopped
// early, for example at maxFailures or Ctrl-C), so the converter stops and names
// it. The report itself is a local file; it is not committed.
import { readFileSync } from "node:fs";

type Result = { status: string };
type Spec = { title: string; line: number; tests: { results: Result[] }[] };
type Suite = { title: string; file: string; specs?: Spec[]; suites?: Suite[] };

const [path, commit] = process.argv.slice(2);
if (!path || !commit || !/^[0-9a-f]{40}$/.test(commit)) {
  console.error("usage: node scripts/google-run-tsv.ts <playwright-report.json> <full commit sha>");
  process.exit(2);
}
const report = JSON.parse(readFileSync(path, "utf8")) as { suites: Suite[] };

const rows: { file: string; line: number; status: string; title: string }[] = [];
function collect(suite: Suite, describe: string[]): void {
  for (const spec of suite.specs ?? []) {
    const title = [...describe, spec.title].join(" › ");
    for (const test of spec.tests) {
      const status = test.results.at(-1)?.status;
      if (!status)
        throw new Error(`${suite.file}:${spec.line} has no result: use the report of a full run`);
      rows.push({ file: suite.file, line: spec.line, status, title });
    }
  }
  for (const child of suite.suites ?? []) collect(child, [...describe, child.title]);
}
for (const suite of report.suites) collect(suite, []);

// Files in English collation order with punctuation ignored (the format of the file).
const files = new Intl.Collator("en", { ignorePunctuation: true });
rows.sort((a, b) => files.compare(a.file, b.file) || a.line - b.line);
for (const row of rows) {
  if (/[\t\n]/.test(row.title))
    throw new Error(`a tab or newline in the title of ${row.file}:${row.line}`);
}
process.stdout.write(
  `# commit ${commit}\n` +
    rows.map((r) => `${r.status}\ttests/e2e/${r.file}:${r.line}\t${r.title}\n`).join(""),
);
