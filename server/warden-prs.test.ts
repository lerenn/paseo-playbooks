import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Run, WardenPrConfig } from "../shared/types";
import { newRun } from "./engine";
import { loadPlaybooks, wardenPrSetting } from "./loader";
import { Runtime } from "./runtime";
import { RunStore } from "./store";
import { lastReceipt, ownerOf, parseGhPrs, parseRulesetChecks, prCandidates, type OpenPr } from "./warden-prs";

const EXAMPLES = path.resolve(__dirname, "..", "examples");
const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.parse("2026-11-20T10:00:00Z");
const iso = (offset: number) => new Date(T0 + offset).toISOString();
const temps: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const NONE: WardenPrConfig = { fixStep: null, reviewBot: null, noReviewer: null, conflicting: null, reviewStale: null, requiredChecks: null, reviewFindings: null, unowned: null, draftIdle: null, repos: null, failedRuns: null };
const BOT = { author: "review-bot", receipt: "^Reviewed", retrigger: "post `/review` on PR {pr}" };
const pr = (patch: Partial<OpenPr> = {}): OpenPr => ({ number: 7, title: "t", url: "https://example.test/pr/7", isDraft: false, headRefName: "feature", headSha: "abcdef123456", mergeable: "MERGEABLE", updatedAt: iso(0), requested: [], reviews: [], comments: [], headCommittedAt: iso(-60 * MIN), checks: [], repo: "", baseRefName: "main", ...patch });

const PLAYBOOK = `
title: Release
steps:
  - id: fix
    role: { name: implementer }
`;
async function project(defaults: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "warden-pr-"));
  temps.push(dir);
  const root = path.join(dir, ".paseo/playbooks");
  await mkdir(path.join(root, "defaults"), { recursive: true });
  await cp(path.join(EXAMPLES, ".paseo/plugins/playbooks/roles"), path.join(root, "roles"), { recursive: true });
  await writeFile(path.join(root, "release.yaml"), PLAYBOOK);
  await writeFile(path.join(root, "defaults/main.yaml"), defaults);
  return dir;
}
async function runOf(dir: string, id: string, branch: string | null): Promise<Run> {
  const playbook = (await loadPlaybooks(dir)).entries.find((entry) => entry.id === "release")!.playbook!;
  const run = newRun({ id, playbook, workspaceId: "ws", workspaceDir: dir, projectId: "p", branch, managerAgentId: "m", inputs: {}, now: iso(-DAY) });
  return run;
}

describe("parseGhPrs", () => {
  it("reads the fields of gh pr list and skips entries without a head", () => {
    const json = JSON.stringify([
      { number: 3, title: "x", url: "u", isDraft: true, headRefName: "b", headRefOid: "sha", mergeable: "CONFLICTING", updatedAt: "t", reviewRequests: [{ login: "a" }, { slug: "team" }], latestReviews: [{ author: { login: "r" }, state: "APPROVED", submittedAt: "s", body: "ok" }], comments: [{ author: { login: "c" }, body: "hi", createdAt: "c1" }], commits: [{ committedDate: "d1" }, { committedDate: "d2" }], statusCheckRollup: [{ name: "build", workflowName: "CI" }] },
      { number: 4 },
    ]);
    const [one, ...rest] = parseGhPrs(json);
    expect(rest).toHaveLength(0);
    expect(one).toMatchObject({ number: 3, isDraft: true, headSha: "sha", requested: ["a", "team"], headCommittedAt: "d2", checks: ["build", "CI"] });
    expect(one!.reviews[0]).toEqual({ author: "r", state: "APPROVED", at: "s", body: "ok" });
  });
});

describe("PR checks: nothing unless configured", () => {
  it("an empty config finds nothing, whatever the PRs look like", () => {
    const bad = pr({ isDraft: false, mergeable: "CONFLICTING", requested: [], headCommittedAt: iso(-DAY) });
    expect(prCandidates([bad], [], NONE, T0)).toEqual([]);
  });
});

