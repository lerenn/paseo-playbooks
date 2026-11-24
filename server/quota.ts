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

/** How a provider's own out-of-tokens notice begins (it is the whole message: "You've hit your weekly limit · resets 3pm", "Claude AI usage limit reached|…"). */
const NOTICE_LEAD = /^\W*(you(['\u2019]?(ve|re|ll))?\b|your\b|claude\b|codex\b|upgrade to\b|usage limit|limit reached|(\d+|five)[-\s]?hour|weekly|session|daily|monthly|credit|insufficient|out of\b|(api )?error\b|429\b|http\b|rate[\s_-]?limit (reached|exceeded)|quota\b|this request would exceed)/i;

/** Words of an agent describing the run it manages (a hold, a gate, a step), never of a provider's notice. */
const OWN_WORDS = /\b(hold|gates?|steps?|playbooks?|plugin|run_[0-9a-f]+|pr|pull request|ci|review(er)?s?|waiv(e|er|ed))\b/i;

/**
 * Whether a turn that ended normally (not `failed`) ended on the provider's out-of-tokens notice: some
 * providers (Claude Code's "You've hit your weekly limit") end the turn with it as the assistant's
 * text. Only a short last message that reads as the notice itself counts (it starts like one and does not talk about
 * the run), so an agent's own words about a rate limit hold or a bot's usage limit are not mistaken for one.
 */
export function isQuotaMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  return trimmed.length <= QUOTA_MESSAGE_MAX && NOTICE_LEAD.test(trimmed) && !OWN_WORDS.test(trimmed) && isQuotaError(trimmed);
}
