import type { QuotaBurnRate } from "../shared/quota-limitation";

/** The Burn rate block is folded until the user opens it: a project may list dozens of playbooks. */
export const BURN_OPEN_BY_DEFAULT = false;

export type Confidence = "low" | "medium" | "high";

/** One column per provider and window found in the data, e.g. "claude weekly". */
export interface BurnColumn {
  key: string;
  provider: string;
  period: string;
}

export interface BurnCell {
  /** Percent points per active agent hour; null while no agent time is measured. */
  burnRate: number | null;
}

export interface BurnStepRow {
  id: string;
  durationMs: number | null;
  resetAt: string | null;
}

export interface BurnTableRow {
  playbook: string;
  title: string;
  resetAt: string | null;
  /** No learned rate for any provider window: the single "No history" cell. */
  noHistory: boolean;
  /** One entry per column of the table, null where this playbook has nothing for the column. */
  cells: Array<BurnCell | null>;
  /** The most finished attempts behind any of its windows (0 without history). */
  attempts: number;
  /** All windows low = low, none low = high, a mix = medium; null without history. */
  confidence: Confidence | null;
  steps: BurnStepRow[];
}

export interface BurnTable {
  columns: BurnColumn[];
  rows: BurnTableRow[];
}

const columnKey = (provider: string, period: string) => `${provider}/${period}`;

function confidenceOf(rates: QuotaBurnRate["rates"]): Confidence | null {
  if (rates.length === 0) return null;
  const low = rates.filter((rate) => rate.lowConfidence).length;
  return low === rates.length ? "low" : low === 0 ? "high" : "medium";
}

/**
 * The burn rate table of a project: the columns are the distinct provider and window pairs of the data (sorted), the rows the
 * playbooks by name (alphabetical, the title then the id breaking ties), and a playbook with no history gets a row marked as such.
 */
export function burnTable(items: ReadonlyArray<QuotaBurnRate>): BurnTable {
  const found = new Map<string, BurnColumn>();
  for (const item of items) {
    for (const rate of item.rates) {
      const key = columnKey(rate.provider, rate.window);
      if (!found.has(key)) found.set(key, { key, provider: rate.provider, period: rate.window });
    }
  }
  const columns = [...found.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.period.localeCompare(b.period));
  const rows = [...items]
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || a.playbook.localeCompare(b.playbook))
    .map((item): BurnTableRow => {
      const byKey = new Map(item.rates.map((rate) => [columnKey(rate.provider, rate.window), rate]));
      return {
        playbook: item.playbook,
        title: item.title,
        resetAt: item.resetAt,
        noHistory: item.rates.length === 0,
        cells: columns.map((column) => {
          const rate = byKey.get(column.key);
          return rate ? { burnRate: rate.burnRate } : null;
        }),
        attempts: item.rates.reduce((most, rate) => Math.max(most, rate.steps), 0),
        confidence: confidenceOf(item.rates),
        steps: item.steps.map((step) => ({ id: step.id, durationMs: step.durationMs, resetAt: step.resetAt })),
      };
    });
  return { columns, rows };
}