describe("PR checks", () => {
  it("no_reviewer: none of the required logins requested or reviewed (drafts excepted)", () => {
    const config = { ...NONE, noReviewer: { required: ["alice", "bob"] } };
    expect(prCandidates([pr()], [], config, T0)).toHaveLength(1);
    expect(prCandidates([pr({ requested: ["bob"] })], [], config, T0)).toHaveLength(0);
    expect(prCandidates([pr({ reviews: [{ author: "alice", state: "COMMENTED", at: iso(0), body: "" }] })], [], config, T0)).toHaveLength(0);
    expect(prCandidates([pr({ isDraft: true })], [], config, T0)).toHaveLength(0);
  });

  it("conflicting: proposes routing to the owning run's fix step", async () => {
    const dir = await project("warden: { enabled: true }\n");
    const run = await runOf(dir, "run_1", "feature");
    const [finding] = prCandidates([pr({ mergeable: "CONFLICTING" })], [run], { ...NONE, conflicting: {}, fixStep: "fix" }, T0);
    expect(finding).toMatchObject({ check: "pr_conflicting", runId: "run_1", subject: "#7", pr: { number: 7 } });
    expect(finding!.proposed).toContain("route run run_1 to its `fix` step");
    expect(prCandidates([pr({ mergeable: "UNKNOWN" })], [run], { ...NONE, conflicting: {} }, T0)).toHaveLength(0);
  });

  it("review_stale: a receipt older than the head for longer than `after`, with the retrigger text", () => {
    const config = { ...NONE, reviewBot: BOT, reviewStale: { afterMs: 30 * MIN } };
    const receipt = (at: string, author = "review-bot", body = "Reviewed abc") => ({ author, at, body });
    expect(lastReceipt(pr({ comments: [receipt(iso(-10 * MIN), "someone-else"), receipt(iso(-20 * MIN), "review-bot", "unrelated")] }), BOT)).toBeNull();
    const old = pr({ comments: [receipt(iso(-90 * MIN))] });
    const [found] = prCandidates([old], [], config, T0);
    expect(found).toMatchObject({ check: "pr_review_stale", signature: "abcdef123456" });
    expect(found!.proposed).toBe("re-trigger the review: post `/review` on PR 7");
    expect(prCandidates([pr({ comments: [receipt(iso(-30 * MIN))] })], [], config, T0)).toHaveLength(0); // receipt after head
    expect(prCandidates([pr({ headCommittedAt: iso(-10 * MIN) })], [], config, T0)).toHaveLength(0); // not yet N minutes
    expect(prCandidates([pr()], [], config, T0)).toHaveLength(1); // no receipt at all
  });

  it("required_checks: names missing on the head, with the dispatch command on the exact head", () => {
    const config = { ...NONE, requiredChecks: { names: ["build", "lint"], fromRuleset: false, workflows: {}, dispatch: "run {name} --ref {branch} --sha {sha}" } };
    const [found] = prCandidates([pr({ checks: ["build"] })], [], config, T0);
    expect(found).toMatchObject({ check: "pr_required_checks" });
    expect(found!.proposed).toBe("dispatch on the exact head: run lint --ref feature --sha abcdef123456");
    expect(prCandidates([pr({ checks: ["lint", "build"] })], [], config, T0)).toHaveLength(0);
  });

  it("review_findings: changes requested by the bot and no fix step running", async () => {
    const dir = await project("warden: { enabled: true }\n");
    const run = await runOf(dir, "run_1", "feature");
    const config = { ...NONE, reviewBot: BOT, fixStep: "fix", reviewFindings: { marker: null } };
    const review = { author: "review-bot", state: "CHANGES_REQUESTED", at: iso(-5 * MIN), body: "" };
    const [found] = prCandidates([pr({ reviews: [review] })], [run], config, T0);
    expect(found).toMatchObject({ check: "pr_review_findings", runId: "run_1" });
    run.steps.fix!.status = "running";
    expect(prCandidates([pr({ reviews: [review] })], [run], config, T0)).toHaveLength(0);
    expect(prCandidates([pr({ reviews: [{ ...review, state: "APPROVED" }] })], [], config, T0)).toHaveLength(0);
  });

  it("unowned: a PR no run owns by branch or by URL in its state; owned ones are not reported", async () => {
    const dir = await project("warden: { enabled: true }\n");
    const byBranch = await runOf(dir, "run_b", "feature");
    const byUrl = await runOf(dir, "run_u", null);
    byUrl.steps.fix!.outputs = { pr: "https://example.test/pr/9" } as never;
    const config = { ...NONE, unowned: {} };
    const prs = [pr(), pr({ number: 8, headRefName: "other", url: "https://example.test/pr/8" }), pr({ number: 9, headRefName: "third", url: "https://example.test/pr/9" })];
    const found = prCandidates(prs, [byBranch, byUrl], config, T0);
    expect(found.map((entry) => [entry.check, entry.subject, entry.runId])).toEqual([["pr_unowned", "#8", null]]);
    expect(ownerOf(prs[2]!, [byBranch, byUrl])?.id).toBe("run_u");
    expect(ownerOf(pr({ headRefName: "z", url: "https://example.test/pr/90" }), [byUrl])).toBeNull(); // pr/9 is not pr/90
  });

  it("draft_idle: a draft untouched for more than N days", () => {
    const config = { ...NONE, draftIdle: { afterMs: 7 * DAY } };
    expect(prCandidates([pr({ isDraft: true, updatedAt: iso(-8 * DAY) })], [], config, T0)).toHaveLength(1);
    expect(prCandidates([pr({ isDraft: true, updatedAt: iso(-6 * DAY) })], [], config, T0)).toHaveLength(0);
    expect(prCandidates([pr({ isDraft: false, updatedAt: iso(-30 * DAY) })], [], config, T0)).toHaveLength(0);
  });
});

  async function setup(defaults: string, prs: OpenPr[], extra: Record<string, unknown> = {}, mutate?: (run: Run) => void) {
    const dir = await project(defaults);
    const store = new RunStore(path.join(dir, "runs"));
    await store.init();
    const first = await runOf(dir, "run_1", "feature");
    mutate?.(first);
    await store.create(first);
    await writeFile(path.join(dir, "sidekick.json"), JSON.stringify({ p: { workspaceId: "ws-sk", agentId: "sk" } }));
    const sent: string[] = [];
    const ref = (agentId: string) => ({ refresh: async () => ({ agent: { id: agentId, status: "idle", provider: "claude", model: null, archivedAt: null, pendingPermissions: [] } }), send: async (text: string) => void sent.push(text), timeline: { refetch: async () => ({ entries: [] }) } });
    const list = vi.fn(async () => prs);
    const runtime = new Runtime(store, { debounceMs: 0, dataDir: dir, listOpenPrs: list, ...extra } as never);
    runtimes.push(runtime);
    await runtime.attach({ agents: { ref, list: async () => ({ entries: [] }) } } as never);
    vi.spyOn(runtime as never, "projectOf" as never).mockResolvedValue({ projectId: "p", label: "p", root: dir } as never);
    return { runtime, sent, list, look: (minutes: number) => runtime.watchEvents(T0 + minutes * MIN) };
  }

