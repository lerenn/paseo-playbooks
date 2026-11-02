import { describe, expect, it } from "vitest";
import { splitError } from "../shared/errors";

const F = ".paseo/playbooks/pr.yaml";

describe("splitError", () => {
  it("separates the location from the message and drops the file", () => {
    expect(splitError(F, `${F}: steps "investigate", "implement": mode "bypassPermissions" on provider "claude" is not allowed by this daemon (allowed: default, acceptEdits); fix it`)).toEqual({
      where: 'steps "investigate", "implement"',
      message: 'mode "bypassPermissions" on provider "claude" is not allowed by this daemon (allowed: default, acceptEdits); fix it',
    });
    expect(splitError(F, `${F}: the manager and step "a": mode "x" is not allowed`).where).toBe('the manager and step "a"');
    expect(splitError(F, `${F}: step "review": on.changes_requested: goto unknown step "x"`)).toEqual({
      where: 'step "review": on.changes_requested',
      message: 'goto unknown step "x"',
    });
    expect(splitError(F, `${F}: step "b": input "plan" has no source: no earlier step outputs it`)).toEqual({
      where: 'step "b"',
      message: 'input "plan" has no source: no earlier step outputs it',
    });
    expect(splitError(F, `${F}: inputs.Bad: invalid name`).where).toBe("inputs.Bad");
  });

  it("keeps sentences without a location whole", () => {
    expect(splitError(F, `${F}: needs form a cycle: a → b → a`)).toEqual({ where: null, message: "needs form a cycle: a → b → a" });
    expect(splitError(F, `${F}: steps "a" and "b" can run at the same time and both may edit files`).where).toBeNull();
  });
});
