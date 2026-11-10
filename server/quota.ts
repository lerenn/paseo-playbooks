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
];

/** Whether a failure's text says the provider ran out of tokens (quota, rate or usage limit, credits). */
export function isQuotaError(text: string | null | undefined): boolean {
  if (!text) return false;
  return QUOTA_PATTERNS.some((pattern) => pattern.test(text));
}