describe("several repositories", () => {
  const other = (patch: Partial<OpenPr> = {}) => pr({ repo: "org/other", url: "https://example.test/org/other/pull/7", ...patch });
  const CFG = { ...NONE, unowned: {}, repos: { names: ["org/a", "org/other"], fromRuns: false } };

  it("keys findings by repo, so equal PR numbers do not collide", () => {
    const out = prCandidates([pr({ repo: "org/a", url: "https://example.test/org/a/pull/7" }), other()], [], CFG, T0);
    expect(out.map((c) => c.subject)).toEqual(["org/a#7", "org/other#7"]);
  });

  it("matches the owner per repo: a branch name shared with a run working in another repo is not ownership", async () => {
    const dir = await project("{}\n");
    const run = await runOf(dir, "run_a", "feature");
    run.steps.fix!.summary = "opened https://example.test/org/a/pull/3";
    run.steps.fix!.outputs = { pr_url: "https://example.test/org/a/pull/3" };
    expect(ownerOf(pr({ repo: "org/a", url: "https://example.test/org/a/pull/9" }), [run])?.id).toBe("run_a");
    expect(ownerOf(other({ url: "https://example.test/org/other/pull/9" }), [run])).toBeNull();
    expect(ownerOf(other({ url: "https://example.test/org/a/pull/3".replace("org/a", "org/other") }), [run])).toBeNull();
    const bare = await runOf(dir, "run_b", "feature"); // no PR URL known: the branch alone decides
    expect(ownerOf(other(), [bare])?.id).toBe("run_b");
    const byUrl = await runOf(dir, "run_c", "nothing");
    byUrl.steps.fix!.outputs = { pr_url: "https://example.test/org/other/pull/7" };
    expect(ownerOf(other({ headRefName: "zzz" }), [byUrl])?.id).toBe("run_c");
  });

  it("scans each configured repo with --repo, adds the repos of the runs' PR URLs, and logs and skips one that fails", async () => {
    const calls: Array<string | null> = [];
    const list = async (_dir: string, repo: string | null) => {
      calls.push(repo);
      if (repo === "org/broken") throw new Error("HTTP 404");
      return [pr({ repo: repo ?? "", url: `https://example.test/${repo}/pull/7`, headRefName: `b-${repo}` })];
    };
    const s = await setup("warden: { enabled: true, interval: 5m, pr_checks: { unowned: {}, repos: { names: [org/a, org/broken], from_runs: true } } }\n", [], { listOpenPrs: list }, (run) => {
      run.steps.fix!.outputs = { pr_url: "https://example.test/org/from-run/pull/1" };
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await s.look(0);
    expect(calls.sort()).toEqual(["org/a", "org/broken", "org/from-run"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("skipped repository org/broken"));
    const text = s.sent.filter((t) => /warden found/.test(t)).join("\n");
    expect(text).toContain("PR org/a#7");
    expect(text).toContain("PR org/from-run#7");
  });

  it("without repos it reads the project root's repository, as before", async () => {
    const calls: Array<string | null> = [];
    const list = async (_dir: string, repo: string | null) => (calls.push(repo), []);
    const s = await setup("warden: { enabled: true, interval: 5m, pr_checks: { unowned: {} } }\n", [], { listOpenPrs: list });
    await s.look(0);
    expect(calls).toEqual([null]);
  });

  it("refuses an empty or malformed repos block", async () => {
    for (const [block, message] of [
      ["warden: { pr_checks: { unowned: {}, repos: {} } }", /set names, from_runs/],
      ["warden: { pr_checks: { unowned: {}, repos: { names: [nope] } } }", /not owner\/repo/],
    ] as const) expect(JSON.stringify(await loadPlaybooks(await project(`${block}\n`))), block).toMatch(message);
  });
});

describe("required checks from the base branch's ruleset", () => {
  const rulesets = new Map([["org/a@main", ["build", "lint"]]]);
  const base = { ...NONE, requiredChecks: { names: ["extra"], fromRuleset: true, workflows: { build: "ci.yml" }, dispatch: "go {workflow} {name} {repo} {sha}" } };
  const target = pr({ repo: "org/a", checks: ["lint", "extra"] });

  it("flags a ruleset check missing on the head, names its workflow in the dispatch, and unions static names", () => {
    const [found] = prCandidates([target], [], base, T0, rulesets);
    expect(found).toMatchObject({ check: "pr_required_checks" });
    expect(found!.detail).toContain("no run of build");
    expect(found!.proposed).toBe("dispatch on the exact head: go ci.yml build org/a abcdef123456");
    expect(prCandidates([pr({ repo: "org/a", checks: ["build", "lint", "extra"] })], [], base, T0, rulesets)).toEqual([]);
    expect(prCandidates([pr({ repo: "org/a", checks: ["lint"] })], [], base, T0, rulesets)[0]!.detail).toContain("extra, build");
  });

  it("names the mapped workflow in the text when there is no dispatch template", () => {
    const [found] = prCandidates([target], [], { ...base, requiredChecks: { ...base.requiredChecks, dispatch: null } }, T0, rulesets);
    expect(found!.proposed).toBe("dispatch build (workflow ci.yml) on commit abcdef123456");
  });

  it("ignores the ruleset when from_ruleset is off or it was not read", () => {
    expect(prCandidates([target], [], { ...base, requiredChecks: { ...base.requiredChecks, fromRuleset: false } }, T0, rulesets)).toEqual([]);
    expect(prCandidates([target], [], base, T0)).toEqual([]);
  });

  it("parses the rules API answer", () => {
    const json = JSON.stringify([{ type: "pull_request" }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "build" }, { context: "lint" }, { context: "build" }] } }]);
    expect(parseRulesetChecks(json)).toEqual(["build", "lint"]);
    expect(parseRulesetChecks("[]")).toEqual([]);
  });

  it("an unreadable ruleset is logged once and skipped: the static names still apply, no spam", async () => {
    const read = vi.fn(async () => {
      throw new Error("HTTP 403: Resource not accessible");
    });
    const prs = [pr({ repo: "org/a", url: "https://example.test/org/a/pull/7", checks: [] }), pr({ number: 8, repo: "org/a", url: "https://example.test/org/a/pull/8", headRefName: "b", checks: [] })];
    const s = await setup("warden: { enabled: true, interval: 5m, pr_checks: { required_checks: { names: [static], from_ruleset: true } } }\n", prs, { rulesetChecks: read });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await s.look(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("org/a@main not read"));
    expect(s.sent.join("\n")).toContain("no run of static");
    expect(s.sent.join("\n")).not.toContain("build");
  });

  it("refuses required_checks with nothing to require", async () => {
    expect(JSON.stringify(await loadPlaybooks(await project("warden: { pr_checks: { required_checks: {} } }\n")))).toMatch(/set names, from_ruleset/);
  });
});

