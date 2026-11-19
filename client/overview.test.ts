import { describe, expect, it } from "vitest";
import { needsYouRowKey } from "./overview-row-key";

describe("Needs You row identity", () => {
  it("keeps same-id gates from separate runs distinct when rows are flattened", () => {
    const flattened = [
      { run: { id: "run-a" }, gate: { id: "approval" } },
      { run: { id: "run-b" }, gate: { id: "approval" } },
    ];

    const keys = flattened.map(({ run, gate }) => needsYouRowKey(run.id, gate.id));

    expect(keys).toEqual(["run-a:approval", "run-b:approval"]);
    expect(new Set(keys).size).toBe(2);
  });
});
