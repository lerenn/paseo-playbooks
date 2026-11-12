import { openExternalUrl, usePaseo, useRpc, type PluginIconProps, type PluginScreenProps, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView, SidebarRow, useToast } from "@getpaseo/plugin/client/ui";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, Pressable, Text, View } from "react-native";
import { archiveRunRpc, listPlaybooks, markRunSeenRpc } from "../shared/contracts";
import { gateText } from "../shared/gates";
import { isActive, isPaused, isPipeline, isTerminal, type Gate, type RunSummary, type StepSummary } from "../shared/types";
import { AnalyticsView } from "./analytics";
import { useReduceMotion } from "./graph";
import { LABEL_WIDTH, labelLayout, ROW_HEIGHT } from "./layout";
import { useOverview, type OverviewStore } from "./overview-store";
import { GETTING_STARTED_URL } from "./panel";
import { PreReleaseFlag } from "./pre-release";
import { ProfilesView } from "./profiles";
import { SidekickPane } from "./sidekick/pane";
import { sidekickUi, useSidekickUi } from "./sidekick/ui-state";
import { defaultProject, projectsOf, runButtonState, runnablePlaybooks } from "./run-form";
import { Button, GateActions } from "./sheet";
import { OverviewRunForm, RunPlaybookButton } from "./start-form";
import { openJobsLabel, Stations, trainName } from "./stations";
import { stepShortTitle, stepTitle, stepTitleOf, withAlpha, type Theme } from "./theme";

/** Id of the Playbooks screen, opened from the sidebar row. */
export const SCREEN_ID = "playbooks";

/** The screen's store, for the rows that refresh it after an action (deciding a gate, marking a run seen). */
const StoreContext = createContext<OverviewStore | null>(null);

function useStoreRefresh(): () => void {
  const store = useContext(StoreContext);
  return () => store?.refresh();
}

// ---------------------------------------------------------------- sidebar row

/**
 * "Playbooks" in the sidebar, with the number of gates waiting for a human as an accent badge on
 * its icon. Not in `trailing`: the host renders that slot beside the row's pressable, outside its
 * focus ring and hover.
 */
export function PlaybooksSidebarItem(props: PluginSidebarItemProps & { store: OverviewStore }) {
  const { theme } = props;
  const { count } = useOverview(props.store);
  const icon = useMemo(() => (count > 0 ? badgedIcon(theme, count) : "Workflow"), [theme, count]);
  return (
    <SidebarRow
      icon={icon}
      label="Playbooks"
      active={props.currentScreen?.screenId === SCREEN_ID}
      onPress={() => props.openScreen({ screenId: SCREEN_ID })}
    />
  );
}

/** The Playbooks icon with the waiting count in an accent bubble on its corner. */
function badgedIcon(theme: Theme, count: number) {
  return function BadgedIcon(props: PluginIconProps) {
    const bubble = Math.max(12, Math.round(props.size * 0.8));
    return (
      <View style={{ width: props.size, height: props.size }}>
        <Icon name="Workflow" size={props.size} color={props.color} />
        <View
          accessibilityLabel={`${count} ${count === 1 ? "needs" : "need"} you`}
          style={{
            position: "absolute",
            top: -bubble / 2,
            right: -bubble / 2,
            minWidth: bubble,
            height: bubble,
            paddingHorizontal: 2,
            borderRadius: bubble / 2,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.colors.accent,
            borderWidth: 1,
            borderColor: theme.colors.surface0,
          }}
        >
          <Text style={{ color: theme.colors.accentForeground, fontSize: Math.round(bubble * 0.62), lineHeight: bubble - 2, fontWeight: "700" }}>
            {count > 99 ? "99+" : count}
          </Text>
        </View>
      </View>
    );
  };
}

function Badge(props: { theme: Theme; count: number }) {
  const { theme } = props;
  return (
    <View
      style={{ minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.accent }}
    >
      <Text style={{ color: theme.colors.accentForeground, fontSize: 11, fontWeight: "700" }}>{props.count > 99 ? "99+" : props.count}</Text>
    </View>
  );
}

// ---------------------------------------------------------------- data

interface WorkspaceInfo {
  id: string;
  label: string;
  projectId: string;
  projectLabel: string;
}

/** The host's workspaces, kept current by an owned list subscription. */
function useWorkspaces(): WorkspaceInfo[] {
  const paseo = usePaseo();
  const [workspaces, setWorkspaces] = useState<Map<string, WorkspaceInfo>>(new Map());
  useEffect(() => {
    const lifetime = new AbortController();
    const info = (workspace: { id: string; title?: string | null; name: string; projectId: string; projectDisplayName: string }): WorkspaceInfo => ({
      id: workspace.id,
      label: workspace.title || workspace.name,
      projectId: workspace.projectId,
      projectLabel: workspace.projectDisplayName,
    });
    void paseo.workspaces
      .list({ subscribe: {} })
      .then(({ subscription }) => {
        if (lifetime.signal.aborted) return void subscription.release();
        const stop = subscription.subscribe({
          snapshot: ({ entries }) => setWorkspaces(new Map(entries.map((workspace) => [workspace.id, info(workspace)]))),
          update: (message) => {
            if (message.type !== "workspace_update") return;
            const update = message.payload;
            setWorkspaces((current) => {
              const next = new Map(current);
              if (update.kind === "upsert") next.set(update.workspace.id, info(update.workspace));
              else next.delete(update.id);
              return next;
            });
          },
        });
        lifetime.signal.addEventListener("abort", () => {
          stop();
          void subscription.release();
        });
        return undefined;
      })
      .catch((error) => {
        if (!lifetime.signal.aborted) console.error("[playbooks] workspace observation failed", error);
      });
    return () => lifetime.abort();
  }, [paseo]);
  return useMemo(() => [...workspaces.values()], [workspaces]);
}

/** Main-graph steps in declared order: the columns of a playbook's progression line. */
/** The steps on a run's line: not after-tasks, nor steps its `when` skipped (a dev train has no prd go). */
function mainSteps(run: RunSummary): StepSummary[] {
  return run.playbook.steps.filter((step) => !step.afterTask && !(step.when && run.steps[step.id]?.status === "skipped"));
}

function pendingGates(run: RunSummary): Gate[] {
  return run.gates.filter((gate) => gate.status === "pending");
}

/** A run's name in lists: its first text input (the request), else its id; a train's station and jobs. */
function runTitle(run: RunSummary): string {
  if (run.train) return `${trainName(run)} · ${run.jobs.length} ${run.jobs.length === 1 ? "job" : "jobs"}`;
  return run.title ?? run.id;
}