describe("review findings from a marker", () => {
  const marker = { pattern: "findings: (\\w+)", truthy: "^(true|[1-9]\\d*)$" };
  const config = { ...NONE, reviewBot: BOT, fixStep: "fix", reviewFindings: { marker } };
  const note = (at: number, body: string, author = BOT.author) => ({ author, at: iso(at), body });

  it("reports when the bot's latest marked comment is truthy, and not when a later one clears it", () => {
    const open = pr({ comments: [note(-30 * MIN, "<!-- findings: 3 -->")] });
    const [found] = prCandidates([open], [], config, T0);
    expect(found).toMatchObject({ check: "pr_review_findings", signature: iso(-30 * MIN) });
    expect(found!.detail).toContain("marker `3`");
    expect(prCandidates([pr({ comments: [note(-30 * MIN, "findings: 3"), note(-10 * MIN, "findings: 0")] })], [], config, T0)).toEqual([]);
    expect(prCandidates([pr({ comments: [note(-30 * MIN, "findings: 0"), note(-10 * MIN, "findings: 2")] })], [], config, T0)).toHaveLength(1);
  });

  it("looks only at the bot's own text and reads reviews as well as comments", () => {
    expect(prCandidates([pr({ comments: [note(-5 * MIN, "findings: 4", "someone")] })], [], config, T0)).toEqual([]);
    expect(prCandidates([pr({ reviews: [{ author: BOT.author, state: "COMMENTED", at: iso(-5 * MIN), body: "findings: true" }] })], [], config, T0)).toHaveLength(1);
  });

  it("is not CHANGES_REQUESTED: such a review without the marker is ignored, and without a marker config it still counts", () => {
    const requested = pr({ reviews: [{ author: BOT.author, state: "CHANGES_REQUESTED", at: iso(-5 * MIN), body: "no marker here" }] });
    expect(prCandidates([requested], [], config, T0)).toEqual([]);
    expect(prCandidates([requested], [], { ...config, reviewFindings: { marker: null } }, T0)).toHaveLength(1);
  });

  it("stays quiet while a fix step runs", async () => {
    const dir = await project("{}\n");
    const run = await runOf(dir, "run_1", "feature");
    run.steps.fix!.status = "running";
    expect(prCandidates([pr({ comments: [note(-5 * MIN, "findings: 2")] })], [run], config, T0)).toEqual([]);
  });

  it("loads: truthy defaults, and a pattern needs one capture group", async () => {
    const ok = await wardenPrSetting(await project("warden: { enabled: true, pr_checks: { fix_step: fix, review_bot: { author: b, receipt: x }, review_findings: { marker: { pattern: 'n=(\\d+)' } } } }\n"));
    expect(ok?.checks.reviewFindings?.marker?.truthy).toMatch(/true\|yes/);
    expect(JSON.stringify(await loadPlaybooks(await project("warden: { pr_checks: { fix_step: fix, review_bot: { author: b, receipt: x }, review_findings: { marker: { pattern: 'n=\\d+' } } } }\n")))).toMatch(/needs one capture group/);
  });
});

