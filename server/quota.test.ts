import { describe, expect, it } from "vitest";
import { isQuotaError } from "./quota";

describe("isQuotaError", () => {
  it.each([
    "429 Too Many Requests",
    "Error: rate limit exceeded, retry in 20s",
    "You've hit your usage limit. Try again at 3pm.",
    "Claude AI usage limit reached|1731000000",
    "You exceeded your current quota, please check your plan and billing details.",
    "insufficient_quota",
    "Your credit balance is too low to access the Anthropic API",
    "Insufficient credits",
    "The account is out of tokens",
    "RESOURCE_EXHAUSTED: quota for requests per minute",
    "You have reached your weekly limit",
    "You\u2019ve hit your session limit \u00b7 resets 3:45pm",
    "You've hit your weekly limit \u00b7 resets Mon 12:00am",
    "You've hit your limit \u00b7 resets 11:20pm (Europe/Paris)",
    "Usage limit reached",
    "This request would exceed your account's rate limit.",
    '{"type":"error","error":{"type":"rate_limit_error"}}',
    "You've hit your usage limit. Try again at Apr 30th, 2026 11:21 AM.",
    "Upgrade to Plus to continue using Codex, or try again later. You've hit your usage limit",
    "You've hit your usage limit; send a request to your admin or try again at 11:21 AM",
    "You exceeded your current quota",
  ])("recognizes %s", (text) => expect(isQuotaError(text)).toBe(true));

  it.each(["", null, undefined, "TypeError: cannot read properties of undefined", "network timeout", "tests failed: 3 of 10", "Tool permission denied", "connection reset by peer"])(
    "ignores %s",
    (text) => expect(isQuotaError(text)).toBe(false),
  );
});
