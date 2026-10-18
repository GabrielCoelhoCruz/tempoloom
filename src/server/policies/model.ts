// Team policies (docs/specs/teams-policies.md): the common shape, the goal of
// each type, scope rules on directory attributes, and the policy of each type
// that applies to a member (rules 2-5, edge case 5).
import { z } from "zod";
import { all, type Db, one } from "../db.ts";
import { type Attributes, directoryAttributes } from "../directory.ts";
import { membership, TeamError } from "../teams.ts";

export const POLICY_TYPES = ["focus_time", "buffers", "meeting_agendas", "fragmentation"] as const;
export type PolicyType = (typeof POLICY_TYPES)[number];

/** Categories of events with other people (events-categories-and-colors.md). */
export const MEETING_CATEGORIES = ["one_on_one", "team_meeting", "external_meeting"] as const;
export type MeetingCategory = (typeof MEETING_CATEGORIES)[number];

const meetingCategory = z.enum(MEETING_CATEGORIES);
const bufferRule = z.object({
  category: meetingCategory,
  minutes: z.number().int().min(5).max(240).multipleOf(5),
});

export const FLEXIBILITY = ["low", "medium", "high"] as const;
export type Flexibility = (typeof FLEXIBILITY)[number];
/** How far (minutes) a new item may move from its ideal time to avoid a short gap. */
export const SHIFT_MINUTES: Record<Flexibility, number> = { low: 15, medium: 30, high: 60 };

export const goalSchemas = {
  focus_time: z.object({
    weeklyGoalMinutes: z
      .number()
      .int()
      .min(60)
      .max(40 * 60)
      .multipleOf(30)
      .default(600),
  }),
  buffers: z.object({
    minDailyBreakMinutes: z.number().int().min(0).max(240).multipleOf(15).default(30),
    prepBefore: z.array(bufferRule).max(3).default([]),
    followUpAfter: z.array(bufferRule).max(3).default([]),
    recoveryAfter: z.array(bufferRule).max(3).default([]),
  }),
  meeting_agendas: z.object({
    meetingTypes: z
      .array(meetingCategory)
      .min(1)
      .default([...MEETING_CATEGORIES]),
    strictness: z.enum(["remind", "adjust", "auto_decline"]).default("remind"),
    leadMinutes: z
      .number()
      .int()
      .min(15)
      .max(14 * 24 * 60)
      .default(24 * 60),
  }),
  fragmentation: z.object({
    targetReductionPercent: z.number().int().min(0).max(100).default(25),
    minUsableBlockMinutes: z.number().int().min(15).max(240).multipleOf(15).default(60),
    memberFlexibility: z.enum(FLEXIBILITY).default("medium"),
  }),
};

export type FocusGoal = z.infer<typeof goalSchemas.focus_time>;
export type BufferGoal = z.infer<typeof goalSchemas.buffers>;
export type AgendaGoal = z.infer<typeof goalSchemas.meeting_agendas>;
export type FragmentationGoal = z.infer<typeof goalSchemas.fragmentation>;

export const scopeRule = z.object({
  attribute: z.string().trim().min(1).max(100),
  value: z.string().trim().min(1).max(200),
});
export type ScopeRule = z.infer<typeof scopeRule>;

export interface PolicyRow {
  id: string;
  team_id: string;
  type: PolicyType;
  name: string;
  scope: string;
  goal: string;
  enabled: number;
  started_at: number | null;
  created_at: number;
  updated_at: number;
}

export type Policy = {
  id: string;
  teamId: string;
  name: string;
  scope: ScopeRule[];
  enabled: boolean;
  startedAt: number | null;
  updatedAt: number;
} & (
  | { type: "focus_time"; goal: FocusGoal }
  | { type: "buffers"; goal: BufferGoal }
  | { type: "meeting_agendas"; goal: AgendaGoal }
  | { type: "fragmentation"; goal: FragmentationGoal }
);

export function parsePolicy(r: PolicyRow): Policy {
  return {
    id: r.id,
    teamId: r.team_id,
    name: r.name,
    scope: JSON.parse(r.scope) as ScopeRule[],
    enabled: r.enabled === 1,
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    type: r.type,
    goal: goalSchemas[r.type].parse(JSON.parse(r.goal)),
  } as Policy;
}