describe("failed hand-off or release runs", () => {
  const config = { ...NONE, failedRuns: { playbooks: ["release"], withinMs: DAY } };
  const failed = async (patch: (run: Run) => void) => {
    const run = await runOf(await project("{}\n"), "run_f", "x");
    run.updatedAt = iso(-10 * MIN);
    patch(run);
    return run;
  };

  it("proposes a failed run of a configured playbook with the run id, the failing step and the error", async () => {
    const run = await failed((r) => {
      r.status = "failed";
      r.failure = "step fix failed: tests did not pass";
      r.steps.fix!.status = "failed";
    });
    const [found] = prCandidates([], [run], config, T0);
    expect(found).toMatchObject({ check: "run_failed", subject: "run_f", runId: "run_f", pr: null });
    expect(found!.detail).toBe("run run_f (release) failed: step `fix`: step fix failed: tests did not pass");
    expect(found!.proposed).toContain("get_run");
  });

  it("also catches a failed step of a run that has not ended, with the step's own error", async () => {
    const run = await failed((r) => {
      r.steps.fix!.status = "failed";
      r.steps.fix!.summary = "the script exited 2";
    });
    expect(prCandidates([], [run], config, T0)[0]!.detail).toBe("run run_f (release) has a failed step: step `fix`: the script exited 2");
  });

  it("ignores other playbooks, healthy runs and failures older than the window", async () => {
    const failing = (r: Run) => {
      r.status = "failed";
      r.failure = "boom";
    };
    expect(prCandidates([], [await failed(failing)], { ...NONE, failedRuns: { playbooks: ["other"], withinMs: DAY } }, T0)).toEqual([]);
    expect(prCandidates([], [await failed(() => undefined)], config, T0)).toEqual([]);
    expect(prCandidates([], [await failed(failing)], config, T0 + 2 * DAY)).toEqual([]);
  });

  it("is sent once by the pass, without any gh call when it is the only check", async () => {
    const s = await setup("warden: { enabled: true, interval: 5m, pr_checks: { failed_run: { playbooks: [release] } } }\n", [], {}, (run) => {
      run.status = "failed";
      run.failure = "boom";
      run.updatedAt = iso(-MIN);
    });
    await s.look(0);
    await s.look(10);
    expect(s.list).not.toHaveBeenCalled();
    const sent = s.sent.filter((t) => /warden found/.test(t));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("run run_1, run_failed: run run_1 (release) failed: no single step: boom");
  });

  it("loads with a default window of 24h and refuses a bad one", async () => {
    expect((await wardenPrSetting(await project("warden: { enabled: true, pr_checks: { failed_run: { playbooks: [release] } } }\n")))?.checks.failedRuns).toEqual({ playbooks: ["release"], withinMs: DAY });
    expect(JSON.stringify(await loadPlaybooks(await project("warden: { pr_checks: { failed_run: { playbooks: [release], within: soon } } }\n")))).toMatch(/expected a duration/);
  });
});

