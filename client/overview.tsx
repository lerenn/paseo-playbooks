import { usePaseo, useRpc, type PluginScreenProps, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView, SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, Pressable, Text, View } from "react-native";
import { markRunSeenRpc, needsYouRpc, overviewStateRpc } from "../shared/contracts";
import { gateText } from "../shared/gates";
import { isActive, isPaused, type Gate, type Run, type Step } from "../shared/types";
import { useAgentEvents } from "./events";
import { useReduceMotion } from "./graph";
import { GateActions } from "./sheet";
import { stepLabel, withAlpha, type Theme } from "./theme";

/** Id of the Playbooks screen, opened from the sidebar row. */
export const SCREEN_ID = "playbooks";
/**
 * The badge and the screen refresh on agent events (batched over EVENTS_BATCH_MS across all
 * workspaces): a gate answered in chat, a step starting or ending. The slow polls only catch
 * changes with no agent activity (a step timeout firing on the daemon).
 */
const EVENTS_BATCH_MS = 1_000;
const BADGE_POLL_MS = 15_000;
const SCREEN_POLL_MS = 15_000;

// ---------------------------------------------------------------- sidebar row

/** "Playbooks" in the sidebar, with the number of gates waiting for a human as an accent badge. */
export function PlaybooksSidebarItem(props: PluginSidebarItemProps) {
  const { theme } = props;
  const needsYou = useRpc(needsYouRpc);
  const [count, setCount] = useState(0);
  const alive = useRef(true);
  const refresh = useCallback(
    () =>
      void needsYou({})
        .then((result) => alive.current && setCount(result.count))
        .catch((error: unknown) => console.error("[playbooks] needs-you count failed", error)),
    [needsYou],
  );
  useEffect(() => {
    alive.current = true;
    refresh();
    const timer = setInterval(refresh, BADGE_POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  useAgentEvents(null, refresh, EVENTS_BATCH_MS);
  return (
    <SidebarRow
      icon="Workflow"
      label="Playbooks"
      active={props.currentScreen?.screenId === SCREEN_ID}
      onPress={() => props.openScreen({ screenId: SCREEN_ID })}
      trailing={count > 0 ? <Badge theme={theme} count={count} label={`${count} ${count === 1 ? "needs" : "need"} you`} /> : undefined}
    />
  );
}

function Badge(props: { theme: Theme; count: number; label?: string }) {
  const { theme } = props;
  return (
    <View
      accessibilityLabel={props.label}
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
function mainSteps(run: Run): Step[] {
  return run.playbook.steps.filter((step) => !step.afterTask);
}

function pendingGates(run: Run): Gate[] {
  return run.gates.filter((gate) => gate.status === "pending");
}

/** A run's name in lists: its first text input (the request), else its id. */
function runTitle(run: Run): string {
  const text = Object.values(run.inputs).find((value): value is string => typeof value === "string" && value.trim() !== "");
  return text ? text.trim().split("\n")[0]! : run.id;
}

function shortId(run: Run): string {
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
  return gate.kind === "ask" ? "Answer" : gate.kind === "loop_limit" ? "Loop limit" : "Decide";
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

/** A completed run a human has not opened yet from the screen. */
function isUnseenDone(run: Run): boolean {
  return run.status === "completed" && !isActive(run) && !run.seenAt;
}

/**
 * Where a run stands on its line: the column of its furthest live step (Done once completed),
 * the columns of every live step, and its tone.
 */
function progress(run: Run): { position: number; marks: number[]; tone: Tone; status: string } {
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
  const at = steps[position] ? stepLabel(steps[position]!.id) : "Done";
  if (run.status === "failed" || run.status === "canceled") return { position, marks, tone: "failed", status: `${run.status === "failed" ? "Failed" : "Canceled"} at ${at}` };
  if (isPaused(run)) return { position, marks, tone: "paused", status: `Paused at ${at}` };
  const gates = pendingGates(run);
  if (gates.length > 0) return { position, marks, tone: "waiting", status: `Ready for you: ${gates.map((gate) => stepLabel(gate.stepId)).join(", ")}` };
  const named = (status: string) => steps.filter((step) => run.steps[step.id]?.status === status).map((step) => stepLabel(step.id));
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

export function PlaybooksScreen(props: PluginScreenProps) {
  const { theme, layout, navigation } = props;
  const workspaces = useWorkspaces();
  const state = useRpc(overviewStateRpc);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [workspaceFilter, setWorkspaceFilter] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const overview = useQuery({
    queryKey: ["playbooks", "overview"],
    queryFn: () => state({}),
    refetchInterval: SCREEN_POLL_MS,
    refetchOnWindowFocus: "always",
  });
  const queryClient = useQueryClient();
  useAgentEvents(null, () => void queryClient.invalidateQueries({ queryKey: ["playbooks", "overview"] }), EVENTS_BATCH_MS);

  const byId = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace])), [workspaces]);
  const names = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace.label])), [workspaces]);
  const allRuns = overview.data?.runs ?? [];
  const projectOf = (run: Run) => byId.get(run.workspaceId)?.projectId ?? run.projectId;
  // Two levels of chips, from every run not archived (working, waiting, failed or done): a project
  // or workspace without one is not listed.
  const projects = chipsOf(allRuns, projectOf, (run) => byId.get(run.workspaceId)?.projectLabel ?? run.projectId);
  const project = projectFilter && projects.some((chip) => chip.id === projectFilter) ? projectFilter : null;
  const inProject = allRuns.filter((run) => !project || projectOf(run) === project);
  const workspaceChips = project ? chipsOf(inProject, (run) => run.workspaceId, (run) => names.get(run.workspaceId) ?? run.workspaceId) : [];
  const scope = workspaceFilter && workspaceChips.some((chip) => chip.id === workspaceFilter) ? workspaceFilter : null;
  // Done runs already opened are listed with Show done; everything else (working, waiting, failed, done and not opened) always.
  const runs = inProject
    .filter((run) => (!scope || run.workspaceId === scope) && (showDone || run.status !== "completed" || isActive(run) || isUnseenDone(run)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const needs = runs.flatMap((run) => pendingGates(run).map((gate) => ({ run, gate })));
  const groups = useMemo(() => {
    const byPlaybook = new Map<string, Run[]>();
    for (const run of runs) byPlaybook.set(run.playbook.id, [...(byPlaybook.get(run.playbook.id) ?? []), run]);
    return [...byPlaybook.entries()].map(([id, list]) => ({ id, runs: list, playbook: list[0]!.playbook }));
  }, [runs]);
  const counts = {
    needsYou: needs.length,
    working: runs.filter((run) => isActive(run) && !isPaused(run) && pendingGates(run).length === 0).length,
    paused: runs.filter((run) => isPaused(run)).length,
    done: runs.filter((run) => run.status === "completed" && !isActive(run)).length,
    failed: runs.filter((run) => run.status === "failed" || run.status === "canceled").length,
  };

  const pad = layout.compact ? 12 : 22;
  const onOpenWorkspace = navigation ? (workspaceId: string) => navigation.openWorkspace({ workspaceId }) : undefined;
  const onOpenAgent = navigation ? (agentId: string) => navigation.openAgent({ agentId }) : undefined;
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <ScrollView contentContainerStyle={{ padding: pad, gap: 18 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 20, fontWeight: "700" }}>
            Playbooks
          </Text>
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
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh playbooks"
            hitSlop={8}
            onPress={() => void queryClient.invalidateQueries({ queryKey: ["playbooks"] })}
          >
            <Icon name="RefreshCw" size={16} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>

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

        {overview.error ? <Text style={{ color: theme.colors.statusDanger }}>{(overview.error as Error).message}</Text> : null}
        {overview.isLoading ? <Text style={{ color: theme.colors.foregroundMuted }}>Loading…</Text> : null}

        {needs.length > 0 ? (
          <View style={{ gap: 8 }}>
            <SectionTitle theme={theme} icon="CircleDot" iconColor={theme.colors.statusWarning} title="Needs you" count={needs.length} />
            <View style={{ borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, overflow: "hidden" }}>
              {needs.map(({ run, gate }, index) => (
                <NeedsYouRow key={gate.id} theme={theme} run={run} gate={gate} first={index === 0} workspace={names.get(run.workspaceId) ?? run.workspaceId} hostLabel={props.host.label} compact={layout.compact} />
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
            names={names}
            onOpenWorkspace={onOpenWorkspace}
            onOpenAgent={onOpenAgent}
          />
        ))}

        {overview.data && groups.length === 0 ? (
          <View style={{ alignItems: "center", gap: 8, paddingVertical: 32 }}>
            <Icon name="Workflow" size={28} color={theme.colors.foregroundMuted} />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, textAlign: "center" }}>
              {showDone ? "No runs yet." : "Nothing new. Show done lists the runs you have opened."}
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

interface ChipInfo {
  id: string;
  label: string;
  needsYou: number;
}

/** One chip per distinct key among these runs, with the gates pending in its runs, sorted by label. */
function chipsOf(runs: Run[], key: (run: Run) => string, label: (run: Run) => string): ChipInfo[] {
  const chips = new Map<string, ChipInfo>();
  for (const run of runs) {
    const id = key(run);
    const chip = chips.get(id) ?? { id, label: label(run), needsYou: 0 };
    chip.needsYou += pendingGates(run).length;
    chips.set(id, chip);
  }
  return [...chips.values()].sort((a, b) => a.label.localeCompare(b.label));
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

function SectionTitle(props: { theme: Theme; title: string; count: number; icon?: string; iconColor?: string; description?: string; extra?: string; extraColor?: string }) {
  const { theme } = props;
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
      {props.icon ? <Icon name={props.icon} size={14} color={props.iconColor ?? theme.colors.foregroundMuted} /> : null}
      <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "700" }}>
        {props.title}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{props.count}</Text>
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
function NeedsYouRow(props: { theme: Theme; run: Run; gate: Gate; first: boolean; workspace: string; hostLabel: string; compact: boolean }) {
  const { theme, run, gate } = props;
  const [open, setOpen] = useState(false);
  const warning = theme.colors.statusWarning;
  const summary = gateText(gate).summary.split("\n")[0] || `${stepLabel(gate.stepId)} is waiting`;
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
            {run.playbook.title} › {stepLabel(gate.stepId)} · {props.workspace} · {runTitle(run)}
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
      </View>
      {open ? (
        <View style={{ paddingHorizontal: 12, paddingBottom: 12, paddingLeft: props.compact ? 12 : 116, maxWidth: 760 }}>
          <GateActions theme={theme} run={run} gate={gate} hostLabel={props.hostLabel} />
        </View>
      ) : null}
    </View>
  );
}

/** Width of a step label above the line; the line is inset by half of it so end labels fit. */
const LABEL_WIDTH = 96;
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
function sortRuns(runs: Run[], key: SortKey): Run[] {
  const byUpdate = (a: Run, b: Run) => b.updatedAt.localeCompare(a.updatedAt);
  const facts = new Map(runs.map((run) => [run.id, progress(run)]));
  const compare = (a: Run, b: Run): number => {
    switch (key) {
      case "started":
        return b.createdAt.localeCompare(a.createdAt);
      case "status":
        return TONE_RANK[facts.get(a.id)!.tone] - TONE_RANK[facts.get(b.id)!.tone];
      case "progress": {
        // Share of the line covered, so runs of an edited playbook with more or fewer steps compare fairly.
        const share = (run: Run) => facts.get(run.id)!.position / Math.max(1, mainSteps(run).length);
        return share(b) - share(a);
      }
      default:
        return 0;
    }
  };
  return [...runs].sort((a, b) => compare(a, b) || byUpdate(a, b));
}

/** "Runs" with the sort of this playbook's rows: a button that opens the choices below it. */
function SortHeading(props: { theme: Theme; value: SortKey; onChange(key: SortKey): void }) {
  const { theme, value } = props;
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<SortKey | null>(null);
  const current = SORTS.find((sort) => sort.key === value)!;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, zIndex: 10 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.4 }}>Runs</Text>
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
  runs: Run[];
  names: Map<string, string>;
  onOpenWorkspace?: (workspaceId: string) => void;
  onOpenAgent?: (agentId: string) => void;
}) {
  const { theme, compact } = props;
  const [sort, setSort] = useState<SortKey>("updated");
  // The most recently updated run's definition gives the columns (runs come in that order);
  // older runs of an edited playbook keep their own steps.
  const playbook = props.runs[0]!.playbook;
  const columns = [...mainSteps(props.runs[0]!).map((step) => stepLabel(step.id)), "Done"];
  const runs = useMemo(() => sortRuns(props.runs, sort), [props.runs, sort]);
  const working = runs.filter((run) => isActive(run) && !isPaused(run) && pendingGates(run).length === 0).length;
  return (
    <View style={{ gap: 8, zIndex: props.zIndex }}>
      <SectionTitle
        theme={theme}
        title={playbook.title}
        count={runs.length}
        description={compact ? undefined : playbook.description}
        extra={working > 0 ? `${working} working` : undefined}
        extraColor={theme.colors.accent}
      />
      {/* No overflow clipping: the sort menu opens over the rows below. */}
      <View style={{ borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.colors.border, zIndex: 10 }}>
          <View style={{ width: compact ? undefined : TITLE_WIDTH, flex: compact ? 1 : undefined }}>
            <SortHeading theme={theme} value={sort} onChange={setSort} />
          </View>
          {compact ? null : (
            <>
              <StepLabels theme={theme} columns={columns} />
              <View style={{ width: 64 }} />
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
            onOpenWorkspace={props.onOpenWorkspace}
            onOpenAgent={props.onOpenAgent}
          />
        ))}
      </View>
    </View>
  );
}

