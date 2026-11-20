import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { WardenFindingSchema, type Run, type WardenFinding, type WardenPrConfig } from "../shared/types";
import { z } from "zod";
import { isActive } from "../shared/types";
import type { Candidate } from "./warden";

/**
 * The warden's PR-level checks (ADR 2026-11-20-warden-pr-checks). Like the run checks they only detect: they propose an
 * action as text (for the Sidekick, which asks a human or acts through the tools it already has) and take none.
 * Every login, pattern and command comes from `warden.pr_checks`; nothing provider-specific is built in.
 */

const exec = promisify(execFile);

/** An open pull request, as much of it as the checks read. */
export interface OpenPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  headRefName: string;
  headSha: string;
  /** GitHub's `mergeable`: MERGEABLE, CONFLICTING or UNKNOWN. */
  mergeable: string;
  updatedAt: string;
  /** Logins (or team slugs) of the requested reviewers. */
  requested: string[];
  /** The latest review of each reviewer. */
  reviews: Array<{ author: string; state: string; at: string; body: string }>;
  /** Conversation comments. */
  comments: Array<{ author: string; at: string; body: string }>;
  /** When the head commit was committed (null when unknown). */
  headCommittedAt: string | null;
  /** Names of the checks and workflows reported on the head commit. */
  checks: string[];
  /** `owner/repo` of the PR (from its URL; "" when it has none) and the branch it targets. */
  repo: string;
  baseRefName: string;
}

const PR_URL = /https?:\/\/[^\s"/]+\/([\w.-]+\/[\w.-]+)\/pull\/\d+/g;
/** `owner/repo` of a pull request URL; "" when it is none. */
export const repoOfUrl = (url: string): string => new RegExp(PR_URL.source).exec(url)?.[1] ?? "";
/** The repositories whose PR URLs appear in a run's step state. */
export function reposOfRun(run: Run): string[] {
  return [...new Set([...JSON.stringify(run.steps).matchAll(PR_URL)].map((match) => match[1]!))];
}

const GH_FIELDS = "number,title,url,isDraft,headRefName,baseRefName,headRefOid,mergeable,updatedAt,reviewRequests,latestReviews,comments,commits,statusCheckRollup";

type Json = Record<string, unknown>;
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): Json[] => (Array.isArray(value) ? (value.filter((item) => item && typeof item === "object") as Json[]) : []);
const loginOf = (value: unknown): string => str((value as Json | null | undefined)?.login);

/** Reads the JSON of `gh pr list --json ...` into PRs; entries that lack a number or a head are skipped. */
export function parseGhPrs(json: string): OpenPr[] {
  const raw = JSON.parse(json) as unknown;
  return list(raw).flatMap((pr): OpenPr[] => {
    const number = typeof pr.number === "number" ? pr.number : null;
    const headSha = str(pr.headRefOid);
    if (number === null || !headSha) return [];
    const commits = list(pr.commits);
    return [
      {
        number,
        title: str(pr.title),
        url: str(pr.url),
        isDraft: pr.isDraft === true,
        headRefName: str(pr.headRefName),
        headSha,
        repo: repoOfUrl(str(pr.url)),
        baseRefName: str(pr.baseRefName),
        mergeable: str(pr.mergeable),
        updatedAt: str(pr.updatedAt),
        requested: list(pr.reviewRequests).map((entry) => str(entry.login) || str(entry.slug) || str(entry.name)).filter(Boolean),
        reviews: list(pr.latestReviews).map((entry) => ({ author: loginOf(entry.author), state: str(entry.state), at: str(entry.submittedAt), body: str(entry.body) })),
        comments: list(pr.comments).map((entry) => ({ author: loginOf(entry.author), at: str(entry.createdAt), body: str(entry.body) })),
        headCommittedAt: str(commits[commits.length - 1]?.committedDate) || null,
        checks: list(pr.statusCheckRollup).flatMap((entry) => [str(entry.name), str(entry.workflowName), str(entry.context)]).filter(Boolean),
      },
    ];
  });
}

