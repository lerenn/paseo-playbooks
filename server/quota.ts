/** Patterns of the errors providers give when an account is out of tokens, credits or request quota. Extend this one list when a provider words it differently. */
const QUOTA_PATTERNS: RegExp[] = [
  /rate[\s_-]?limit/i,
  /usage[\s_-]?limit/i,
  /\bquota\b.{0,40}(exceed|exhaust|reach|hit|used|limit)|(exceed|exhaust|reach|hit|out of).{0,40}\bquota\b|insufficient[_\s]quota/i,
  /insufficient[\s_-]?(credits?|funds|balance)/i,
  /credit balance (is )?(too low|exhausted)/i,
  /out of (tokens|credits)/i,
  /(token|credit)s?\b.{0,20}\b(exhausted|depleted|used up)/i,
  /(reached|hit|exceeded)\b.{0,30}\b(your|the|monthly|daily|weekly|5-hour|session)?\s*(usage|token|spend(ing)?|message)?\s*limit/i,
  /resource[_\s]exhausted/i,
  /too many requests/i,
  /\b429\b.{0,40}(limit|quota|too many|exhaust)/i,
  /\b(http|status|code|error)\b\W{0,3}429\b/i,
  /\b(5-hour|session|daily|weekly|monthly|opus|sonnet)\s+limit\b/i,
  /\blimit\b.{0,20}\bresets?\b/i,
  /out of extra usage/i,
];

/** The longest last message of a completed turn that can be a provider's out-of-tokens notice (longer ones are the agent's own words). */
export const QUOTA_MESSAGE_MAX = 400;

/** Whether a failure's text says the provider ran out of tokens (quota, rate or usage limit, credits). */
export function isQuotaError(text: string | null | undefined): boolean {
  if (!text) return false;
  return QUOTA_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Whether a turn that ended normally (not `failed`) ended on the provider's out-of-tokens notice: some
 * providers (Claude Code's "You've hit your weekly limit") end the turn with it as the assistant's
 * text. Only a short last message counts, so an agent writing about rate limits is not mistaken for one.
 */
export function isQuotaMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  return trimmed.length <= QUOTA_MESSAGE_MAX && isQuotaError(trimmed);
}