function at(index: number, total: number): `${number}%` {
  return `${total <= 1 ? 0 : (index / (total - 1)) * 100}%`;
}

function StepLabels(props: { theme: Theme; columns: string[] }) {
  const { theme, columns } = props;
  return (
    <View style={{ flex: 1, height: 16, marginHorizontal: LABEL_WIDTH / 2 }}>
      {columns.map((label, index) => (
        <Text
          key={`${label}-${index}`}
          numberOfLines={1}
          style={{ position: "absolute", left: at(index, columns.length), width: LABEL_WIDTH, marginLeft: -LABEL_WIDTH / 2, textAlign: "center", color: theme.colors.foregroundMuted, fontSize: 11 }}
        >
          {label}
        </Text>
      ))}
    </View>
  );
}

function RunRow(props: {
  theme: Theme;
  run: Run;
  first: boolean;
  compact: boolean;
  workspace: string;
  onOpenWorkspace?: (workspaceId: string) => void;
  onOpenAgent?: (agentId: string) => void;
}) {
  const { theme, run, compact } = props;
  const state = progress(run);
  const color = toneColor(theme, state.tone);
  const columns = [...mainSteps(run).map((step) => stepLabel(step.id)), "Done"];
  const markSeen = useRpc(markRunSeenRpc);
  const queryClient = useQueryClient();
  /** Opening a finished run from here marks it seen: a green done run turns grey. */
  const opened = () => {
    if (isActive(run) || run.seenAt) return;
    void markSeen({ runId: run.id })
      .then(() => queryClient.invalidateQueries({ queryKey: ["playbooks", "overview"] }))
      .catch((error: unknown) => console.error("[playbooks] mark seen failed", error));
  };
  const openWorkspace = props.onOpenWorkspace
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
          {ago(run.updatedAt)} · {props.workspace}
        </Text>
      </View>
    </Pressable>
  );
  const actions = (
    <View style={{ width: compact ? undefined : 64, flexDirection: "row", justifyContent: "flex-end", gap: 10 }}>
      {props.onOpenAgent ? (
        <IconButton theme={theme} icon="Bot" label={`Open the Playbook Manager of run ${shortId(run)}`} onPress={() => {
            opened();
            props.onOpenAgent!(run.managerAgentId);
          }} />
      ) : null}
      {props.onOpenWorkspace ? (
        <IconButton theme={theme} icon="SquareArrowOutUpRight" label={`Open workspace ${props.workspace}`} onPress={openWorkspace!} />
      ) : null}
    </View>
  );
  return (
    <View style={{ borderTopWidth: props.first ? 0 : 1, borderTopColor: theme.colors.border, paddingHorizontal: 12, paddingVertical: 10, gap: 8 }}>
      {compact ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
            {title}
            {actions}
          </View>
          <StepLabels theme={theme} columns={columns} />
          <ProgressLine theme={theme} total={columns.length} position={state.position} marks={state.marks} color={color} moving={isMoving(state.tone)} />
        </>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          {title}
          <ProgressLine theme={theme} total={columns.length} position={state.position} marks={state.marks} color={color} moving={isMoving(state.tone)} />
          {actions}
        </View>
      )}
    </View>
  );
}

function IconButton(props: { theme: Theme; icon: string; label: string; onPress(): void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={props.label} hitSlop={6} onPress={props.onPress}>
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
