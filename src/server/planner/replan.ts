import type { Db } from "../db.ts";
import type { GoogleCalendarApi } from "../google/calendar.ts";

export interface ReplanContext {
  db: Db;
  apiFor: (accountId: string) => GoogleCalendarApi;
  now: number;
}

export async function replanUser(_ctx: ReplanContext, _userId: string): Promise<void> {}
