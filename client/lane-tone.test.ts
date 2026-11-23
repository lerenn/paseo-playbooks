import { describe, expect, it } from "vitest";
import { laneTone } from "./lane-tone";
import { PAUSED_DARK, PAUSED_LIGHT, pausedColor, TONE_RANK } from "./tone-color";

describe("fan-out child tone", () => {
  it("keeps a completed child green whether its run is live, archived or unknown", () => {
    expect(laneTone("completed", null)).toBe("done");
    expect(laneTone("completed", "seen")).toBe("done");
    expect(laneTone("completed", "running")).toBe("done");
  });

  it("shows failed, canceled and not started children red without a run", () => {
    expect(laneTone("failed", null)).toBe("failed");
    expect(laneTone("canceled", null)).toBe("failed");
    expect(laneTone("not_started", null)).toBe("failed");
  });

  it("spins a running child, refined by its live run", () => {
    expect(laneTone("running", null)).toBe("running");
    expect(laneTone("starting", null)).toBe("running");
    expect(laneTone("running", "waiting")).toBe("waiting");
  });

  it("leaves a queued child hollow until it has a run", () => {
    expect(laneTone("pending", null)).toBeNull();
    expect(laneTone("pending", "waiting")).toBe("waiting");
  });
});

describe("paused tone", () => {
  it("is violet, a different one per surface, never the grey of a seen run", () => {
    expect(pausedColor("#1a1a19")).toBe(PAUSED_DARK);
    expect(pausedColor("#fcfcfb")).toBe(PAUSED_LIGHT);
  });

  it("ranks right after running, before the ended runs", () => {
    expect(TONE_RANK.running).toBeLessThan(TONE_RANK.paused);
    expect(TONE_RANK.paused).toBeLessThan(TONE_RANK.failed);
    expect(TONE_RANK.paused).toBeLessThan(TONE_RANK.done);
    expect(TONE_RANK.paused).toBeLessThan(TONE_RANK.seen);
  });
});
