import { openExternalUrl, useRpc, useTabState, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { z } from "zod";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, Text, View } from "react-native";
import { archiveRunRpc, cancelRunRpc, listPlaybooks, listRuns } from "../shared/contracts";
import { isTerminal, type Playbook, type PlaybookEntry, type Run } from "../shared/types";
import { Graph, useReduceMotion } from "./graph";
import { Button, StepSheet } from "./sheet";
import { StartForm, type StartTarget } from "./start-form";
import { splitError } from "../shared/errors";
import { runStatusColor, runStatusLabel, withAlpha, type Theme } from "./theme";

interface Card {
  id: string;
  entry: PlaybookEntry | null;
  runs: Run[];
}

export function PlaybooksPanel(props: PluginWorkspacePanelProps) {
  const { theme, layout, workspaceId, navigation } = props;
  const list = useRpc(listPlaybooks);
  const runsRpc = useRpc(listRuns);
  const playbooks = useQuery({
    queryKey: ["playbooks", "definitions", workspaceId],
    queryFn: () => list({ workspaceId }),
    refetchInterval: 30_000,
  });
  const runs = useQuery({
    queryKey: ["playbooks", "runs", workspaceId],
    queryFn: () => runsRpc({ workspaceId }),
    // Runs change from outside the panel (managers, other tabs): poll often, faster while one is active.
    refetchInterval: (query) => (query.state.data?.runs.some((run) => !isTerminal(run.status)) ? 2_000 : 5_000),
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: "always",
  });
  const queryClient = useQueryClient();
  /** Completed runs whose tab was opened: they turn from green to grey, like read conversations in Paseo. */
  const [readRuns, setReadRuns] = useTabState(props.tab, z.array(z.string()), []);
  const markRead = (runId: string) => {
    if (!readRuns.includes(runId)) setReadRuns([...readRuns, runId].slice(-200));
  };

  const cards = useMemo<Card[]>(() => {
    const entries = playbooks.data?.entries ?? [];
    const allRuns = runs.data?.runs ?? [];
    const ids = [...new Set([...entries.map((entry) => entry.id), ...allRuns.map((run) => run.playbook.id)])];
    return ids.map((id) => ({
      id,
      entry: entries.find((entry) => entry.id === id) ?? null,
      runs: allRuns.filter((run) => run.playbook.id === id),
    }));
  }, [playbooks.data, runs.data]);

  const pad = layout.compact ? 12 : 16;
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      {/* No heading: the tab already says "Playbooks". */}
      <View style={{ flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: pad, paddingVertical: 8 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh playbooks"
          hitSlop={8}
          onPress={() => void queryClient.invalidateQueries({ queryKey: ["playbooks"] })}
        >
          <Icon name="RefreshCw" size={16} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
      {playbooks.data && cards.length === 0 ? (
        <EmptyState theme={theme} compact={layout.compact} />
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: pad, paddingBottom: pad, gap: 12 }}>
          {playbooks.isLoading ? <Text style={{ color: theme.colors.foregroundMuted }}>Loading…</Text> : null}
          {playbooks.error ? <Text style={{ color: theme.colors.statusDanger }}>{(playbooks.error as Error).message}</Text> : null}
          {cards.map((card, index) => (
            <PlaybookCard
              key={card.id}
              // Earlier cards stack above later ones, so a card's dropdown menus are not covered by the cards below it.
              zIndex={cards.length - index}
              card={card}
              compact={layout.compact}
              theme={theme}
              workspaceId={workspaceId}
              hostLabel={props.host.label}
              onOpenAgent={(agentId) => navigation?.openAgent({ agentId })}
              onOpenWorkspace={(id) => navigation?.openWorkspace({ workspaceId: id })}
              readRuns={readRuns}
              onRead={markRead}
            />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

/** Where "Get started" sends people when a workspace has no playbooks. */
export const GETTING_STARTED_URL = "https://lerenn.github.io/paseo-playbooks/getting-started.html";

function EmptyState(props: { theme: Theme; compact: boolean }) {
  const { theme } = props;
  const toast = useToast();
  const open = () =>
    void openExternalUrl(GETTING_STARTED_URL).catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: props.compact ? 16 : 24, gap: 12 }}>
      <Icon name="Workflow" size={32} color={theme.colors.foregroundMuted} />
      <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600", textAlign: "center" }}>No playbooks in this workspace</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, textAlign: "center", maxWidth: 320 }}>
        Add playbooks to .paseo/plugins/playbooks/ or .paseo/playbooks/, then refresh.
      </Text>
      <Button theme={theme} kind="primary" label="How to use playbooks ↗" onPress={open} accessibilityLabel="Open the getting started guide in your browser" />
    </View>
  );
}

/** Inner padding of a playbook card. */
const CARD_PAD = 10;

function PlaybookCard(props: {
  zIndex: number;
  compact: boolean;
  card: Card;
  theme: Theme;
  workspaceId: string;
  hostLabel: string;
  onOpenAgent(agentId: string): void;
  onOpenWorkspace(workspaceId: string): void;
  readRuns: string[];
  onRead(runId: string): void;
}) {
  const { card, theme } = props;
  const queryClient = useQueryClient();
  const active = card.runs.find((run) => !isTerminal(run.status));
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<string | "definition" | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [starting, setStarting] = useState<StartTarget | null>(null);
  // A selected run that disappeared (archived) falls back to the default tab.
  const current = selected === "definition" || card.runs.some((candidate) => candidate.id === selected) ? selected : null;
  const runId = current ?? active?.id ?? card.runs[0]?.id ?? "definition";
  const run = runId === "definition" ? null : card.runs.find((candidate) => candidate.id === runId) ?? null;
  const playbook: Playbook | null = run?.playbook ?? card.entry?.playbook ?? null;
  const title = playbook?.title ?? card.entry?.title ?? card.id;
  const errors = card.entry?.errors ?? [];

  return (
    <View style={{ zIndex: props.zIndex, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, padding: CARD_PAD, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, zIndex: 20 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${title}`}
          onPress={() => setExpanded((value) => !value)}
          style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6 }}
        >
          <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={14} color={theme.colors.foregroundMuted} />
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>
              {title}
            </Text>
            <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {card.entry?.file ?? "(file removed)"}
              {playbook?.concurrency ? ` · concurrency ${playbook.concurrency}` : ""}
            </Text>
          </View>
        </Pressable>
        {card.runs.length > 0 ? (
          <RunDots
            theme={theme}
            runs={card.runs}
            readRuns={props.readRuns}
            onOpen={(run) => {
              setExpanded(true);
              setSelected(run.id);
              if (run.status === "completed") props.onRead(run.id);
            }}
          />
        ) : null}
        {card.entry?.playbook ? <StartButton theme={theme} title={title} onStart={setStarting} /> : null}
      </View>
      {errors.length > 0 ? <ErrorCallout theme={theme} file={card.entry?.file ?? ""} errors={errors} /> : null}
      {expanded && card.runs.length > 0 ? (
        // Full-width rule between the title row and the run tabs (the card has CARD_PAD padding).
        <View style={{ height: 1, marginTop: 4, marginHorizontal: -CARD_PAD, backgroundColor: theme.colors.border }} />
      ) : null}
      {expanded && card.runs.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, zIndex: 15 }}>
          {card.entry?.playbook ? (
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: runId === "definition" }}
              onPress={() => setSelected("definition")}
              style={{
                borderRadius: 10,
                borderWidth: 1,
                borderColor: theme.colors.foregroundMuted,
                backgroundColor: runId === "definition" ? theme.colors.foregroundMuted : "transparent",
                paddingHorizontal: 8,
                paddingVertical: 2,
              }}
            >
              <Text style={{ color: runId === "definition" ? theme.colors.surface1 : theme.colors.foregroundMuted, fontSize: 11 }}>Definition</Text>
            </Pressable>
          ) : null}
          {card.runs.map((candidate) => (
            <RunChip
              key={candidate.id}
              theme={theme}
              run={candidate}
              selected={candidate.id === runId}
              read={props.readRuns.includes(candidate.id)}
              onSelect={() => {
                setSelected(candidate.id);
                if (candidate.status === "completed") props.onRead(candidate.id);
              }}
              onCanceled={() => void queryClient.invalidateQueries({ queryKey: ["playbooks"] })}
              onOpenManager={() => props.onOpenAgent(candidate.managerAgentId)}
            />
          ))}
        </View>
      ) : null}
      {expanded && run ? <RunBar theme={theme} run={run} hostLabel={props.hostLabel} /> : null}
      {expanded && playbook ? (
        <Graph
          playbook={playbook}
          run={run}
          theme={theme}
          highlighted={highlighted}
          onHighlight={setHighlighted}
          onOpenAgent={props.onOpenAgent}
          onOpenSheet={setSheet}
          hostLabel={props.hostLabel}
        />
      ) : null}
      {sheet && playbook ? (
        <StepSheet
          theme={theme}
          playbook={playbook}
          run={run}
          stepId={sheet}
          hostLabel={props.hostLabel}
          onClose={() => setSheet(null)}
          onOpenAgent={(agentId) => {
            setSheet(null);
            props.onOpenAgent(agentId);
          }}
        />
      ) : null}
      {starting && card.entry?.playbook ? (
        <StartForm
          theme={theme}
          playbook={card.entry.playbook}
          workspaceId={props.workspaceId}
          target={starting}
          compact={props.compact}
          onClose={() => setStarting(null)}
          onStarted={(result) => {
            setStarting(null);
            void queryClient.invalidateQueries({ queryKey: ["playbooks"] });
            if (result.sameWorkspace) props.onOpenAgent(result.managerAgentId);
            else props.onOpenWorkspace(result.workspaceId);
          }}
        />
      ) : null}
    </View>
  );
}

function RunBar(props: { theme: Theme; run: Run; hostLabel: string }) {
  const { theme, run } = props;
  return (
    <View style={{ gap: 6 }}>
      {run.failure ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{run.failure}</Text> : null}
      {run.status === "completed" && run.playbook.next.length > 0 ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          Next offered to the manager: {run.playbook.next.map((next) => next.playbook).join(", ")}
        </Text>
      ) : null}
    </View>
  );
}

/** Split button: Start runs with the workspace's agent; the chevron menu offers a new agent here, or a new workspace. */
/** The Start button's menu: other ways to start than the workspace's current agent. */
const START_OPTIONS = [
  { target: "agent", label: "Start on a new agent", icon: "Bot" },
  { target: "workspace", label: "Start in a new workspace", icon: "GitBranchPlus" },
] as const;

function StartButton(props: { theme: Theme; title: string; onStart(target: StartTarget): void }) {
  const { theme } = props;
  const [menu, setMenu] = useState(false);
  const [hover, setHover] = useState<StartTarget | null>(null);
  const segment = { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 7, backgroundColor: theme.colors.accent } as const;
  return (
    <View style={{ zIndex: 20 }}>
      <View style={{ flexDirection: "row", borderRadius: 8, overflow: "hidden" }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Start ${props.title} with this workspace's agent`}
          onPress={() => props.onStart("current")}
          style={{ ...segment, paddingLeft: 12, paddingRight: 10 }}
        >
          <Icon name="Play" size={13} color={theme.colors.accentForeground} />
          <Text style={{ color: theme.colors.accentForeground, fontSize: 13, fontWeight: "600" }}>Start</Text>
        </Pressable>
        <View style={{ width: 1, backgroundColor: theme.colors.accentForeground, opacity: 0.25 }} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`More ways to start ${props.title}`}
          accessibilityState={{ expanded: menu }}
          onPress={() => setMenu((value) => !value)}
          style={{ ...segment, paddingHorizontal: 8 }}
        >
          <Icon name="ChevronDown" size={14} color={theme.colors.accentForeground} />
        </Pressable>
      </View>
      {menu ? (
        <View
          accessibilityRole="menu"
          style={{
            position: "absolute",
            top: 38,
            right: 0,
            minWidth: 200,
            padding: 4,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface2,
            elevation: 6,
          }}
        >
          {START_OPTIONS.map((option) => (
            <Pressable
              key={option.target}
              accessibilityRole="menuitem"
              onPress={() => {
                setMenu(false);
                props.onStart(option.target);
              }}
              onHoverIn={() => setHover(option.target)}
              onHoverOut={() => setHover((current) => (current === option.target ? null : current))}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 10,
                paddingVertical: 8,
                borderRadius: 6,
                backgroundColor: hover === option.target ? theme.colors.surface1 : "transparent",
              }}
            >
              <Icon name={option.icon} size={15} color={theme.colors.foreground} />
              <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{option.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** A run tab with a chevron menu: the run's details (branch, start, inputs, manager), then Cancel for active runs. */
function RunChip(props: { theme: Theme; run: Run; selected: boolean; read: boolean; onSelect(): void; onCanceled(): void; onOpenManager(): void }) {
  const { theme, run, selected } = props;
  const cancel = useRpc(cancelRunRpc);
  const archive = useRpc(archiveRunRpc);
  const toast = useToast();
  const [menu, setMenu] = useState<"closed" | "open" | "confirm">("closed");
  // Blue running, yellow waiting for a decision, green done, grey done and opened, red failed.
  const color = run.status === "completed" && props.read ? theme.colors.foregroundMuted : runStatusColor(theme, run.status);
  const active = !isTerminal(run.status);
  // Selected: filled with the colour. Not selected: outlined in it.
  const border = color;
  const text = selected ? (color === theme.colors.foregroundMuted ? theme.colors.surface1 : theme.colors.accentForeground) : color;
  return (
    <View style={{ zIndex: menu === "closed" ? 0 : 30 }}>
      <View style={{ flexDirection: "row", borderRadius: 10, borderWidth: 1, borderColor: border, backgroundColor: selected ? color : "transparent", overflow: "hidden" }}>
        <Pressable accessibilityRole="tab" accessibilityState={{ selected }} onPress={props.onSelect} style={{ paddingLeft: 8, paddingRight: 6, paddingVertical: 2 }}>
          <Text style={{ color: text, fontSize: 11 }}>
            {run.id.replace(/^run_/, "")} · {runStatusLabel(run.status)}
          </Text>
        </Pressable>
        {(
          <>
            <View style={{ width: 1, backgroundColor: selected ? text : border, opacity: selected ? 0.35 : 1 }} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Details and actions for run ${run.id}`}
              accessibilityState={{ expanded: menu !== "closed" }}
              onPress={() => setMenu((value) => (value === "closed" ? "open" : "closed"))}
              style={{ paddingHorizontal: 5, justifyContent: "center" }}
            >
              <Icon name="ChevronDown" size={12} color={text} />
            </Pressable>
          </>
        )}
      </View>
      {menu !== "closed" ? (
        <View
          accessibilityRole="menu"
          style={{
            position: "absolute",
            top: 26,
            left: 0,
            minWidth: 240,
            maxWidth: 360,
            padding: 4,
            gap: 4,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface2,
            elevation: 6,
          }}
        >
          {menu === "open" ? (
            <>
            <View style={{ paddingHorizontal: 10, paddingTop: 6, gap: 4 }}>
              {[
                ["Branch", run.branch ?? "(unknown)"],
                ["Started", new Date(run.createdAt).toLocaleString()],
              ].map(([label, value]) => (
                <View key={label} style={{ flexDirection: "row", gap: 10 }}>
                  <Text style={{ width: 56, color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
                  <Text selectable style={{ flex: 1, color: theme.colors.foreground, fontSize: 12 }}>{value}</Text>
                </View>
              ))}
              {Object.keys(run.inputs).length > 0 ? (
                <>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Inputs</Text>
                  <View style={{ borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border }}>
                    {Object.entries(run.inputs).map(([name, value], index) => (
                      <View
                        key={name}
                        style={{ flexDirection: "row", gap: 10, paddingHorizontal: 8, paddingVertical: 4, borderTopWidth: index === 0 ? 0 : 1, borderTopColor: theme.colors.border }}
                      >
                        <Text style={{ width: 80, color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>{name}</Text>
                        <Text selectable style={{ flex: 1, color: theme.colors.foreground, fontSize: 12 }}>{String(value)}</Text>
                      </View>
                    ))}
                  </View>
                </>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="menuitem"
              onPress={() => {
                setMenu("closed");
                props.onOpenManager();
              }}
              style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6 }}
            >
              <Icon name="ExternalLink" size={15} color={theme.colors.accent} />
              <Text style={{ color: theme.colors.accent, fontSize: 13 }}>Open the Playbook Manager</Text>
            </Pressable>
            {active ? (
            <>
            <View style={{ height: 1, backgroundColor: theme.colors.border }} />
            <Pressable
              accessibilityRole="menuitem"
              onPress={() => setMenu("confirm")}
              style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6 }}
            >
              <Icon name="CircleStop" size={15} color={theme.colors.statusDanger} />
              <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>Cancel run…</Text>
            </Pressable>
            </>
            ) : (
            <>
            <View style={{ height: 1, backgroundColor: theme.colors.border }} />
            <Pressable
              accessibilityRole="menuitem"
              accessibilityHint="Hides the run from this panel. Its agents and saved state are kept."
              onPress={() =>
                void archive({ runId: run.id })
                  .then(() => {
                    setMenu("closed");
                    props.onCanceled();
                  })
                  .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
              }
              style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6 }}
            >
              <Icon name="Archive" size={15} color={theme.colors.foreground} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>Archive run</Text>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Hides it here; agents are kept</Text>
              </View>
            </Pressable>
            </>
            )}
            </>
          ) : (
            <View style={{ padding: 6, gap: 8 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>Cancel run {run.id}? Running steps are stopped.</Text>
              <View style={{ flexDirection: "row", gap: 6 }}>
                <Button
                  theme={theme}
                  kind="danger"
                  label="Cancel run"
                  onPress={() =>
                    void cancel({ runId: run.id })
                      .then(() => {
                        setMenu("closed");
                        props.onCanceled();
                      })
                      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
                  }
                />
                <Button theme={theme} label="Keep" onPress={() => setMenu("closed")} />
              </View>
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}

/** A playbook's validation errors as one callout: a heading, then each problem with its location in bold. */
function ErrorCallout(props: { theme: Theme; file: string; errors: string[] }) {
  const { theme } = props;
  const danger = theme.colors.statusDanger;
  return (
    <View
      accessibilityRole="alert"
      style={{
        borderRadius: 8,
        borderLeftWidth: 3,
        borderLeftColor: danger,
        backgroundColor: withAlpha(danger, 0.1) ?? theme.colors.surface2,
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="TriangleAlert" size={15} color={danger} />
        <Text style={{ flex: 1, color: danger, fontSize: 13, fontWeight: "600" }}>
          This playbook can't run · {props.errors.length} {props.errors.length === 1 ? "problem" : "problems"}
        </Text>
      </View>
      {props.errors.map((error) => {
        const { where, message } = splitError(props.file, error);
        return (
          <View key={error} style={{ gap: 2, paddingLeft: 23 }}>
            {where ? <Text selectable style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>{where}</Text> : null}
            <Text selectable style={{ color: theme.colors.foreground, fontSize: 12, lineHeight: 18 }}>
              {message}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** Most runs shown as dots in a card header; older ones stay reachable through the run tabs. */
const MAX_DOTS = 8;

/**
 * One dot per run, left of Start, like Paseo's conversation dots: blue and pulsing while running,
 * yellow and pulsing while a gate waits, green when done and not yet opened, grey once opened,
 * red when failed or canceled. Pressing a dot opens the card on that run.
 */
function RunDots(props: { theme: Theme; runs: Run[]; readRuns: string[]; onOpen(run: Run): void }) {
  const runs = [...props.runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-MAX_DOTS);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginRight: 4 }}>
      {runs.map((run) => (
        <RunDot key={run.id} theme={props.theme} run={run} read={props.readRuns.includes(run.id)} onPress={() => props.onOpen(run)} />
      ))}
    </View>
  );
}

function RunDot(props: { theme: Theme; run: Run; read: boolean; onPress(): void }) {
  const { theme, run } = props;
  const reduceMotion = useReduceMotion();
  const pulsing = (run.status === "running" || run.status === "waiting_gate") && !reduceMotion;
  const color = run.status === "completed" && props.read ? theme.colors.foregroundMuted : runStatusColor(theme, run.status);
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!pulsing) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.3, duration: 800, useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulsing, pulse]);
  const label = `Run ${run.id.replace(/^run_/, "")}, ${run.status === "completed" && !props.read ? "completed, not opened yet" : runStatusLabel(run.status)}. Opens it.`;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} hitSlop={6} onPress={props.onPress} style={{ padding: 3 }}>
      <View style={{ width: 10, height: 10, alignItems: "center", justifyContent: "center" }}>
        {pulsing ? (
          <Animated.View
            style={{
              position: "absolute",
              width: 10,
              height: 10,
              borderRadius: 5,
              backgroundColor: color,
              opacity: pulse.interpolate({ inputRange: [0.3, 1], outputRange: [0.15, 0.45] }),
              transform: [{ scale: pulse.interpolate({ inputRange: [0.3, 1], outputRange: [1.6, 1] }) }],
            }}
          />
        ) : null}
        <Animated.View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color, opacity: pulsing ? pulse.interpolate({ inputRange: [0.3, 1], outputRange: [0.6, 1] }) : 1 }} />
      </View>
    </Pressable>
  );
}
