import { describe, expect, it } from "vitest";
import type { QuotaBurnRate } from "../shared/quota-limitation";
import { BURN_OPEN_BY_DEFAULT, burnTable } from "./burn-rows";

const rate = (provider: string, window: string, burnRate: number | null, steps = 1, lowConfidence = true) => ({ provider, window, burnRate, steps, lowConfidence });
const item = (playbook: string, title: string, rates: QuotaBurnRate["rates"] = [], steps: QuotaBurnRate["steps"] = []): QuotaBurnRate => ({ playbook, title, resetAt: null, rates, steps });

describe("burn rate table", () => {
  it("is closed until the user opens it", () => {
    expect(BURN_OPEN_BY_DEFAULT).toBe(false);
  });

  it("has one sorted column per distinct provider and window, and a cell per column in each row", () => {
    const { columns, rows } = burnTable([
      item("b", "Release", [rate("claude", "weekly_model_fable", 0.4), rate("claude", "weekly", 0.5)]),
      item("a", "Build", [rate("claude", "weekly", 1.25, 7, false)]),
    ]);
    expect(columns.map((column) => column.key)).toEqual(["claude/weekly", "claude/weekly_model_fable"]);
    expect(rows.map((row) => row.cells)).toEqual([[{ burnRate: 1.25 }, null], [{ burnRate: 0.5 }, { burnRate: 0.4 }]]);
  });

  it("orders the playbooks by name, ignoring case", () => {
    const { rows } = burnTable([item("1", "pg-migrations train"), item("2", "Adopt PRs"), item("3", "Build lane")]);
    expect(rows.map((row) => row.title)).toEqual(["Adopt PRs", "Build lane", "pg-migrations train"]);
  });

  it("marks a playbook without history and gives no column for it", () => {
    const table = burnTable([item("a", "Build", [], [{ id: "x", durationMs: null, resetAt: null }])]);
    expect(table.columns).toEqual([]);
    expect(table.rows[0]).toMatchObject({ noHistory: true, cells: [], attempts: 0, confidence: null });
    expect(table.rows[0]!.steps).toEqual([{ id: "x", durationMs: null, resetAt: null }]);
    expect(burnTable([])).toEqual({ columns: [], rows: [] });
  });

  it("takes the most attempts and derives the confidence from the windows", () => {
    const { rows } = burnTable([
      item("a", "A", [rate("claude", "weekly", 1, 3), rate("claude", "daily", 1, 9)]),
      item("b", "B", [rate("claude", "weekly", 1, 6, false), rate("claude", "daily", 1, 2, true)]),
      item("c", "C", [rate("claude", "weekly", null, 12, false)]),
    ]);
    expect(rows.map((row) => [row.attempts, row.confidence])).toEqual([[9, "low"], [6, "medium"], [12, "high"]]);
    expect(rows[2]!.cells).toEqual([null, { burnRate: null }]);
  });
});