/** The open PRs of `repo` (`owner/repo`), or of the repository of `dir` when it is null, through the `gh` CLI (it uses the user's own GitHub login); throws when `gh` fails. */
export async function listOpenPrs(dir: string, repo: string | null = null): Promise<OpenPr[]> {
  const { stdout } = await exec("gh", ["pr", "list", ...(repo ? ["--repo", repo] : []), "--state", "open", "--limit", "100", "--json", GH_FIELDS], { cwd: dir, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return parseGhPrs(stdout);
}

/** True when the PR's URL appears in the run's step state (not as the prefix of a longer number: .../7 is not .../70). */
function mentions(run: Run, url: string): boolean {
  return url !== "" && new RegExp(`${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`).test(JSON.stringify(run.steps));
}

/**
 * The run that owns a PR: the PR's URL is in its state, or its branch is the PR's head (and the run is not known to work in
 * another repository: its step state names PR URLs, none of this repo). The active one wins, else the latest.
 */
export function ownerOf(pr: OpenPr, runs: Run[]): Run | null {
  const inRepo = (run: Run) => {
    const repos = pr.repo ? reposOfRun(run) : [];
    return repos.length === 0 || repos.includes(pr.repo);
  };
  const mine = runs.filter((run) => mentions(run, pr.url) || ((run.worktree?.branch === pr.headRefName || run.branch === pr.headRefName) && inRepo(run)));
  return mine.sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

/** The checks the base branch's ruleset requires (`gh api repos/<repo>/rules/branches/<base>`); throws when the API call fails (no access, no such branch). */
export async function rulesetChecks(repo: string, base: string): Promise<string[]> {
  const { stdout } = await exec("gh", ["api", `repos/${repo}/rules/branches/${encodeURIComponent(base)}`], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  return parseRulesetChecks(stdout);
}

/** The required status check names in the JSON of a branch's rules (the `required_status_checks` rules' `context`s). */
export function parseRulesetChecks(json: string): string[] {
  const names = list(JSON.parse(json) as unknown)
    .filter((rule) => rule.type === "required_status_checks")
    .flatMap((rule) => list(((rule.parameters ?? {}) as Json).required_status_checks))
    .map((check) => str(check.context))
    .filter(Boolean);
  return [...new Set(names)];
}

const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(sha|branch|pr|name|workflow|repo)\}/g, (_, key: string) => values[key] ?? "");
const ms = (iso: string | null): number | null => {
  const time = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(time) ? null : time;
};

/** The reviewer's latest receipt (a comment or review whose body matches), as a time. */
export function lastReceipt(pr: OpenPr, bot: NonNullable<WardenPrConfig["reviewBot"]>): number | null {
  const pattern = new RegExp(bot.receipt);
  const times = [...pr.comments.map((c) => ({ ...c, at: c.at })), ...pr.reviews]
    .filter((entry) => entry.author === bot.author && pattern.test(entry.body))
    .map((entry) => ms(entry.at))
    .filter((time): time is number => time !== null);
  return times.length > 0 ? Math.max(...times) : null;
}

/** The candidates of every configured PR check over `prs`; `runs` are the project's runs (owners, running fix steps); `rulesets` the required checks read per `repo@base` (a missing key: none known). */
export function prCandidates(prs: OpenPr[], runs: Run[], config: WardenPrConfig, now: number, rulesets: Map<string, string[]> = new Map()): Candidate[] {
  const out: Candidate[] = [];
  for (const pr of prs) {
    const owner = ownerOf(pr, runs);
    const runId = owner?.id ?? null;
    const subject = config.repos && pr.repo ? `${pr.repo}#${pr.number}` : `#${pr.number}`;
    const make = (check: Candidate["check"], signature: string, detail: string, proposed: string) =>
      out.push({ check, subject, signature, detail: `PR ${subject} (${pr.url}) ${detail}`, action: "report", runId, pr: { number: pr.number, url: pr.url }, proposed });
    const fix = config.fixStep;
    const fixRunning = !!(owner && fix && owner.steps[fix]?.status === "running");
    const routeToFix = owner ? (fix ? `route run ${owner.id} to its \`${fix}\` step` : `ask run ${owner.id}'s manager to fix it`) : "no run owns it: start one or fix it by hand";

    if (config.noReviewer && !pr.isDraft) {
      const have = new Set([...pr.requested, ...pr.reviews.map((review) => review.author)]);
      if (!config.noReviewer.required.some((login) => have.has(login))) make("pr_no_reviewer", "none", `has no requested reviewer among the required ones (${config.noReviewer.required.join(", ")})`, `request a review from ${config.noReviewer.required.join(" or ")}`);
    }
    if (config.conflicting && pr.mergeable === "CONFLICTING") make("pr_conflicting", pr.headSha, "has merge conflicts with its base", `${routeToFix}, to resolve the conflicts`);
    if (config.reviewStale && config.reviewBot && !pr.isDraft) {
      const committed = ms(pr.headCommittedAt);
      const receipt = lastReceipt(pr, config.reviewBot);
      const stale = committed !== null && now - committed >= config.reviewStale.afterMs && (receipt === null || receipt < committed);
      if (stale) make("pr_review_stale", pr.headSha, `has no automated-review receipt for its head ${pr.headSha.slice(0, 8)} (pushed ${Math.round((now - committed) / 60_000)} min ago${receipt === null ? ", no receipt at all" : ""})`, config.reviewBot.retrigger ? `re-trigger the review: ${fill(config.reviewBot.retrigger, { sha: pr.headSha, branch: pr.headRefName, pr: String(pr.number), name: "" })}` : "re-trigger the automated review");
    }
    if (config.requiredChecks) {
      const seen = new Set(pr.checks);
      const required = [...new Set([...config.requiredChecks.names, ...(config.requiredChecks.fromRuleset ? (rulesets.get(rulesetKey(pr.repo, pr.baseRefName)) ?? []) : [])])];
      const missing = required.filter((name) => !seen.has(name));
      if (missing.length > 0 && !pr.isDraft) {
        const dispatch = config.requiredChecks.dispatch;
        const workflows = config.requiredChecks.workflows;
        const workflowOf = (name: string) => workflows[name] ?? name;
        const commands = dispatch ? missing.map((name) => fill(dispatch, { sha: pr.headSha, branch: pr.headRefName, pr: String(pr.number), name, workflow: workflowOf(name), repo: pr.repo })).join("; ") : null;
        const named = missing.map((name) => (workflows[name] ? `${name} (workflow ${workflows[name]})` : name)).join(", ");
        make("pr_required_checks", `${pr.headSha}:${missing.join(",")}`, `has no run of ${missing.join(", ")} on its head ${pr.headSha.slice(0, 8)}`, commands ? `dispatch on the exact head: ${commands}` : `dispatch ${named} on commit ${pr.headSha}`);
      }
    }
    if (config.reviewFindings && config.reviewBot && config.fixStep) {
      const bot = config.reviewBot;
      const marker = config.reviewFindings.marker;
      const open = marker ? markerOpen(pr, bot.author, marker) : changesRequested(pr, bot.author);
      if (open && !fixRunning) make("pr_review_findings", open.at, `has open automated-review findings (${marker ? `marker \`${open.value}\` in the review of ${open.at}` : `changes requested ${open.at}`}) and no \`${config.fixStep}\` step is running`, owner ? `route run ${owner.id} to its \`${config.fixStep}\` step` : "no run owns it: start one or address the findings by hand");
    }
    if (config.unowned && !owner) make("pr_unowned", "none", "is open and no run owns it", "start a run for it, or close it if it is abandoned");
    if (config.draftIdle && pr.isDraft) {
      const updated = ms(pr.updatedAt);
      if (updated !== null && now - updated >= config.draftIdle.afterMs) make("pr_draft_idle", "idle", `has been a draft with no activity for ${Math.floor((now - updated) / 86_400_000)} day(s)`, "mark it ready, resume the work, or close it");
    }
  }
  if (config.failedRuns) out.push(...failedRunCandidates(runs, config.failedRuns, now));
  return out;
}

