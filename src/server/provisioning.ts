// Paced provisioning (docs/specs/admin-sso-provisioning.md rules 10, 12, 18):
// people from an import, and calendars to attach through a team's grant, wait
// in a queue. A worker takes one job per tick, so a large import appears over
// time and the calendar server sees a steady rate.
import { ensureUser } from "./accounts.ts";
import type { SecretBox } from "./crypto.ts";
import { all, type Db, one, run, tx } from "./db.ts";
import { flatten } from "./directory.ts";
import { attachThroughGrant } from "./grant.ts";
import type { SyncService } from "./sync/service.ts";
import { joinTeam, membership } from "./teams.ts";

const CORE = "urn:ietf:params:scim:schemas:core:2.0:User";
/** Attributes of imported people, stored like a SCIM extension so the directory reads them. */
export const IMPORT_SCHEMA = "urn:tempoloom:params:scim:schemas:extension:2.0:User";

export interface PersonInput {
  email: string;
  name: string;
  attributes: Record<string, string>;
}

interface Job extends PersonInput {
  id: number;
  team_id: string;
  create_user: number;
}

/** Queues people: created and attached (`create`), or only attached. */
export function enqueue(
  db: Db,
  teamId: string,
  people: PersonInput[],
  create: boolean,
  now: number,
): void {
  tx(db, () => {
    for (const p of people) {
      run(
        db,
        `INSERT INTO provision_jobs (team_id, email, name, attributes, create_user, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        teamId,
        p.email.toLowerCase(),
        p.name,
        JSON.stringify(p.attributes),
        create ? 1 : 0,
        now,
      );
    }
  });
}

/** Progress of the team's imports. */
export function progress(db: Db, teamId: string) {
  const counts = one<{ total: number; done: number; failed: number }>(
    db,
    `SELECT count(*) AS total, coalesce(sum(state = 'done'), 0) AS done,
       coalesce(sum(state = 'failed'), 0) AS failed
     FROM provision_jobs WHERE team_id = ? AND create_user = 1`,
    teamId,
  ) ?? { total: 0, done: 0, failed: 0 };
  const errors = all<{ email: string; error: string }>(
    db,
    `SELECT email, error FROM provision_jobs WHERE team_id = ? AND state = 'failed'
     ORDER BY id DESC LIMIT 20`,
    teamId,
  );
  return { ...counts, errors };
}

/** Creates the person in the team with a directory record; adopts a person who signed up. */
function createPerson(db: Db, job: Job, now: number): string {
  return tx(db, () => {
    const existing = one<{ id: string }>(db, "SELECT id FROM users WHERE email = ?", job.email);
    if (existing && one(db, "SELECT 1 FROM directory_profiles WHERE user_id = ?", existing.id)) {
      if (membership(db, existing.id).team.id !== job.team_id) throw new Error("in another team");
      return existing.id;
    }
    const user = existing ?? ensureUser(db, job.email, job.name, now, job.team_id);
    if (membership(db, user.id).team.id !== job.team_id) {
      joinTeam(db, user.id, job.team_id, "member", now, undefined);
    }
    const resource = {
      schemas: [CORE, IMPORT_SCHEMA],
      userName: job.email,
      displayName: job.name,
      emails: [{ value: job.email, primary: true }],
      [IMPORT_SCHEMA]: job.attributes,
    };
    run(
      db,
      `INSERT INTO directory_profiles (user_id, team_id, resource, attributes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      user.id,
      job.team_id,
      JSON.stringify(resource),
      JSON.stringify(flatten(resource)),
      now,
      now,
    );
    return user.id;
  });
}

export interface ProvisionDeps {
  db: Db;
  box: SecretBox;
  sync: SyncService;
  /** Jobs per minute. */
  perMinute: number;
  now: () => number;
}

export class ProvisionWorker {
  readonly #deps: ProvisionDeps;
  #timer: NodeJS.Timeout | undefined;
  #busy: Promise<void> | null = null;

  constructor(deps: ProvisionDeps) {
    this.#deps = deps;
  }

  /** Runs the next job unless one is running. */
  tick(): void {
    if (this.#busy) return;
    this.#busy = this.#next()
      .catch((err) => console.error("provisioning failed", err))
      .finally(() => {
        this.#busy = null;
      });
  }

  async #next(): Promise<void> {
    const { db, box, sync, now } = this.#deps;
    const job = one<Job & { attributes: string }>(
      db,
      "SELECT * FROM provision_jobs WHERE state = 'queued' ORDER BY id LIMIT 1",
    );
    if (!job) return;
    const input: Job = { ...job, attributes: JSON.parse(job.attributes) as Record<string, string> };
    try {
      const userId = input.create_user
        ? createPerson(db, input, now())
        : one<{ user_id: string }>(
            db,
            `SELECT m.user_id FROM team_members m JOIN users u ON u.id = m.user_id
             WHERE u.email = ? AND m.team_id = ?`,
            input.email,
            input.team_id,
          )?.user_id;
      if (userId) {
        const accountId = await attachThroughGrant(db, box, input.team_id, userId, now());
        if (accountId) await sync.onConnect(userId, accountId);
      }
      run(db, "UPDATE provision_jobs SET state = 'done', done_at = ? WHERE id = ?", now(), job.id);
    } catch (err) {
      run(
        db,
        "UPDATE provision_jobs SET state = 'failed', error = ?, done_at = ? WHERE id = ?",
        err instanceof Error ? err.message : String(err),
        now(),
        job.id,
      );
    }
  }

  start(): void {
    this.#timer = setInterval(
      () => this.tick(),
      Math.max(10, Math.round(60_000 / this.#deps.perMinute)),
    );
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
    await this.#busy;
  }
}