function shortId(run: RunSummary): string {
  return run.id.replace(/^run_/, "");
}

function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function gateKindLabel(gate: Gate): string {
  return gate.kind === "ask" ? "Answer" : gate.kind === "loop_limit" ? "Loop limit" : gate.kind === "admission" ? "Admission" : "Decide";
}

/**
 * What a run is doing, as a colour: blue working, yellow waiting (a decision or a free slot),
 * green done and not opened yet, grey done and opened (or paused), red failed or canceled.
 */
type Tone = "running" | "waiting" | "paused" | "done" | "seen" | "failed";

function toneColor(theme: Theme, tone: Tone): string {
  switch (tone) {
    case "waiting":
      return theme.colors.statusWarning;
    case "running":
      return theme.colors.accent;
    case "done":
      return theme.colors.statusSuccess;
    case "failed":
      return theme.colors.statusDanger;
    default:
      return theme.colors.foregroundMuted;
  }
}

function toneIcon(tone: Tone): string {
  switch (tone) {
    case "running":
      return "LoaderCircle";
    case "waiting":
      return "CircleDot";
    case "paused":
      return "CirclePause";
    case "failed":
      return "CircleX";
    default:
      return "CircleCheck";
  }
}

/** Something is still happening: the icon and the ring move. */
function isMoving(tone: Tone): boolean {
  return tone === "running" || tone === "waiting";
}

const LIVE = new Set(["running", "waiting", "reported", "queued", "ready", "failed"]);

/**
 * Where a run stands on its line: the column of its furthest live step (Done once completed),
 * the columns of every live step, and its tone.
 */
function progress(run: RunSummary): { position: number; marks: number[]; tone: Tone; status: string } {
  const steps = mainSteps(run);
  const done = steps.length;

  if (run.status === "completed") {
    if (isActive(run)) return { position: done, marks: [done], tone: "running", status: "Done, wrapping up" };
    return { position: done, marks: [done], tone: run.seenAt ? "seen" : "done", status: "Done" };
  }
  const live = steps.flatMap((step, index) => (LIVE.has(run.steps[step.id]?.status ?? "pending") ? [index] : []));
  const completed = steps.flatMap((step, index) => (run.steps[step.id]?.status === "completed" ? [index] : []));
  const marks = live.length > 0 ? live : [Math.min(done, (completed.at(-1) ?? -1) + 1)];
  const position = Math.max(...marks);
  const at = steps[position] ? stepTitle(steps[position]!) : "Done";
  if (run.status === "failed" || run.status === "canceled") return { position, marks, tone: "failed", status: `${run.status === "failed" ? "Failed" : "Canceled"} at ${at}` };
  if (isPaused(run)) return { position, marks, tone: "paused", status: `Paused at ${at}` };
  const gates = pendingGates(run);
  if (gates.length > 0) return { position, marks, tone: "waiting", status: `Ready for you: ${gates.map((gate) => stepTitleOf(run.playbook, gate.stepId)).join(", ")}` };
  const named = (status: string) => steps.filter((step) => run.steps[step.id]?.status === status).map(stepTitle);
  const running = named("running");
  if (running.length > 0) return { position, marks, tone: "running", status: `Working: ${running.join(", ")}` };
  const queued = named("queued");
  if (queued.length > 0) return { position, marks, tone: "waiting", status: `Waiting for a free slot: ${queued.join(", ")}` };
  return { position, marks, tone: "running", status: "Manager is working" };
}

/** 1 → 0.3 → 1, forever, while `active` (and motion is allowed); 1 otherwise. */
function usePulse(active: boolean): Animated.Value {
  const reduceMotion = useReduceMotion();
  const value = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!active || reduceMotion) {
      value.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, { toValue: 0.3, duration: 800, useNativeDriver: false }),
        Animated.timing(value, { toValue: 1, duration: 800, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, reduceMotion, value]);
  return value;
}

/** A status icon that spins while the run works and pulses while it waits. */
function ToneIcon(props: { tone: Tone; color: string; size?: number }) {
  const { tone } = props;
  const reduceMotion = useReduceMotion();
  const spinning = tone === "running" && !reduceMotion;
  const spin = useRef(new Animated.Value(0)).current;
  const pulse = usePulse(tone === "waiting");
  useEffect(() => {
    if (!spinning) {
      spin.setValue(0);
      return;
    }
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 1100, easing: Easing.linear, useNativeDriver: false }));
    loop.start();
    return () => loop.stop();
  }, [spinning, spin]);
  return (
    <Animated.View
      style={{
        opacity: tone === "waiting" ? pulse.interpolate({ inputRange: [0.3, 1], outputRange: [0.45, 1] }) : 1,
        transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }],
      }}
    >
      <Icon name={toneIcon(tone)} size={props.size ?? 13} color={props.color} />
    </Animated.View>
  );
}

// ---------------------------------------------------------------- screen

