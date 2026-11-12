import { describe, expect, it } from "vitest";
import { sortPlaybooks, type PlaybookSort, type SortFacts } from "./sort";

const f = (id: string, title: string, updatedAt: string, createdAt: string, statusRank: number): SortFacts => ({ id, title, updatedAt, createdAt, statusRank });
const items = [
  f("b", "beta", "2026-01-03", "2026-01-01", 1),
  f("a", "Alpha", "2026-01-01", "2026-01-03", 2),
  f("c", "gamma", "2026-01-02", "2026-01-02", 0),
];
const order = (key: PlaybookSort, list = items) => sortPlaybooks(list, key, (item) => item).map((item) => item.id);

describe("sortPlaybooks", () => {
  it("name: A-Z, case-insensitive", () => expect(order("name")).toEqual(["a", "b", "c"]));
  it("activity: most recent update first", () => expect(order("activity")).toEqual(["b", "c", "a"]));
  it("status: lowest rank first", () => expect(order("status")).toEqual(["c", "b", "a"]));
  it("started: newest run first", () => expect(order("started")).toEqual(["a", "c", "b"]));
  it("ties fall back to the name, then the id", () => {
    const tied = [f("2", "Same", "x", "x", 0), f("1", "Same", "x", "x", 0), f("0", "Zed", "x", "x", 0), f("9", "Alpha", "x", "x", 0)];
    for (const key of ["name", "activity", "status", "started"] as const) expect(order(key, tied)).toEqual(["9", "1", "2", "0"]);
  });
  it("name and started ignore status and activity changes", () => {
    const changed = items.map((item) => ({ ...item, updatedAt: "2027", statusRank: 9 - item.statusRank }));
    expect(order("name", changed)).toEqual(order("name"));
    expect(order("started", changed)).toEqual(order("started"));
  });
  it("does not mutate its input", () => {
    const copy = [...items];
    order("name");
    expect(items).toEqual(copy);
  });
});