describe("warden.pr_checks config", () => {
  it("is read from defaults only when the warden is on and a check is set", async () => {
    expect(await wardenPrSetting(await project("warden: { enabled: true }\n"))).toBeNull();
    expect(await wardenPrSetting(await project("warden: { pr_checks: { unowned: {} } }\n"))).toBeNull();
    const on = await wardenPrSetting(await project("warden: { enabled: true, pr_checks: { unowned: {}, draft_idle: { after: 7d }, review_bot: { author: b, receipt: x }, review_stale: { after: 20m } } }\n"));
    expect(on?.checks).toMatchObject({ unowned: {}, draftIdle: { afterMs: 7 * DAY }, reviewStale: { afterMs: 20 * MIN }, noReviewer: null });
  });

  it("refuses bad values and misplaced use", async () => {
    for (const [block, message] of [
      ["warden: { pr_checks: { review_stale: { after: 5m } } }", /need review_bot/],
      ["warden: { pr_checks: { review_bot: { author: b, receipt: '(' }, review_stale: { after: 5m } } }", /not a valid regular expression/],
      ["warden: { pr_checks: { review_bot: { author: b, receipt: x }, review_findings: {} } }", /needs fix_step/],
      ["warden: { pr_checks: { draft_idle: { after: soon } } }", /expected a duration/],
      ["warden: { pr_checks: { nope: {} } }", /nope|Unrecognized/],
    ] as const) {
      const dir = await project(`${block}\n`);
      const loaded = await loadPlaybooks(dir);
      const text = JSON.stringify(loaded);
      expect(text, block).toMatch(message);
    }
    const dir = await project("{}\n");
    await writeFile(path.join(dir, ".paseo/playbooks/release.yaml"), `title: Release\nwarden: { pr_checks: { unowned: {} } }\nsteps:\n  - id: fix\n    role: { name: implementer }\n`);
    const entry = (await loadPlaybooks(dir)).entries.find((candidate) => candidate.id === "release")!;
    expect(entry.errors.join("\n")).toMatch(/only applies in defaults\/main.yaml/);
  });
});

