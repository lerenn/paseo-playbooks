import { describe, expect, it } from "vitest";
import type { AdmissionStatus } from "../shared/types";
import { admissionLine, failureHeading, heldView } from "./admission";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const later = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();
const status = (over: Partial<AdmissionStatus> = {}): AdmissionStatus => ({ running: false, since: null, trigger: null, tail: "", nextCheckAt: null, checks: 2, lastCheckAt: ago(20), lastOutcome: "ok", error: null, warnings: [], ...over });

describe("heldView", () => {
  it("shows nothing for a job that may board", () => {
    expect(heldView({ station: "stg", since: ago(60), held: null, forced: false }, NOW)).toBeNull();
    expect(heldView({ station: "stg", since: ago(60), held: null, forced: true }, NOW)).toBeNull();
  });
  it("says Held with the reason, how long it waits and when it was checked", () => {
    expect(heldView({ station: "stg", since: ago(600), held: { reason: "QA not passed", checkedAt: ago(90) }, forced: false }, NOW)).toEqual({ badge: "Held", reason: "QA not passed", detail: "waiting 10 min · checked 1 min 30 s ago" });
  });
  it("says it was not checked yet before the first check", () => {
    expect(heldView({ station: "stg", since: ago(30), held: { reason: "waiting for its first admission check", checkedAt: null }, forced: false }, NOW)).toMatchObject({ badge: "Not checked yet", detail: "waiting 30 s" });
  });
});

describe("admissionLine", () => {
  it("says checking while a check runs", () => {
    expect(admissionLine(status({ running: true, since: ago(12) }), 2, NOW)).toMatchObject({ kind: "checking", text: "Admission: checking · 12 s" });
  });
  it("says when the next check is due, or that nothing waits", () => {
    expect(admissionLine(status({ nextCheckAt: later(30) }), 1, NOW)).toMatchObject({ kind: "waiting", text: "Admission: waiting, next check in ~30 s" });
    expect(admissionLine(status({ nextCheckAt: later(0) }), 1, NOW).text).toBe("Admission: next check starting");
    expect(admissionLine(undefined, 1, NOW).text).toBe("Admission: waiting for the next check");
    expect(admissionLine(status(), 0, NOW)).toMatchObject({ kind: "idle", text: "Admission: no jobs waiting" });
  });
  it("raises an alert with the last failure and its output", () => {
    const failed = status({ lastOutcome: "failed", nextCheckAt: later(300), error: { at: ago(120), message: "exit 3: no token", tail: "boom" } });
    const line = admissionLine(failed, 1, NOW);
    expect(line.kind).toBe("failed");
    expect(line.error).toEqual({ message: "exit 3: no token", tail: "boom", when: "2 min ago" });
    expect(failureHeading(failed, line.error!)).toBe("Last check failed 2 min ago (2 checks)");
  });
});
