// The daily review of assistant chat (docs/specs/assistant-chat.md rules
// 15-18) for the email worker (src/server/daily-mail.ts): one chat turn with
// the review request, in a new conversation, whose fixes wait in preview mode.
// The worker runs in the server and in the CLI, so the review has its own chat
// and preview service; it only reads and stages, so it needs no calendar sync.
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { createLiveHub } from "../live.ts";
import { createLlm } from "../llm.ts";
import type { Mailer } from "../mail.ts";
import { createPreview } from "../preview.ts";
import type { SyncService } from "../sync/service.ts";
import { createChat } from "./chat.ts";
import { chatTools } from "./tools.ts";

/** Reviews a user's days from `from` to `toExclusive`; the conversation, or null. */
export type Review = (
  user: { id: string; email: string; name: string; time_zone: string },
  from: string,
  toExclusive: string,
) => Promise<string | null>;

/** Staging and reads only: apply never runs here, so sync calls do nothing. */
const NO_SYNC = new Proxy({}, { get: () => () => undefined }) as SyncService;

/** The review, or undefined when the operator connected no model. */
export function dailyReview(deps: {
  db: Db;
  config: Config;
  mailer: Mailer;
  now: () => number;
}): Review | undefined {
  const { db, config, now } = deps;
  if (!config.TEMPOLOOM_LLM_BASE_URL) return undefined;
  const preview = createPreview({
    db,
    sync: NO_SYNC,
    mailer: deps.mailer,
    live: createLiveHub(),
    now,
    app: () => {
      throw new Error("The daily review does not apply changes");
    },
    // No dry run: the review stages event fixes, which need none.
    dry: () => null,
  });
  const chat = createChat({
    db,
    llm: createLlm({
      baseUrl: config.TEMPOLOOM_LLM_BASE_URL,
      apiKey: config.TEMPOLOOM_LLM_API_KEY,
      model: config.TEMPOLOOM_LLM_MODEL,
      timeoutMs: config.TEMPOLOOM_LLM_TIMEOUT_MS,
    }),
    tools: chatTools({ db, preview, baseUrl: config.BASE_URL, now }),
    now,
    turnMs: config.TEMPOLOOM_LLM_TURN_MS,
  });
  return (user, from, toExclusive) => chat.review(user, from, toExclusive);
}