describe("the warden PR pass", () => {
  const ON = "warden: { enabled: true, interval: 5m, cooldown: 1h, pr_checks: { unowned: {}, conflicting: {}, fix_step: fix } }\n";

  it("does nothing without configuration: no gh call, no message", async () => {
    for (const defaults of ["{}\n", "warden: { enabled: true }\n", "warden: { pr_checks: { unowned: {} } }\n"]) {
      const s = await setup(defaults, [pr({ headRefName: "x", url: "https://example.test/pr/5" })]);
      await s.look(0);
      await s.look(60);
      expect(s.list).not.toHaveBeenCalled();
      expect(s.sent.filter((text) => /warden/i.test(text))).toHaveLength(0);
    }
  });

  it("sends ONE summary with run, PR, cause and proposed action; repeats nothing until the cooldown or a change", async () => {
    const prs = [pr({ mergeable: "CONFLICTING" }), pr({ number: 8, headRefName: "other", url: "https://example.test/pr/8" })];
    const s = await setup(ON, prs);
    await s.look(0);
    const warden = () => s.sent.filter((text) => /warden found/.test(text));
    expect(warden()).toHaveLength(1);
    expect(warden()[0]).toContain("run run_1, pr_conflicting: PR #7 (https://example.test/pr/7) has merge conflicts");
    expect(warden()[0]).toContain("Proposed: route run run_1 to its `fix` step");
    expect(warden()[0]).toContain("no run, pr_unowned: PR #8");
    await s.look(10); // unchanged, within the cooldown
    expect(warden()).toHaveLength(1);
    prs[0] = pr({ mergeable: "CONFLICTING", headSha: "new-head-sha" }); // a new head is a new finding
    await s.look(20);
    expect(warden()).toHaveLength(2);
    expect(warden()[1]).toContain("PR #7");
    expect(warden()[1]).not.toContain("PR #8");
    await s.look(90); // cooldown passed: still true, reported again
    expect(warden()).toHaveLength(3);
  });

  it("survives a restart without repeating (findings are in a file)", async () => {
    const prs = [pr({ headRefName: "x", url: "https://example.test/pr/5" })];
    const s = await setup("warden: { enabled: true, interval: 5m, pr_checks: { unowned: {} } }\n", prs);
    await s.look(0);
    expect(s.sent.filter((text) => /warden found/.test(text))).toHaveLength(1);
    (s.runtime as unknown as { wardenPrStore: unknown }).wardenPrStore = null;
    (s.runtime as unknown as { wardenPrSeen: Map<string, number> }).wardenPrSeen.clear();
    await s.look(10);
    expect(s.sent.filter((text) => /warden found/.test(text))).toHaveLength(1);
  });

  it("a failing gh is logged and does not stop the pass", async () => {
    const s = await setup(ON, []);
    s.list.mockRejectedValue(new Error("gh: not logged in"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await s.look(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("warden PR pass"), expect.stringContaining("not logged in"));
    expect(s.sent.filter((text) => /warden/i.test(text))).toHaveLength(0);
  });
});