export function PlaybooksScreen(props: PluginScreenProps & { store: OverviewStore }) {
  const { theme, layout, navigation, store } = props;
  const workspaces = useWorkspaces();
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [workspaceFilter, setWorkspaceFilter] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [tab, setTab] = useState<"runs" | "analytics" | "profiles">("runs");
  // The sidebar badge and this screen share one store: one agent subscription, one request per change.
  const overview = useOverview(store);
  const toast = useToast();
  // The Sidekick column: open on wide layouts, one tab per project. Compact layouts have no room for it.
  const sidekickOpen = useSidekickUi().open;
  const setSidekickOpen = sidekickUi.setOpen;
  useEffect(() => store.watchRuns(), [store]);
  const queryClient = useQueryClient();
  // Run Playbook: each project's playbooks are listed from its first workspace (the panel's query, same cache key).
  const listDefinitions = useRpc(listPlaybooks);
  const runProjects = useMemo(() => projectsOf(workspaces), [workspaces]);
  const definitions = useQueries({
    queries: runProjects.map((candidate) => ({
      queryKey: ["playbooks", "definitions", candidate.workspaceId],
      queryFn: () => listDefinitions({ workspaceId: candidate.workspaceId }),
      refetchInterval: 30_000,
    })),
  });
  const runnableOf = new Map(runProjects.map((candidate, index) => [candidate.projectId, runnablePlaybooks(definitions[index]?.data?.entries ?? [])]));
  const runnableProjects = runProjects.filter((candidate) => (runnableOf.get(candidate.projectId)?.length ?? 0) > 0);
  const runState = runButtonState(runnableProjects.length, definitions.some((query) => query.isLoading));
  const [runForm, setRunForm] = useState(false);

  const byId = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace])), [workspaces]);
  const names = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace.label])), [workspaces]);
  const allRuns = overview.runs ?? [];
  const projectOf = (run: RunSummary) => byId.get(run.workspaceId)?.projectId ?? run.projectId;
  // Two levels of chips, from every run not archived (working, waiting, failed or done): a project
  // or workspace without one is not listed.
  const projects = chipsOf(allRuns, projectOf, (run) => byId.get(run.workspaceId)?.projectLabel ?? run.projectId);
  const project = projectFilter && projects.some((chip) => chip.id === projectFilter) ? projectFilter : null;
  const inProject = allRuns.filter((run) => !project || projectOf(run) === project);
  const workspaceChips = project ? chipsOf(inProject, (run) => run.workspaceId, (run) => names.get(run.workspaceId) ?? run.workspaceId) : [];
  const scope = workspaceFilter && workspaceChips.some((chip) => chip.id === workspaceFilter) ? workspaceFilter : null;
  const inScope = inProject.filter((run) => !scope || run.workspaceId === scope);
  const isDone = (run: RunSummary) => run.status === "completed" && !isActive(run);
  // Done runs, opened or not, are listed with Show done; everything else (working, waiting, failed) always.
  const runs = inScope.filter((run) => showDone || !isDone(run)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const needs = runs.flatMap((run) => pendingGates(run).map((gate) => ({ run, gate })));
  const groups = useMemo(() => {
    const byPlaybook = new Map<string, RunSummary[]>();
    // A singleton's trains go under the singleton; its pipeline shows as its stations.
    const key = (run: RunSummary) => run.train?.playbook ?? run.playbook.id;
    for (const run of runs) byPlaybook.set(key(run), [...(byPlaybook.get(key(run)) ?? []), run]);
    const pipelines = overview.runs?.filter(isPipeline) ?? [];
    return [...byPlaybook.entries()].map(([id, list]) => ({ id, runs: list, playbook: list[0]!.playbook, pipeline: pipelines.find((run) => run.playbook.id === id && !isTerminal(run.status)) }));
  }, [runs]);
  const counts = {
    needsYou: needs.length,
    // A live pipeline stays running while it exists, idle or not: only its trains count.
    working: runs.filter((run) => !isPipeline(run) && isActive(run) && !isPaused(run) && pendingGates(run).length === 0).length,
    paused: runs.filter((run) => isPaused(run)).length,
    // Counted even when hidden, so new done runs are not missed.
    done: inScope.filter(isDone).length,
    failed: runs.filter((run) => run.status === "failed" || run.status === "canceled").length,
  };

  const pad = layout.compact ? 12 : 22;
  const onOpenWorkspace = navigation ? (workspaceId: string) => navigation.openWorkspace({ workspaceId }) : undefined;
  const onOpenAgent = navigation ? (agentId: string) => navigation.openAgent({ agentId }) : undefined;
  return (
    <StoreContext.Provider value={store}>
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: theme.colors.surface0 }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: pad, gap: 18 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap", zIndex: 50 }}>
          <PreReleaseFlag theme={theme} />
          <Text style={{ flex: 1, color: theme.colors.foregroundMuted, fontSize: 13 }}>
            <Text style={{ color: theme.colors.statusWarning }}>{counts.needsYou}</Text> {counts.needsYou === 1 ? "needs" : "need"} you ·{" "}
            <Text style={{ color: theme.colors.accent }}>{counts.working}</Text> working
            {counts.paused > 0 ? ` · ${counts.paused} paused` : ""}
            {counts.failed > 0 ? (
              <>
                {" · "}
                <Text style={{ color: theme.colors.statusDanger }}>{counts.failed}</Text> failed
              </>
            ) : null}
            {counts.done > 0 ? (
              <>
                {" · "}
                <Text style={{ color: theme.colors.statusSuccess }}>{counts.done}</Text> done
              </>
            ) : null}
          </Text>
          {runState !== "hidden" ? <RunPlaybookButton theme={theme} loading={runState === "loading"} onPress={() => setRunForm(true)} /> : null}
          {!layout.compact ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${sidekickOpen ? "Close" : "Open"} the Sidekick: a coordinator agent per project that watches the runs and improves the playbooks`}
              accessibilityState={{ expanded: sidekickOpen }}
              hitSlop={8}
              onPress={() => setSidekickOpen(!sidekickOpen)}
              style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
            >
              <Icon name="Bot" size={16} color={sidekickOpen ? theme.colors.accent : theme.colors.foregroundMuted} />
              <Text style={{ color: sidekickOpen ? theme.colors.accent : theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>Sidekick</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh playbooks"
            hitSlop={8}
            onPress={() => {
              store.refresh();
              void queryClient.invalidateQueries({ queryKey: ["playbooks"] });
            }}
          >
            <Icon name="RefreshCw" size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>

        <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 16, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
          <Tab theme={theme} label="Runs" selected={tab === "runs"} onPress={() => setTab("runs")} />
          <Tab theme={theme} label="Analytics" selected={tab === "analytics"} onPress={() => setTab("analytics")} />
          <Tab theme={theme} label="Profiles" selected={tab === "profiles"} onPress={() => setTab("profiles")} />
        </View>

        {tab === "analytics" ? (
          <AnalyticsView theme={theme} />
        ) : tab === "profiles" ? (
          <ProfilesView theme={theme} workspaces={workspaces} />
        ) : (
          <>
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Chip
              theme={theme}
              label="All projects"
              selected={!project}
              onPress={() => {
                setProjectFilter(null);
                setWorkspaceFilter(null);
              }}
            />
            {projects.map((chip) => (
              <Chip
                key={chip.id}
                theme={theme}
                label={chip.label}
                count={chip.needsYou}
                selected={project === chip.id}
                onPress={() => {
                  setProjectFilter(project === chip.id ? null : chip.id);
                  setWorkspaceFilter(null);
                }}
              />
            ))}
            <Chip theme={theme} label="Show done" icon={showDone ? "Check" : undefined} selected={showDone} onPress={() => setShowDone(!showDone)} />
          </View>
          {project && workspaceChips.length > 0 ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: theme.colors.border }}>
              <Chip theme={theme} small label="All workspaces" selected={!scope} onPress={() => setWorkspaceFilter(null)} />
              {workspaceChips.map((chip) => (
                <Chip
                  key={chip.id}
                  theme={theme}
                  small
                  label={chip.label}
                  count={chip.needsYou}
                  selected={scope === chip.id}
                  onPress={() => setWorkspaceFilter(scope === chip.id ? null : chip.id)}
                />
              ))}
            </View>
          ) : null}
        </View>

        {overview.error ? <Text style={{ color: theme.colors.statusDanger }}>{overview.error}</Text> : null}
        {overview.runs === null && !overview.error ? <Text style={{ color: theme.colors.foregroundMuted }}>Loading…</Text> : null}

        {needs.length > 0 ? (
          <View style={{ gap: 8 }}>
            <SectionTitle theme={theme} icon="CircleDot" iconColor={theme.colors.statusWarning} title="Needs you" count={needs.length} />
            <View style={{ borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, overflow: "hidden" }}>
              {needs.map(({ run, gate }, index) => (
                <NeedsYouRow key={gate.id} theme={theme} run={run} gate={gate} first={index === 0} workspace={names.get(run.workspaceId) ?? run.workspaceId} hostLabel={props.host.label} compact={layout.compact} onOpenWorkspace={onOpenWorkspace} onOpenAgent={onOpenAgent} />
              ))}
            </View>
          </View>
        ) : null}

        {/* Earlier groups stack above later ones, so a group's sort menu is not covered by the groups below it. */}
        {groups.map((group, index) => (
          <PlaybookGroup
            key={group.id}
            zIndex={groups.length - index}
            theme={theme}
            compact={layout.compact}
            runs={group.runs}
            pipeline={group.pipeline}
            allRuns={overview.runs ?? []}
            names={names}
            onOpenWorkspace={onOpenWorkspace}
            onOpenAgent={onOpenAgent}
          />
        ))}

        {overview.runs && groups.length === 0 ? (
          <View style={{ alignItems: "center", gap: 8, paddingVertical: 32 }}>
            <Icon name="Workflow" size={28} color={theme.colors.foregroundMuted} />
            {overview.runs.length === 0 ? (
              <>
                <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600", textAlign: "center" }}>No runs yet</Text>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, textAlign: "center", maxWidth: 340 }}>
                  Open a workspace, then its Playbooks panel: if it has no playbook, one button creates a small example you can start.
                </Text>
                <Button
                  theme={theme}
                  label="Read the guide ↗"
                  accessibilityLabel="Open the getting started guide in your browser"
                  onPress={() =>
                    void openExternalUrl(GETTING_STARTED_URL).catch((error: unknown) =>
                      toast.error(error instanceof Error ? error.message : String(error)),
                    )
                  }
                />
              </>
            ) : (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, textAlign: "center" }}>
                {showDone ? "No runs yet." : "Nothing running. Show done lists the finished runs."}
              </Text>
            )}
          </View>
        ) : null}
          </>
        )}
      </ScrollView>
      {runForm && runnableProjects.length > 0 ? (
        <OverviewRunForm
          theme={theme}
          projects={runnableProjects}
          playbooksOf={runnableOf}
          initial={defaultProject(runnableProjects, project)}
          compact={layout.compact}
          onClose={() => setRunForm(false)}
          onStarted={() => {
            setRunForm(false);
            void queryClient.invalidateQueries({ queryKey: ["playbooks"] });
          }}
        />
      ) : null}
      {!layout.compact && sidekickOpen ? (
        <SidekickPane
          theme={theme}
          workspaces={workspaces}
          openAgent={onOpenAgent}
          onClose={() => setSidekickOpen(false)}
        />
      ) : null}
    </View>
    </StoreContext.Provider>
  );
}

interface ChipInfo {
  id: string;
  label: string;
  needsYou: number;
}

/** One chip per distinct key among these runs, with the gates pending in its runs, sorted by label. */
function chipsOf(runs: RunSummary[], key: (run: RunSummary) => string, label: (run: RunSummary) => string): ChipInfo[] {
  const chips = new Map<string, ChipInfo>();
  for (const run of runs) {
    const id = key(run);
    const chip = chips.get(id) ?? { id, label: label(run), needsYou: 0 };
    chip.needsYou += pendingGates(run).length;
    chips.set(id, chip);
  }
  return [...chips.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function Tab(props: { theme: Theme; label: string; selected: boolean; onPress(): void }) {
  const { theme, selected } = props;
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      onPress={props.onPress}
      style={{ paddingVertical: 8, marginBottom: -1, borderBottomWidth: 2, borderBottomColor: selected ? theme.colors.foreground : "transparent" }}
    >
      <Text style={{ color: selected ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 13, fontWeight: selected ? "700" : "500" }}>{props.label}</Text>
    </Pressable>
  );
}

function Chip(props: { theme: Theme; label: string; selected: boolean; onPress(): void; count?: number; icon?: string; small?: boolean }) {
  const { theme, selected } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={props.count ? `${props.label}, ${props.count} ${props.count === 1 ? "needs" : "need"} you` : props.label}
      onPress={props.onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: selected ? theme.colors.foregroundMuted : theme.colors.border,
        backgroundColor: selected ? theme.colors.surface2 : theme.colors.surface1,
        paddingHorizontal: props.small ? 9 : 11,
        paddingVertical: props.small ? 3 : 5,
      }}
    >
      {props.icon ? <Icon name={props.icon} size={12} color={theme.colors.foreground} /> : null}
      <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{props.label}</Text>
      {props.count ? <Badge theme={theme} count={props.count} /> : null}
    </Pressable>
  );
}

function SectionTitle(props: { theme: Theme; title: string; count?: number; icon?: string; iconColor?: string; description?: string; extra?: string; extraColor?: string }) {
  const { theme } = props;
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
      {props.icon ? <Icon name={props.icon} size={14} color={props.iconColor ?? theme.colors.foregroundMuted} /> : null}
      <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "700" }}>
        {props.title}
      </Text>
      {props.count === undefined ? null : <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{props.count}</Text>}
      {props.description ? (
        <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: 13 }}>
          {props.description}
        </Text>
      ) : null}
      {props.extra ? <Text style={{ color: props.extraColor ?? theme.colors.foregroundMuted, fontSize: 12 }}>{props.extra}</Text> : null}
    </View>
  );
}

/** A pending gate: what it asks, where it is, and Review, which opens the gate's choices in place. */
function NeedsYouRow(props: {
  theme: Theme;
  run: RunSummary;
  gate: Gate;
  first: boolean;
  workspace: string;
  hostLabel: string;
  compact: boolean;
  onOpenWorkspace?: (workspaceId: string) => void;
  onOpenAgent?: (agentId: string) => void;
}) {
  const { theme, run, gate } = props;
  const [open, setOpen] = useState(false);
  const refresh = useStoreRefresh();
  const warning = theme.colors.statusWarning;
  const summary = gateText(gate).summary.split("\n")[0] || `${stepTitleOf(run.playbook, gate.stepId)} is waiting`;
  return (
    <View style={{ borderTopWidth: props.first ? 0 : 1, borderTopColor: theme.colors.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 10 }}>
        {props.compact ? null : (
          <View style={{ width: 92, flexDirection: "row", alignItems: "center", gap: 6 }}>
            <ToneIcon tone="waiting" color={warning} />
            <Text style={{ color: warning, fontSize: 12, fontWeight: "600" }}>{gateKindLabel(gate)}</Text>
          </View>
        )}
        <View style={{ flex: 1, gap: 2 }}>
          <Text numberOfLines={open ? undefined : 1} style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "500" }}>
            {summary} <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{shortId(run)}</Text>
          </Text>
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            {run.playbook.title} › {stepTitleOf(run.playbook, gate.stepId)} · {props.workspace} · {runTitle(run)}
          </Text>
        </View>
        {props.compact ? null : <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{ago(gate.requestedAt)}</Text>}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`${open ? "Close" : "Review"} ${summary}`}
          onPress={() => setOpen(!open)}
          style={{ borderRadius: 7, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: open ? theme.colors.surface2 : theme.colors.accent }}
        >
          <Text style={{ color: open ? theme.colors.foreground : theme.colors.accentForeground, fontSize: 12, fontWeight: "600" }}>{open ? "Close" : "Review"}</Text>
        </Pressable>
        <RunActions theme={theme} run={run} workspace={props.workspace} compact={props.compact} onOpenAgent={props.onOpenAgent} onOpenWorkspace={props.onOpenWorkspace} />
      </View>
      {open ? (
        <View style={{ paddingHorizontal: 12, paddingBottom: 12, paddingLeft: props.compact ? 12 : 116, maxWidth: 760 }}>
          <GateActions theme={theme} run={run} gate={gate} hostLabel={props.hostLabel} onDecided={refresh} />
        </View>
      ) : null}
    </View>
  );
}

const TITLE_WIDTH = "38%";

type SortKey = "updated" | "started" | "status" | "progress";

const SORTS: ReadonlyArray<{ key: SortKey; label: string; hint: string }> = [
  { key: "updated", label: "Last update", hint: "Most recent activity first" },
  { key: "started", label: "Started", hint: "Newest run first" },
  { key: "status", label: "Status", hint: "Waiting, working, failed, done, paused, seen" },
  { key: "progress", label: "Progress", hint: "Furthest along first" },
];

/** Order of tones under "Status": what needs a look first. */
const TONE_RANK: Record<Tone, number> = { waiting: 0, running: 1, failed: 2, done: 3, paused: 4, seen: 5 };

/** Runs in the chosen order; ties go to the most recent activity. */
function sortRuns(runs: RunSummary[], key: SortKey): RunSummary[] {
  const byUpdate = (a: RunSummary, b: RunSummary) => b.updatedAt.localeCompare(a.updatedAt);
  const facts = new Map(runs.map((run) => [run.id, progress(run)]));
  const compare = (a: RunSummary, b: RunSummary): number => {
    switch (key) {
      case "started":
        return b.createdAt.localeCompare(a.createdAt);
      case "status":
        return TONE_RANK[facts.get(a.id)!.tone] - TONE_RANK[facts.get(b.id)!.tone];
      case "progress": {
        // Share of the line covered, so runs of an edited playbook with more or fewer steps compare fairly.
        const share = (run: RunSummary) => facts.get(run.id)!.position / Math.max(1, mainSteps(run).length);
        return share(b) - share(a);
      }
      default:
        return 0;
    }
  };
  return [...runs].sort((a, b) => compare(a, b) || byUpdate(a, b));
}

/** "Runs" with the sort of this playbook's rows: a button that opens the choices below it. */
function SortHeading(props: { theme: Theme; label?: string; value: SortKey; onChange(key: SortKey): void }) {
  const { theme, value } = props;
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<SortKey | null>(null);
  const current = SORTS.find((sort) => sort.key === value)!;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, zIndex: 10 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.4 }}>{props.label ?? "Runs"}</Text>
      <View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Sort runs: ${current.label}`}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          style={{ flexDirection: "row", alignItems: "center", gap: 3, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, backgroundColor: open ? theme.colors.surface2 : "transparent" }}
        >
          <Icon name="ArrowDownUp" size={11} color={theme.colors.foregroundMuted} />
          <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>{current.label}</Text>
          <Icon name={open ? "ChevronUp" : "ChevronDown"} size={11} color={theme.colors.foregroundMuted} />
        </Pressable>
        {open ? (
          <View
            accessibilityRole="menu"
            style={{
              position: "absolute",
              top: 24,
              left: 0,
              minWidth: 220,
              padding: 4,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface2,
              elevation: 6,
            }}
          >
            {SORTS.map((sort) => (
              <Pressable
                key={sort.key}
                accessibilityRole="menuitem"
                accessibilityState={{ selected: sort.key === value }}
                onPress={() => {
                  setOpen(false);
                  props.onChange(sort.key);
                }}
                onHoverIn={() => setHover(sort.key)}
                onHoverOut={() => setHover((key) => (key === sort.key ? null : key))}
                style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 6, backgroundColor: hover === sort.key ? theme.colors.surface1 : "transparent" }}
              >
                <View style={{ width: 13 }}>{sort.key === value ? <Icon name="Check" size={13} color={theme.colors.accent} /> : null}</View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{sort.label}</Text>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{sort.hint}</Text>
                </View>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** The runs of one playbook: column labels for its steps, then one row with a progression line per run. */
function PlaybookGroup(props: {
  zIndex: number;
  theme: Theme;
  compact: boolean;
  runs: RunSummary[];
  /** A singleton's active pipeline: shown as its stations, its trains as the rows. */
  pipeline?: RunSummary | undefined;
  allRuns: RunSummary[];
  names: Map<string, string>;
  onOpenWorkspace?: (workspaceId: string) => void;
  onOpenAgent?: (agentId: string) => void;
}) {
  const [sort, setSort] = useState<SortKey>("updated");
  // Trains of different stations have different steps: each row shows its own columns.
  const compact = props.compact || Boolean(props.pipeline);
  const theme = props.theme;
  // The most recently updated run's definition gives the columns (runs come in that order);
  // older runs of an edited playbook keep their own steps.
  const playbook = props.pipeline?.playbook ?? props.runs[0]!.playbook;
  const rows = useMemo(() => props.runs.filter((run) => !isPipeline(run)), [props.runs]);
  const columns = rows[0] ? [...mainSteps(rows[0]).map(stepShortTitle), "Done"] : ["Done"];
  const runs = useMemo(() => sortRuns(rows, sort), [rows, sort]);
  const runsById = useMemo(() => new Map(props.allRuns.map((run) => [run.id, run])), [props.allRuns]);
  const working = runs.filter((run) => isActive(run) && !isPaused(run) && pendingGates(run).length === 0).length;
  return (
    <View style={{ gap: 8, zIndex: props.zIndex }}>
      <SectionTitle
        theme={theme}
        title={playbook.title}
        count={props.pipeline ? undefined : runs.length}
        description={compact ? undefined : playbook.description}
        extra={
          props.pipeline
            ? `${openJobsLabel(props.pipeline)} · ${working} ${working === 1 ? "train" : "trains"} running`
            : working > 0
              ? `${working} working`
              : undefined
        }
        extraColor={theme.colors.accent}
      />
      {props.pipeline ? <Stations theme={theme} pipeline={props.pipeline} runs={props.allRuns} /> : null}
      {/* No overflow clipping: the sort menu opens over the rows below. */}
      {runs.length > 0 ? (
      <View style={{ borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.colors.border, zIndex: 10 }}>
          <View style={{ width: compact ? undefined : TITLE_WIDTH, flex: compact ? 1 : undefined }}>
            <SortHeading theme={theme} label={props.pipeline ? "Trains" : undefined} value={sort} onChange={setSort} />
          </View>
          {compact ? null : (
            <>
              <StepLabels theme={theme} columns={columns} />
              <View style={{ width: ACTIONS_WIDTH }} />
            </>
          )}
        </View>
        {runs.map((run, index) => (
          <RunRow
            key={run.id}
            theme={theme}
            run={run}
            first={index === 0}
            compact={compact}
            workspace={props.names.get(run.workspaceId) ?? run.workspaceId}
            runs={runsById}
            onOpenWorkspace={props.onOpenWorkspace}
            onOpenAgent={props.onOpenAgent}
          />
        ))}
      </View>
      ) : null}
    </View>
  );
}

function at(index: number, total: number): `${number}%` {
  return `${total <= 1 ? 0 : (index / (total - 1)) * 100}%`;
}

function StepLabels(props: { theme: Theme; columns: string[] }) {
  const { theme, columns } = props;
  const [width, setWidth] = useState(0);
  const { rows, labelWidth } = labelLayout(width, columns);
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ flex: 1, height: ROW_HEIGHT * rows + 1, marginHorizontal: LABEL_WIDTH / 2 }}
    >
      {/* Measured first: nothing is drawn until the width is known, so labels never flash overlapped. */}
      {width > 0
        ? columns.map((label, index) => (
            <Text
              key={`${label}-${index}`}
              numberOfLines={1}
              accessibilityLabel={label}
              style={{
                position: "absolute",
                left: at(index, columns.length),
                top: rows === 2 && index % 2 === 1 ? ROW_HEIGHT : 0,
                width: labelWidth,
                marginLeft: -labelWidth / 2,
                textAlign: "center",
                color: theme.colors.foregroundMuted,
                fontSize: 11,
              }}
            >
              {label}
            </Text>
          ))
        : null}
    </View>
  );
}

function RunRow(props: {
  theme: Theme;
  run: RunSummary;
  first: boolean;
  compact: boolean;
  workspace: string;
  /** Every run, to draw the lanes of a fan-out from its children's own progress. */
  runs: Map<string, RunSummary>;
  onOpenWorkspace?: (workspaceId: string) => void;
  onOpenAgent?: (agentId: string) => void;
}) {
  const { theme, run, compact } = props;
  const state = progress(run);
  const color = toneColor(theme, state.tone);
  const columns = [...mainSteps(run).map(stepShortTitle), "Done"];
  const markSeen = useRpc(markRunSeenRpc);
  const refresh = useStoreRefresh();
  /** Opening a finished run from here marks it seen: a green done run turns grey. */
  const opened = () => {
    if (isActive(run) || run.seenAt) return;
    void markSeen({ runId: run.id })
      .then(refresh)
      .catch((error: unknown) => console.error("[playbooks] mark seen failed", error));
  };
  // A pipeline has no manager.
  const openWorkspace = props.onOpenWorkspace && run.workspaceId
    ? () => {
        opened();
        props.onOpenWorkspace!(run.workspaceId);
      }
    : undefined;
  const title = (
    <Pressable
      accessibilityRole={openWorkspace ? "button" : undefined}
      accessibilityLabel={`${runTitle(run)}, ${state.status}${state.tone === "done" ? ", not opened yet" : ""}`}
      accessibilityHint={openWorkspace ? `Opens workspace ${props.workspace}` : undefined}
      disabled={!openWorkspace}
      onPress={openWorkspace}
      style={{ width: compact ? undefined : TITLE_WIDTH, flex: compact ? 1 : undefined, flexDirection: "row", gap: 8, paddingRight: 12 }}
    >
      <View style={{ paddingTop: 2 }}>
        <ToneIcon tone={state.tone} color={color} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "500" }}>
          {runTitle(run)}
        </Text>
        <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          {shortId(run)} · <Text style={{ color: state.tone === "seen" || state.tone === "paused" ? theme.colors.foregroundMuted : color }}>{state.status}</Text> ·{" "}
          {ago(run.updatedAt)}
          {props.workspace ? ` · ${props.workspace}` : ""}
          {run.parent ? ` · item ${run.parent.key} of ${run.parent.runId.replace(/^run_/, "")}` : ""}
        </Text>
      </View>
    </Pressable>
  );
  const actions = (
    <RunActions
      theme={theme}
      run={run}
      workspace={props.workspace}
      compact={compact}
      onOpenAgent={
        props.onOpenAgent && run.managerAgentId
          ? (agentId) => {
              opened();
              props.onOpenAgent!(agentId);
            }
          : undefined
      }
      onOpenWorkspace={openWorkspace ? () => openWorkspace() : undefined}
    />
  );
  return (
    <View style={{ borderTopWidth: props.first ? 0 : 1, borderTopColor: theme.colors.border, paddingHorizontal: 12, paddingVertical: 10, gap: 8 }}>
      {compact ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
            {title}
            {actions}
          </View>
          {/* In rows: both stretch with `flex: 1`, which in this column would collapse their height. */}
          <View style={{ flexDirection: "row" }}>
            <StepLabels theme={theme} columns={columns} />
          </View>
          <View style={{ flexDirection: "row" }}>
            <ProgressLine theme={theme} total={columns.length} position={state.position} marks={state.marks} color={color} moving={isMoving(state.tone)} />
          </View>
        </>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          {title}
          <ProgressLine theme={theme} total={columns.length} position={state.position} marks={state.marks} color={color} moving={isMoving(state.tone)} />
          {actions}
        </View>
      )}
      {Object.entries(run.fanouts).map(([stepId, fanout]) => (
        <FanoutLanes key={stepId} theme={theme} run={run} stepId={stepId} fanout={fanout} compact={compact} runs={props.runs} onOpenWorkspace={props.onOpenWorkspace} />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------- fan-out lanes

type FanoutChildInfo = RunSummary["fanouts"][string]["children"][number];

/** Lanes shown before "Show all": the ones that need a human come first, then running ones. */
const LANES_SHOWN = 6;

const LANE_RANK: Record<FanoutChildInfo["status"], number> = { running: 1, starting: 1, pending: 2, not_started: 3, failed: 3, canceled: 3, completed: 4 };

/** A pass's counts: started, running, done (completed), failed (failed, canceled or never started). */
function fanoutCounts(children: FanoutChildInfo[]) {
  const count = (...statuses: FanoutChildInfo["status"][]) => children.filter((child) => statuses.includes(child.status)).length;
  return { started: children.filter((child) => child.runId !== null).length, running: count("starting", "running"), waiting: count("pending"), done: count("completed"), failed: count("failed", "canceled", "not_started") };
}

function countsText(children: FanoutChildInfo[]): string {
  const counts = fanoutCounts(children);
  return [`${counts.started}/${children.length} started`, counts.running ? `${counts.running} running` : "", counts.waiting ? `${counts.waiting} waiting` : "", `${counts.done} done`, counts.failed ? `${counts.failed} failed` : ""].filter(Boolean).join(" · ");
}

/**
 * A fan-out step of a run, drawn inside the run's row as one compact lane per child run: its key, the child's own
 * progress line, its status, a "needs you" marker when the child has a gate open, and a press that opens the child's
 * workspace. Many children collapse to the first few (those needing a human first) with a scrolling "Show all";
 * earlier passes of the parent's loop stay viewable under "Earlier passes".
 */
function FanoutLanes(props: {
  theme: Theme;
  run: RunSummary;
  stepId: string;
  fanout: RunSummary["fanouts"][string];
  compact: boolean;
  runs: Map<string, RunSummary>;
  onOpenWorkspace?: ((workspaceId: string) => void) | undefined;
}) {
  const { theme, fanout } = props;
  const [open, setOpen] = useState(true);
  const [past, setPast] = useState(false);
  const title = stepTitleOf(props.run.playbook, props.stepId);
  return (
    <View style={{ gap: 6, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: theme.colors.border }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${title}, pass ${fanout.loop + 1}: ${countsText(fanout.children)}`} onPress={() => setOpen(!open)} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name={open ? "ChevronDown" : "ChevronRight"} size={13} color={theme.colors.foregroundMuted} />
        <Text numberOfLines={2} style={{ flex: 1, color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
          {title} <Text style={{ color: theme.colors.foregroundMuted, fontWeight: "400" }}>· pass {fanout.loop + 1} · {countsText(fanout.children)}</Text>
        </Text>
      </Pressable>
      {open ? <Lanes theme={theme} children={fanout.children} compact={props.compact} runs={props.runs} onOpenWorkspace={props.onOpenWorkspace} /> : null}
      {open && fanout.past.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: past }} onPress={() => setPast(!past)} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Icon name={past ? "ChevronDown" : "ChevronRight"} size={13} color={theme.colors.foregroundMuted} />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Earlier passes ({fanout.past.length})</Text>
          </Pressable>
          {past
            ? [...fanout.past].reverse().map((pass, index) => <PastPass key={`${pass.loop}-${index}`} theme={theme} pass={pass} compact={props.compact} runs={props.runs} onOpenWorkspace={props.onOpenWorkspace} />)
            : null}
        </View>
      ) : null}
    </View>
  );
}

function PastPass(props: { theme: Theme; pass: RunSummary["fanouts"][string]["past"][number]; compact: boolean; runs: Map<string, RunSummary>; onOpenWorkspace?: ((workspaceId: string) => void) | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 6, paddingLeft: 8 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name={open ? "ChevronDown" : "ChevronRight"} size={12} color={props.theme.colors.foregroundMuted} />
        <Text style={{ flex: 1, color: props.theme.colors.foregroundMuted, fontSize: 11 }}>Pass {props.pass.loop + 1} · {countsText(props.pass.children)}</Text>
      </Pressable>
      {open ? <Lanes theme={props.theme} children={props.pass.children} compact={props.compact} runs={props.runs} onOpenWorkspace={props.onOpenWorkspace} /> : null}
    </View>
  );
}

function Lanes(props: { theme: Theme; children: FanoutChildInfo[]; compact: boolean; runs: Map<string, RunSummary>; onOpenWorkspace?: ((workspaceId: string) => void) | undefined }) {
  const [all, setAll] = useState(false);
  const needsYou = (child: FanoutChildInfo) => (child.runId ? (props.runs.get(child.runId)?.gates.length ?? 0) > 0 : false);
  const ordered = useMemo(
    () => props.children.map((child, index) => ({ child, index })).sort((a, b) => Number(needsYou(b.child)) - Number(needsYou(a.child)) || LANE_RANK[a.child.status] - LANE_RANK[b.child.status] || a.index - b.index),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.children, props.runs],
  );
  const shown = all ? ordered : ordered.slice(0, LANES_SHOWN);
  const lanes = shown.map(({ child }) => <Lane key={child.key} theme={props.theme} child={child} compact={props.compact} run={child.runId ? props.runs.get(child.runId) : undefined} onOpenWorkspace={props.onOpenWorkspace} />);
  return (
    <View style={{ gap: 6 }}>
      {all && ordered.length > 12 ? <ScrollView style={{ maxHeight: 360 }} nestedScrollEnabled><View style={{ gap: 6 }}>{lanes}</View></ScrollView> : lanes}
      {ordered.length > LANES_SHOWN ? (
        <Pressable accessibilityRole="button" onPress={() => setAll(!all)}>
          <Text style={{ color: props.theme.colors.accent, fontSize: 11 }}>{all ? "Show fewer" : `Show all ${ordered.length}`}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const LANE_STATUS: Record<FanoutChildInfo["status"], string> = { pending: "Waiting for a free slot", starting: "Starting", running: "Running", completed: "Done", failed: "Failed", canceled: "Canceled", not_started: "Not started" };

/** One child run: key, its own progress line, status, and a marker when a human is needed. */
function Lane(props: { theme: Theme; child: FanoutChildInfo; compact: boolean; run: RunSummary | undefined; onOpenWorkspace?: ((workspaceId: string) => void) | undefined }) {
  const { theme, child, run } = props;
  const state = run ? progress(run) : null;
  const color = state ? toneColor(theme, state.tone) : child.status === "not_started" || child.status === "failed" || child.status === "canceled" ? theme.colors.statusDanger : theme.colors.foregroundMuted;
  const gates = run?.gates.length ?? 0;
  const status = state ? state.status : child.error && child.status === "not_started" ? `Not started: ${child.error}` : LANE_STATUS[child.status];
  const open = run && props.onOpenWorkspace ? () => props.onOpenWorkspace!(run.workspaceId) : undefined;
  const columns = run ? mainSteps(run).length + 1 : 0;
  const line = state && run ? <ProgressLine theme={theme} total={columns} position={state.position} marks={state.marks} color={color} moving={isMoving(state.tone)} /> : null;
  const marker = gates > 0 ? (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <Icon name="CircleDot" size={12} color={theme.colors.statusWarning} />
      <Text style={{ color: theme.colors.statusWarning, fontSize: 11, fontWeight: "600" }}>Needs you</Text>
    </View>
  ) : null;
  return (
    <Pressable
      accessibilityRole={open ? "button" : undefined}
      accessibilityLabel={`${child.key}: ${status}${gates > 0 ? ", needs you" : ""}`}
      accessibilityHint={open ? "Opens the child run's workspace" : undefined}
      disabled={!open}
      onPress={open}
      style={{ flexDirection: props.compact ? "column" : "row", alignItems: props.compact ? "stretch" : "center", gap: props.compact ? 2 : 8 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, width: props.compact ? undefined : 150 }}>
        {state ? <ToneIcon tone={state.tone} color={color} size={11} /> : <Icon name="Circle" size={11} color={color} />}
        <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: 12, fontWeight: "500" }}>{child.key}</Text>
        {props.compact ? marker : null}
      </View>
      {line ? <View style={{ flex: props.compact ? undefined : 1, minWidth: 80, flexDirection: "row" }}>{line}</View> : <View style={{ flex: props.compact ? undefined : 1 }} />}
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11, width: props.compact ? undefined : 190 }}>{status}</Text>
      {props.compact ? null : marker}
    </Pressable>
  );
}

/** Room for the right-hand buttons of a row: manager, workspace and archive. */
const ACTIONS_WIDTH = 90;

/** Open the run's Playbook Manager and its workspace, or archive a finished run: the right-hand buttons of a run or Needs you row. */
function RunActions(props: {
  theme: Theme;
  run: RunSummary;
  workspace: string;
  compact: boolean;
  onOpenAgent?: (agentId: string) => void;
  onOpenWorkspace?: (workspaceId: string) => void;
}) {
  const { theme, run } = props;
  const archive = useRpc(archiveRunRpc);
  const refresh = useStoreRefresh();
  const toast = useToast();
  // Only a finished run whose after-tasks are done can be archived.
  const archivable = isTerminal(run.status) && !isActive(run);
  return (
    <View style={{ width: props.compact ? undefined : ACTIONS_WIDTH, flexDirection: "row", justifyContent: "flex-end", gap: 10 }}>
      {props.onOpenAgent && run.managerAgentId ? (
        <IconButton theme={theme} icon="Bot" label={`Open the Playbook Manager of run ${shortId(run)}`} onPress={() => props.onOpenAgent!(run.managerAgentId)} />
      ) : null}
      {props.onOpenWorkspace ? (
        <IconButton theme={theme} icon="SquareArrowOutUpRight" label={`Open workspace ${props.workspace}`} onPress={() => props.onOpenWorkspace!(run.workspaceId)} />
      ) : null}
      {archivable ? (
        <IconButton
          theme={theme}
          icon="Archive"
          label={`Archive run ${shortId(run)}`}
          hint="Hides the run from this screen and its panel. Its agents and saved state are kept."
          onPress={() =>
            void archive({ runId: run.id })
              .then(refresh)
              .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
          }
        />
      ) : null}
    </View>
  );
}

function IconButton(props: { theme: Theme; icon: string; label: string; hint?: string; onPress(): void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={props.label} accessibilityHint={props.hint} hitSlop={6} onPress={props.onPress}>
      <Icon name={props.icon} size={15} color={props.theme.colors.foregroundMuted} />
    </Pressable>
  );
}

const RING = 12;
const TICK = 5;

/**
 * A track with a tick per column, filled in the run's colour up to its position, and a ring on
 * each live step (several when parallel steps run at once) that pulses while the run moves.
 */
function ProgressLine(props: { theme: Theme; total: number; position: number; marks: number[]; color: string; moving: boolean }) {
  const { theme, total, position, marks, color } = props;
  const filled = withAlpha(color, 0.75) ?? color;
  const pulse = usePulse(props.moving);
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: total - 1, now: position }}
      style={{ flex: 1, height: RING + 8, marginHorizontal: LABEL_WIDTH / 2, justifyContent: "center" }}
    >
      <View style={{ position: "absolute", left: 0, right: 0, height: 1, backgroundColor: theme.colors.border }} />
      <View style={{ position: "absolute", left: 0, width: at(position, total), height: 1.5, backgroundColor: filled }} />
      {Array.from({ length: total }, (_, index) =>
        marks.includes(index) ? null : (
          <View
            key={index}
            style={{
              position: "absolute",
              left: at(index, total),
              marginLeft: -TICK / 2,
              width: TICK,
              height: TICK,
              borderRadius: TICK / 2,
              backgroundColor: index <= position ? filled : theme.colors.surface1,
              borderWidth: 1,
              borderColor: index <= position ? filled : theme.colors.border,
            }}
          />
        ),
      )}
      {marks.map((index) => (
        <View key={`mark-${index}`} style={{ position: "absolute", left: at(index, total), marginLeft: -RING / 2, width: RING, height: RING }}>
          {props.moving ? (
            <Animated.View
              style={{
                position: "absolute",
                width: RING,
                height: RING,
                borderRadius: RING / 2,
                backgroundColor: color,
                opacity: pulse.interpolate({ inputRange: [0.3, 1], outputRange: [0.35, 0] }),
                transform: [{ scale: pulse.interpolate({ inputRange: [0.3, 1], outputRange: [1.9, 1] }) }],
              }}
            />
          ) : null}
          <View
            style={{
              width: RING,
              height: RING,
              borderRadius: RING / 2,
              borderWidth: 1.5,
              borderColor: color,
              backgroundColor: withAlpha(color, 0.18) ?? theme.colors.surface1,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: color }} />
          </View>
        </View>
      ))}
    </View>
  );
}
