// Shared steps for team policy scenarios (docs/specs/teams-policies.md). They
// drive the Policies page like an admin or a member would; the SCIM client
// plays the identity provider that sets directory attributes.
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import { at, type CalendarDriver, expect, type Person } from "./fixtures.ts";
import { MIN, titled } from "./helpers.ts";
import { ENTERPRISE, scim } from "./scim.ts";
import { openTeam } from "./team-helpers.ts";

export type Idp = ReturnType<typeof scim>;

export interface Member {
  person: Person;
  page: Page;
  scimId: string;
}

/**
 * The signed-in admin (e2e) makes a SCIM token; the identity provider adds each
 * person with a department, and each person signs in. The admin has no
 * directory profile, so only whole-team policies match the admin.
 */
export async function provisioned(
  page: Page,
  signIn: () => Promise<void>,
  people: (n: 3 | 4 | 5 | 6) => Promise<Person>,
  members: { n: 3 | 4 | 5 | 6; department?: string }[],
): Promise<{ idp: Idp; members: Member[] }> {
  await signIn();
  await openTeam(page);
  const directory = page.getByTestId("directory");
  await directory.getByRole("button", { name: "Create SCIM token" }).click();
  const token = (await directory.getByTestId("scim-token").textContent()) ?? "";
  const idp = scim(token);
  const out: Member[] = [];
  for (const m of members) {
    const person = await people(m.n);
    const scimId = await idp.create({
      userName: person.email,
      ...(m.department ? { department: m.department } : {}),
    });
    out.push({ person, scimId, page: await person.signIn() });
  }
  return { idp, members: out };
}

export async function setDepartment(idp: Idp, scimId: string, department: string): Promise<void> {
  const r = await idp.patch(scimId, [
    { op: "replace", path: `${ENTERPRISE}:department`, value: department },
  ]);
  expect(r.status).toBe(200);
}

export async function openPolicies(p: Page): Promise<void> {
  await p.getByRole("link", { name: "Policies", exact: true }).click();
  await expect(p.getByTestId("policies-page")).toBeVisible();
}

export interface PolicyForm {
  type?: "Focus time" | "Buffers" | "Meeting agendas" | "Calendar fragmentation";
  name?: string;
  /** Omitted: the whole team. */
  scope?: { attribute: string; value: string };
  weeklyGoalHours?: number;
  dailyBreak?: number;
  prep?: { type: string; minutes: number };
  followUp?: { type: string; minutes: number };
  meetingTypes?: ("One-on-one" | "Team meeting" | "External meeting")[];
  strictness?: "Remind" | "Adjust" | "Auto-decline";
  leadHours?: number;
  minBlock?: number;
  target?: number;
  flexibility?: "Low" | "Medium" | "High";
  enabled?: boolean;
}

async function fill(p: Page, f: PolicyForm): Promise<void> {
  const form = p.getByTestId("policy-form");
  if (f.type) await form.getByLabel("Type").selectOption({ label: f.type });
  if (f.name) await form.getByLabel("Name").fill(f.name);
  if (f.scope) {
    await form.getByLabel("Scope attribute").fill(f.scope.attribute);
    await form.getByLabel("Scope value").fill(f.scope.value);
  }
  if (f.weeklyGoalHours !== undefined)
    await form.getByLabel("Weekly goal (hours)").fill(String(f.weeklyGoalHours));
  if (f.dailyBreak !== undefined)
    await form.getByLabel("Minimum daily break (minutes)").fill(String(f.dailyBreak));
  if (f.prep) {
    await form.getByLabel("Prep before").selectOption({ label: f.prep.type });
    await form.getByLabel("Prep minutes").fill(String(f.prep.minutes));
  }
  if (f.followUp) {
    await form.getByLabel("Follow-up after").selectOption({ label: f.followUp.type });
    await form.getByLabel("Follow-up minutes").fill(String(f.followUp.minutes));
  }
  if (f.meetingTypes) {
    for (const t of ["One-on-one", "Team meeting", "External meeting"] as const) {
      await form.getByLabel(t, { exact: true }).setChecked(f.meetingTypes.includes(t));
    }
  }
  if (f.strictness) await form.getByLabel("Strictness").selectOption({ label: f.strictness });
  if (f.leadHours !== undefined)
    await form.getByLabel("Decline lead time (hours)").fill(String(f.leadHours));
  if (f.minBlock !== undefined)
    await form.getByLabel("Minimum usable block (minutes)").fill(String(f.minBlock));
  if (f.target !== undefined) await form.getByLabel("Target reduction (%)").fill(String(f.target));
  if (f.flexibility)
    await form.getByLabel("Member flexibility").selectOption({ label: f.flexibility });
  if (f.enabled !== undefined) await form.getByLabel("Enabled").setChecked(f.enabled);
}

/** Creates a policy with the form; enabled unless `enabled: false`. */
export async function createPolicy(p: Page, f: PolicyForm & { name: string }): Promise<void> {
  await openPolicies(p);
  await fill(p, { enabled: true, ...f });
  await p.getByTestId("policy-form").getByRole("button", { name: "Save policy" }).click();
  await expect(policyRow(p, f.name)).toBeVisible();
}

export async function editPolicy(p: Page, name: string, f: PolicyForm): Promise<void> {
  await openPolicies(p);
  await policyRow(p, name).getByRole("button", { name: "Edit" }).click();
  await fill(p, f);
  await p.getByTestId("policy-form").getByRole("button", { name: "Save policy" }).click();
  await expect(p.getByTestId("policy-saved")).toBeVisible();
}

export const policyRow = (p: Page, name: string) => p.locator(`[data-policy="${name}"]`);

/** Opens a policy's report; the report stays open across a reload (URL). */
export async function openReport(p: Page, name: string) {
  await openPolicies(p);
  await policyRow(p, name).getByRole("button", { name: "Report" }).click();
  const report = p.getByTestId("policy-report");
  await expect(report).toBeVisible();
  return report;
}

/** A report cell: one metric in one week (YYYY-MM-DD of the week's Monday). */
export const cell = (report: ReturnType<Page["getByTestId"]>, metric: string, week: string) =>
  report.locator(`tr[data-metric="${metric}"] td[data-week="${week}"]`);

/** Minutes of managed events with `title` in the week that starts on `monday`. */
export async function minutesIn(
  cal: CalendarDriver,
  monday: string,
  title: string,
): Promise<number> {
  const evs = await cal.events(at(monday, "00:00"), at(addDays(monday, 7), "00:00"));
  return titled(evs, title).reduce((a, e) => a + (e.end - e.start), 0) / MIN;
}
