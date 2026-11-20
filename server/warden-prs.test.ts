import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Run, WardenPrConfig } from "../shared/types";
import { newRun } from "./engine";
import { loadPlaybooks, wardenPrSetting } from "./loader";
import { Runtime } from "./runtime";
import { RunStore } from "./store";
import { lastReceipt, ownerOf, parseGhPrs, prCandidates, type OpenPr } from "./warden-prs";

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

const NONE: WardenPrConfig = { fixStep: null, reviewBot: null, noReviewer: null, conflicting: null, reviewStale: null, requiredChecks: null, reviewFindings: null, unowned: null, draftIdle: null };
const BOT = { author: "review-bot", receipt: "^Reviewed", retrigger: "post `/review` on PR {pr}" };
const pr = (patch: Partial<OpenPr> = {}): OpenPr => ({ number: 7, title: "t", url: "https://example.test/pr/7", isDraft: false, headRefName: "feature", headSha: "abcdef123456", mergeable: "MERGEABLE", updatedAt: iso(0), requested: [], reviews: [], comments: [], headCommittedAt: iso(-60 * MIN), checks: [], ...patch });

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
    const config = { ...NONE, requiredChecks: { names: ["build", "lint"], dispatch: "run {name} --ref {branch} --sha {sha}" } };
    const [found] = prCandidates([pr({ checks: ["build"] })], [], config, T0);
    expect(found).toMatchObject({ check: "pr_required_checks" });
    expect(found!.proposed).toBe("dispatch on the exact head: run lint --ref feature --sha abcdef123456");
    expect(prCandidates([pr({ checks: ["lint", "build"] })], [], config, T0)).toHaveLength(0);
  });

  it("review_findings: changes requested by the bot and no fix step running", async () => {
    const dir = await project("warden: { enabled: true }\n");
    const run = await runOf(dir, "run_1", "feature");
    const config = { ...NONE, reviewBot: BOT, fixStep: "fix", reviewFindings: {} };
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
  async function setup(defaults: string, prs: OpenPr[]) {
    const dir = await project(defaults);
    const store = new RunStore(path.join(dir, "runs"));
    await store.init();
    await store.create(await runOf(dir, "run_1", "feature"));
    await writeFile(path.join(dir, "sidekick.json"), JSON.stringify({ p: { workspaceId: "ws-sk", agentId: "sk" } }));
    const sent: string[] = [];
    const ref = (agentId: string) => ({ refresh: async () => ({ agent: { id: agentId, status: "idle", provider: "claude", model: null, archivedAt: null, pendingPermissions: [] } }), send: async (text: string) => void sent.push(text), timeline: { refetch: async () => ({ entries: [] }) } });
    const list = vi.fn(async () => prs);
    const runtime = new Runtime(store, { debounceMs: 0, dataDir: dir, listOpenPrs: list } as never);
    runtimes.push(runtime);
    await runtime.attach({ agents: { ref, list: async () => ({ entries: [] }) } } as never);
    vi.spyOn(runtime as never, "projectOf" as never).mockResolvedValue({ projectId: "p", label: "p", root: dir } as never);
    return { runtime, sent, list, look: (minutes: number) => runtime.watchEvents(T0 + minutes * MIN) };
  }
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
