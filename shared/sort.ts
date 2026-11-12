/** Order of the playbooks on the Playbooks screen (ADR 2026-11-12-playbook-sort). */
export type PlaybookSort = "name" | "activity" | "status" | "started";

export const PLAYBOOK_SORTS: ReadonlyArray<{ key: PlaybookSort; label: string; hint: string }> = [
  { key: "name", label: "Name (A-Z)", hint: "Alphabetical: the order never jumps" },
  { key: "activity", label: "Last activity", hint: "Most recent update first" },
  { key: "status", label: "Status", hint: "Waiting, working, failed, done, paused, seen" },
  { key: "started", label: "Start time", hint: "Playbook with the newest run first" },
];

export const DEFAULT_PLAYBOOK_SORT: PlaybookSort = "name";

/** What the comparators need of one playbook: its runs reduced to the facts that order it. */
export interface SortFacts {
  id: string;
  title: string;
  /** Most recent `updatedAt` among its runs. */
  updatedAt: string;
  /** Most recent `createdAt` among its runs. */
  createdAt: string;
  /** Lowest tone rank among its runs (0 = needs a look first). */
  statusRank: number;
}

/** Name, then id: two playbooks with one title keep a fixed order. */
const byName = (a: SortFacts, b: SortFacts) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);

/** The comparator of a sort. Ties fall back to the name, so every order is total and stable. */
export function playbookComparator(key: PlaybookSort): (a: SortFacts, b: SortFacts) => number {
  switch (key) {
    case "activity":
      return (a, b) => b.updatedAt.localeCompare(a.updatedAt) || byName(a, b);
    case "status":
      return (a, b) => a.statusRank - b.statusRank || b.updatedAt.localeCompare(a.updatedAt) || byName(a, b);
    case "started":
      return (a, b) => b.createdAt.localeCompare(a.createdAt) || byName(a, b);
    default:
      return byName;
  }
}

/** Items in the chosen order (a new array); `facts` reads an item's sort facts. */
export function sortPlaybooks<T>(items: readonly T[], key: PlaybookSort, facts: (item: T) => SortFacts): T[] {
  const compare = playbookComparator(key);
  return [...items].sort((a, b) => compare(facts(a), facts(b)));
}
