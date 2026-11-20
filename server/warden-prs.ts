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
}

const GH_FIELDS = "number,title,url,isDraft,headRefName,headRefOid,mergeable,updatedAt,reviewRequests,latestReviews,comments,commits,statusCheckRollup";

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

/** The project's open PRs, through the `gh` CLI in `dir` (it uses the user's own GitHub login); throws when `gh` fails. */
export async function listOpenPrs(dir: string): Promise<OpenPr[]> {
  const { stdout } = await exec("gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", GH_FIELDS], { cwd: dir, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return parseGhPrs(stdout);
}

/** True when the PR's URL appears in the run's step state (not as the prefix of a longer number: .../7 is not .../70). */
function mentions(run: Run, url: string): boolean {
  return url !== "" && new RegExp(`${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`).test(JSON.stringify(run.steps));
}

/** The run that owns a PR: its branch is the PR's head, or the PR's URL is in its state. The active one wins, else the latest. */
export function ownerOf(pr: OpenPr, runs: Run[]): Run | null {
  const mine = runs.filter((run) => run.worktree?.branch === pr.headRefName || run.branch === pr.headRefName || mentions(run, pr.url));
  return mine.sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(sha|branch|pr|name)\}/g, (_, key: string) => values[key] ?? "");
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

/** The candidates of every configured PR check over `prs`; `runs` are the project's runs (owners, running fix steps). */
export function prCandidates(prs: OpenPr[], runs: Run[], config: WardenPrConfig, now: number): Candidate[] {
  const out: Candidate[] = [];
  for (const pr of prs) {
    const owner = ownerOf(pr, runs);
    const runId = owner?.id ?? null;
    const subject = `#${pr.number}`;
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
      const missing = config.requiredChecks.names.filter((name) => !seen.has(name));
      if (missing.length > 0 && !pr.isDraft) {
        const dispatch = config.requiredChecks.dispatch;
        const commands = dispatch ? missing.map((name) => fill(dispatch, { sha: pr.headSha, branch: pr.headRefName, pr: String(pr.number), name })).join("; ") : null;
        make("pr_required_checks", `${pr.headSha}:${missing.join(",")}`, `has no run of ${missing.join(", ")} on its head ${pr.headSha.slice(0, 8)}`, commands ? `dispatch on the exact head: ${commands}` : `dispatch ${missing.join(", ")} on commit ${pr.headSha}`);
      }
    }
    if (config.reviewFindings && config.reviewBot && config.fixStep) {
      const review = pr.reviews.find((entry) => entry.author === config.reviewBot!.author && entry.state === "CHANGES_REQUESTED");
      if (review && !fixRunning) make("pr_review_findings", `${review.at}`, `has open automated-review findings (changes requested ${review.at}) and no \`${config.fixStep}\` step is running`, owner ? `route run ${owner.id} to its \`${config.fixStep}\` step` : "no run owns it: start one or address the findings by hand");
    }
    if (config.unowned && !owner) make("pr_unowned", "none", "is open and no run owns it", "start a run for it, or close it if it is abandoned");
    if (config.draftIdle && pr.isDraft) {
      const updated = ms(pr.updatedAt);
      if (updated !== null && now - updated >= config.draftIdle.afterMs) make("pr_draft_idle", "idle", `has been a draft with no activity for ${Math.floor((now - updated) / 86_400_000)} day(s)`, "mark it ready, resume the work, or close it");
    }
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