/** The key of a base branch in the rulesets map. */
export const rulesetKey = (repo: string, base: string): string => `${repo}@${base}`;

/** The reviewer's latest review that requests changes (the original, marker-less behaviour). */
function changesRequested(pr: OpenPr, author: string): { at: string; value: string } | null {
  const review = pr.reviews.find((entry) => entry.author === author && entry.state === "CHANGES_REQUESTED");
  return review ? { at: review.at, value: "" } : null;
}

/** The reviewer's latest comment or review whose body matches the marker pattern, when its captured value is truthy. */
export function markerOpen(pr: OpenPr, author: string, marker: { pattern: string; truthy: string }): { at: string; value: string } | null {
  const pattern = new RegExp(marker.pattern);
  const truthy = new RegExp(marker.truthy);
  let latest: { at: string; time: number; value: string } | null = null;
  for (const entry of [...pr.comments, ...pr.reviews]) {
    if (entry.author !== author) continue;
    const value = pattern.exec(entry.body)?.[1];
    const time = ms(entry.at);
    if (value === undefined || time === null) continue;
    if (!latest || time >= latest.time) latest = { at: entry.at, time, value };
  }
  return latest && truthy.test(latest.value) ? { at: latest.at, value: latest.value } : null;
}

const trim = (text: string): string => (text.length > 400 ? `${text.slice(0, 400)}…` : text);

