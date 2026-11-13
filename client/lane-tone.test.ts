import { describe, expect, it } from "vitest";
import { laneTone } from "./lane-tone";

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
