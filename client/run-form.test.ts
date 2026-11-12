import { describe, expect, it } from "vitest";
import type { Playbook, PlaybookEntry } from "../shared/types";
import { inputErrors, runnablePlaybooks } from "./run-form";

const pb = (inputs: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: "p", title: "P", inputs, ...extra }) as unknown as Playbook;
const entry = (id: string, playbook: Playbook | null, errors: string[] = []) => ({ id, playbook, errors }) as unknown as PlaybookEntry;

describe("runnablePlaybooks", () => {
  it("keeps valid non-singleton playbooks", () => {
    const ok = pb({});
    const singleton = pb({}, { singleton: { branch: "main" } });
    expect(runnablePlaybooks([entry("a", ok), entry("b", null, ["bad"]), entry("c", singleton), entry("d", ok, ["warn"])])).toEqual([ok]);
  });
});

describe("inputErrors", () => {
  const playbook = pb({ request: { type: "string", required: true }, n: { type: "number" }, d: { type: "string", required: true, default: "x" }, b: { type: "boolean", required: true } });
  it("flags a missing required input and a bad number", () => {
    expect(inputErrors(playbook, { request: "  ", n: "abc", d: "", b: false })).toEqual({ request: "Required", n: "Must be a number" });
  });
  it("accepts valid values", () => {
    expect(inputErrors(playbook, { request: "go", n: "3", d: "", b: false })).toEqual({});
  });
});