/** Runs of the configured playbooks that failed, or whose step failed, within the window: with the run, the failing step and the error. */
export function failedRunCandidates(runs: Run[], config: NonNullable<WardenPrConfig["failedRuns"]>, now: number): Candidate[] {
  const out: Candidate[] = [];
  for (const run of runs) {
    if (!config.playbooks.includes(run.playbook.id)) continue;
    const failedStep = Object.entries(run.steps).find(([, state]) => state.status === "failed");
    if (run.status !== "failed" && !failedStep) continue;
    const at = ms(failedStep?.[1].attempts.at(-1)?.endedAt ?? null) ?? ms(run.updatedAt);
    if (at === null || now - at > config.withinMs) continue;
    const attempt = failedStep?.[1].attempts.at(-1);
    const stepError = attempt?.report?.summary || attempt?.lastMessage || failedStep?.[1].summary || "";
    const error = trim(run.failure || stepError || "no error text recorded");
    const where = failedStep ? `step \`${failedStep[0]}\`` : "no single step";
    out.push({
      check: "run_failed",
      subject: run.id,
      signature: `${run.status}:${failedStep?.[0] ?? ""}:${attempt?.n ?? 0}`,
      detail: `run ${run.id} (${run.playbook.id}) ${run.status === "failed" ? "failed" : "has a failed step"}: ${where}: ${error}`,
      action: "report",
      runId: run.id,
      pr: null,
      proposed: `read run ${run.id} (get_run), then retry the step or restart the run if the cause is transient, or tell the human what broke`,
    });
  }
  return out;
}

const StoreSchema = z.record(z.string(), z.record(z.string(), WardenFindingSchema));

/** The PR findings of each project, in one file (they belong to no run); a missing or unreadable file reads as empty. */
export class WardenPrStore {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}

  private async load(): Promise<Record<string, Record<string, WardenFinding>>> {
    try {
      const parsed = StoreSchema.safeParse(JSON.parse(await readFile(this.file, "utf8")));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  async read(projectId: string): Promise<Record<string, WardenFinding>> {
    return (await this.load())[projectId] ?? {};
  }

  write(projectId: string, findings: Record<string, WardenFinding>): Promise<void> {
    const next = this.queue.then(async () => {
      const all = await this.load();
      all[projectId] = findings;
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      await writeFile(temp, JSON.stringify(all, null, 2));
      await rename(temp, this.file);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
