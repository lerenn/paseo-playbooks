import { describe, expect, it } from "vitest";
import { checkHeading, formatSeconds, lastLines, scriptActivity } from "./script-output";

const out = (over: Partial<Parameters<typeof scriptActivity>[0] & object> = {}) => ({ running: false, since: null, tail: "", checks: [], ...over });
const T = Date.parse("2026-11-12T10:00:30Z");

describe("script output helpers", () => {
  it("formats seconds", () => {
    expect(formatSeconds(45)).toBe("45 s");
    expect(formatSeconds(125)).toBe("2 min 5 s");
    expect(formatSeconds(3780)).toBe("1 h 3 min");
  });
  it("tells a running check from a wait", () => {
    expect(scriptActivity(out({ running: true, since: "2026-11-12T10:00:00Z" }), null, true, T)).toEqual({ kind: "running", text: "Running now · 30 s" });
    expect(scriptActivity(out(), "2026-11-12T10:01:00Z", true, T)).toEqual({ kind: "waiting", text: "Waiting · next check in ~30 s" });
    expect(scriptActivity(out(), null, true, T).kind).toBe("waiting");
    expect(scriptActivity(out(), "2026-11-12T10:01:00Z", false, T).kind).toBe("idle");
  });
  it("heads a check", () => {
    expect(checkHeading({ n: 3, startedAt: "", endedAt: "2026-11-12T10:00:00Z", outcome: "not_yet", exitCode: 75, tail: "" })).toMatch(/^Check 3 · not yet · exit 75 · /);
  });
  it("keeps the last lines", () => {
    expect(lastLines("a\nb\nc\n", 2)).toBe("b\nc");
    expect(lastLines("a", 2)).toBe("a");
  });
});
