import type { Run, WardenAction, WardenCheck, WardenFinding } from "../shared/types";
import { slowDetail, type SlowInfo } from "../shared/slow";
import { gateListing, gateHolder } from "./overseer";

/**
 * The warden's rules (ADR 2026-11-18-warden). Detection only: no I/O of its own (the runtime passes in what needs the
 * daemon or git), no LLM, no message to an agent. The runtime applies them once per event scan; nothing runs while
 * `warden.enabled` is false.
 */

/** How often the warden looks at what is due (each run follows its own `interval`). */
export const WARDEN_CHECK_MS = 30_000;
/** Runs looked at in one pass: the rest wait for the next (the longest-waiting first). */
export const WARDEN_MAX_RUNS_PER_PASS = 25;

export type Act = Exclude<WardenAction, "none">;

/** A condition a check found: its identity is `check` + `subject`; `signature` changing makes it a new finding. */
export interface Candidate {
  check: WardenCheck;
  subject: string | null;
  signature: string;
  detail: string;
  action: Act;
}

/** What the runtime reads for the checks that need the daemon or git. */
export interface WardenIo {
  /** The commit origin/<base> is at now (fetched); null when the run is not isolated or origin cannot be read. */
  originSha(run: Run): Promise<string | null>;
  /** The run's manager: `running`, `idle`, or `gone` (archived, closed, errored, not found); null when it has none. */
  manager(run: Run): Promise<"running" | "idle" | "gone" | null>;
}

export const findingKey = (check: WardenCheck, subject: string | null): string => `${check}:${subject ?? ""}`;

/** The step runs slower than their baseline, as the slow-step warning computes them (only steps still running). */
export function slowCandidates(run: Run, slow: Record<string, SlowInfo>, action: Act): Candidate[] {
  return Object.entries(slow)
    .filter(([id]) => run.steps[id]?.status === "running")
    .map(([id, info]) => ({ check: "slow" as const, subject: id, signature: `${id}@${run.steps[id]?.attempts[0]?.startedAt ?? ""}`, detail: `step ${id} has run ${slowDetail(info)}`, action }));
}

/** Gates open for `afterMs` or more (the same age as gate.stale: gateListing's). */
export function gateOpenCandidates(run: Run, afterMs: number, now: number, action: Act): Candidate[] {
  return run.gates
    .filter((gate) => gate.status === "pending")
    .flatMap((gate) => {
      const age = gateListing(run, gate, now).ageMinutes;
      return age !== null && age * 60_000 >= afterMs ? [{ check: "gate_open" as const, subject: gate.id, signature: gate.id, detail: `gate ${gate.id} (${gate.kind}) of step ${gate.stepId} has been open ${age} min, held by ${gateHolder(gate).heldBy}`, action }] : [];
    });
}

/** Goto edges that fired more than `above` times. */
export function loopCandidates(run: Run, above: number, action: Act): Candidate[] {
  return Object.entries(run.loops)
    .filter(([, count]) => count > above)
    .map(([edge, count]) => ({ check: "loops" as const, subject: edge, signature: edge, detail: `edge ${edge} fired ${count} times (limit ${above})`, action }));
}

/** A run pinned to a definition other than origin's current one: read from the workspace checkout, or at an older commit. */
export function staleDefinitionCandidate(run: Run, originSha: string | null, action: Act): Candidate[] {
  const definition = run.definition;
  if (!definition || !originSha) return [];
  const stale = definition.source === "workspace" || (definition.sha !== null && definition.sha !== originSha);
  if (!stale) return [];
  const pinned = definition.source === "workspace" ? "the workspace checkout" : `${definition.ref ?? "origin"}@${(definition.sha ?? "").slice(0, 8)}`;
  return [{ check: "stale_definition", subject: null, signature: `${definition.source}@${originSha}`, detail: `the definition is pinned to ${pinned}, origin is at ${originSha.slice(0, 8)}`, action }];
}

/** Open gates only the manager can decide, while the manager is idle; any open gate while it is gone. */
export function managerBlockedCandidates(run: Run, manager: "running" | "idle" | "gone" | null, action: Act): Candidate[] {
  if (manager === null || manager === "running") return [];
  return run.gates
    .filter((gate) => gate.status === "pending")
    .filter((gate) => manager === "gone" || (gateHolder(gate).by === "manager" && gate.escalated === null))
    .map((gate) => ({ check: "manager_blocked" as const, subject: gate.id, signature: `${gate.id}:${manager}`, detail: `${manager === "gone" ? "the manager is gone" : "the manager is idle"} while gate ${gate.id} (${gate.kind}) of step ${gate.stepId} is open`, action }));
}

/** What the pass changes: the findings to keep, and the ones to report now (new, changed, or still true after the cooldown). */
export function diffFindings(
  existing: Record<string, WardenFinding>,
  candidates: Candidate[],
  nowIso: string,
  cooldownMs: number,
): { next: Record<string, WardenFinding>; report: Array<{ finding: WardenFinding; fresh: boolean; candidate: Candidate }> } {
  const next: Record<string, WardenFinding> = {};
  const report: Array<{ finding: WardenFinding; fresh: boolean; candidate: Candidate }> = [];
  const now = Date.parse(nowIso);
  for (const candidate of candidates) {
    const key = findingKey(candidate.check, candidate.subject);
    if (next[key]) continue;
    const old = existing[key];
    const changed = !old || old.signature !== candidate.signature;
    const due = changed || now - Date.parse(old.reportedAt) >= cooldownMs;
    const finding: WardenFinding = { check: candidate.check, subject: candidate.subject, signature: candidate.signature, detail: candidate.detail, since: changed ? nowIso : old.since, reportedAt: due ? nowIso : old.reportedAt, acted: changed ? null : old.acted };
    next[key] = finding;
    if (due) report.push({ finding, fresh: changed, candidate });
  }
  return { next, report };
}

/** The one message a Sidekick gets per pass: only what is new or changed, per run. */
export function wardenSummary(items: Array<{ runId: string; playbook: string; runName: string | null; findings: WardenFinding[] }>): string {
  const lines = items.flatMap((item) => item.findings.map((finding) => `- ${item.runId} (${item.playbook}${item.runName ? `, ${item.runName}` : ""}) ${finding.check}: ${finding.detail}`));
  return `[playbooks] The warden found ${lines.length} thing${lines.length === 1 ? "" : "s"} that may need action:\n${lines.join("\n")}\nRead each with get_run (its \`warden\` field) before acting; the warden will not repeat a finding until its cooldown passes or it changes.`;
}
