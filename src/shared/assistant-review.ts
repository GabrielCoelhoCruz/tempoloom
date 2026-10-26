// The review request of assistant chat (docs/specs/assistant-chat.md rules
// 15-20): the panel's Recommendations action and the daily review send it.
import { addDays } from "./time.ts";

/** The request to review the local dates from `from` to `toExclusive`. */
export const reviewRequest = (from: string, toExclusive: string) =>
  `Recommendations: review my schedule from ${from} to ${addDays(toExclusive, -1)} and stage a fix for each issue.`;
