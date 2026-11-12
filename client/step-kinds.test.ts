import { describe, expect, it } from "vitest";
import { StepSchema } from "../shared/types";
import { STEP_KINDS } from "./theme";

describe("step kind icons", () => {
  it("cover every step kind, with a word beside each icon", () => {
    const kinds = StepSchema.shape.kind.options;
    expect(Object.keys(STEP_KINDS).sort()).toEqual([...kinds].sort());
    for (const kind of kinds) expect(STEP_KINDS[kind]).toMatchObject({ icon: expect.stringMatching(/^[A-Z]/), label: expect.any(String) });
    expect(new Set(kinds.map((kind) => STEP_KINDS[kind].icon)).size).toBe(kinds.length);
  });
});
