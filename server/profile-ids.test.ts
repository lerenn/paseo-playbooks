import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { findEntry } from "../shared/repos";
import type { PlaybookEntry } from "../shared/types";
import { worktreeBranch } from "./worktree";

const valid = (branch: string) => {
  try {
    execFileSync("git", ["check-ref-format", "--branch", branch], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

describe("branch names from playbook ids", () => {
  it.each(["lfradin:pr-to-prod", "default:x", "a b", "we?ird*[id]~^", "a..b", "-lead", "x.lock", "é:ü", "::", "a//b", "a@{b"])("%s gives a valid ref", (id) => {
    const branch = worktreeBranch(id, "78be66");
    expect(valid(branch)).toBe(true);
    expect(branch.endsWith("-78be66")).toBe(true);
  });
  it("sanitizes the namespace colon and stays unique by run id", () => {
    expect(worktreeBranch("lfradin:pr-to-prod", "78be66")).toBe("playbooks/lfradin-pr-to-prod-78be66");
    expect(worktreeBranch("lfradin:pr-to-prod", "aaaaaa")).not.toBe(worktreeBranch("lfradin:pr-to-prod", "bbbbbb"));
  });
});

describe("stored bare ids with an active profile", () => {
  const entries = [{ id: "lfradin:release_trains", repo: "lfradin" }, { id: "release", repo: "default" }] as unknown as PlaybookEntry[];
  it("a bare id resolves to the unique namespaced entry", () => {
    expect(findEntry(entries, "release_trains")).toEqual({ entry: entries[0] });
  });
  it("a qualified id resolves to a bare-id entry of the default repository", () => {
    expect(findEntry(entries, "default:release")).toEqual({ entry: entries[1] });
  });
  it("an ambiguous bare id is refused", () => {
    const both = [...entries, { id: "other:release", repo: "other" }] as unknown as PlaybookEntry[];
    expect("error" in findEntry(both, "release")).toBe(true);
  });
});