/** Rule 5: role over team over department over the whole team (rank 0). */
function rankOf(attribute: string): number {
  const a = attribute.toLowerCase().replace(/[^a-z]/g, "");
  if (["role", "title", "jobtitle", "level"].includes(a)) return 3;
  if (["department", "division"].includes(a)) return 1;
  return 2;
}

/**
 * How narrowly a scope matches a member: -1 for no match, 0 for the whole team.
 * A scope matches when any rule matches; a missing attribute never matches
 * (edge case 5). Values compare without case.
 */
export function matchRank(scope: ScopeRule[], attrs: Attributes | undefined): number {
  if (scope.length === 0) return 0;
  let best = -1;
  for (const r of scope) {
    const name = r.attribute.toLowerCase();
    const value = Object.entries(attrs ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];
    if (value !== undefined && value.trim().toLowerCase() === r.value.toLowerCase()) {
      best = Math.max(best, rankOf(r.attribute));
    }
  }
  return best;
}

export const teamPolicies = (db: Db, teamId: string, enabledOnly = false): Policy[] =>
  all<PolicyRow>(
    db,
    `SELECT * FROM team_policies WHERE team_id = ? ${enabledOnly ? "AND enabled = 1" : ""}
     ORDER BY created_at, id`,
    teamId,
  ).map(parsePolicy);

/** The enabled policy of each type that applies to the user (rules 2, 5). */
export function winningPolicies(db: Db, userId: string): Map<PolicyType, Policy> {
  let teamId: string;
  try {
    teamId = membership(db, userId).team.id;
  } catch (err) {
    if (err instanceof TeamError) return new Map();
    throw err;
  }
  const policies = teamPolicies(db, teamId, true);
  const out = new Map<PolicyType, { p: Policy; rank: number }>();
  if (policies.length === 0) return new Map();
  const attrs = directoryAttributes(db, teamId).get(userId);
  for (const p of policies) {
    const rank = matchRank(p.scope, attrs);
    if (rank < 0) continue;
    const cur = out.get(p.type);
    // On a tie, the most recently changed policy wins.
    if (
      !cur ||
      rank > cur.rank ||
      (rank === cur.rank &&
        (p.updatedAt > cur.p.updatedAt || (p.updatedAt === cur.p.updatedAt && p.id > cur.p.id)))
    ) {
      out.set(p.type, { p, rank });
    }
  }
  return new Map([...out].map(([k, v]) => [k, v.p]));
}

/** Active members of the team that a policy's scope matches. */
export function membersInScope(db: Db, policy: Policy): string[] {
  const attrs = directoryAttributes(db, policy.teamId);
  return all<{ user_id: string }>(
    db,
    `SELECT m.user_id FROM team_members m JOIN users u ON u.id = m.user_id
     WHERE m.team_id = ? AND u.deactivated_at IS NULL ORDER BY u.email`,
    policy.teamId,
  )
    .map((r) => r.user_id)
    .filter((id) => matchRank(policy.scope, attrs.get(id)) >= 0);
}

/** The member's flexibility in a fragmentation policy: their own choice, else the policy's. */
export function flexibilityOf(db: Db, policy: Policy, userId: string): Flexibility {
  const raw = one<{ choices: string }>(
    db,
    "SELECT choices FROM policy_choices WHERE policy_id = ? AND user_id = ?",
    policy.id,
    userId,
  )?.choices;
  const own = raw ? (JSON.parse(raw) as { flexibility?: Flexibility }).flexibility : undefined;
  return own ?? (policy.type === "fragmentation" ? policy.goal.memberFlexibility : "medium");
}

/** The scheduler preference of the fragmentation policy that applies to the user (rule 23). */
export function fragmentationPreference(
  db: Db,
  userId: string,
): { minBlockMinutes: number; maxShiftMinutes: number } | undefined {
  const p = winningPolicies(db, userId).get("fragmentation");
  if (p?.type !== "fragmentation") return undefined;
  return {
    minBlockMinutes: p.goal.minUsableBlockMinutes,
    maxShiftMinutes: SHIFT_MINUTES[flexibilityOf(db, p, userId)],
  };
}
