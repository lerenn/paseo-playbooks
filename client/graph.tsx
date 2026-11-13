import { openExternalUrl, useAgent, useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Pressable, Text, View } from "react-native";
import { Button, GateActions } from "./sheet";
import { startAfterTaskRpc } from "../shared/contracts";
import { askChoices, waitsForHuman } from "../shared/gates";
import { blockStats, blockStatus, collapseNodes, EMPTY_COLLAPSE, isCollapsed, markSeen, progressText, toggled, type BlockStats, type BlockStatus, type CollapseState } from "../shared/collapse";
import { clearOfHeaders, frameRects, HEADER_H, layerHeadroom, type Box, type FrameRect } from "../shared/frames";
import { END, layerOf, layoutGraph, START, withTerminals } from "../shared/graph";
import { isTerminal, type AfterTask, type Playbook, type Run, type Step } from "../shared/types";
import { activeStep, assignLanes, badgeText, groupLoops, loopText, relatedLoops, visibleAttempts, type LoopEdge, type LoopGroup } from "./loops";
import { conditionText } from "../shared/labels";
import { runningFor } from "../shared/elapsed";
import { slowDetail, type SlowInfo } from "../shared/slow";
import { useNow } from "./now";
import { agentBackground, gateBackground, stepTitle, nodeColor, nodeIcon, nodeStateLabel, STEP_KINDS, type NodeState, type Theme } from "./theme";

/** Nodes grow with the panel between these widths; below the minimum the graph scrolls sideways. */
const NODE_MIN = 132;
const NODE_MAX = 240;
const GAP = 14;
const BAND_H = 32;
/** Edge thickness and arrowhead size, in px. */
const EDGE_STROKE = 2;
const ARROW = 14;
/** Loop back-edges: lanes on the right of the graph, drawn as thin dotted grey lines (white when highlighted). */
const LANE_GAP = 10;
const LOOP_STROKE = 1;
const LOOP_STROKE_ON = 2;
const DOT = 2;
const DOT_GAP = 4;
const LOOP_LABEL_H = 14;

/** For steps that can also loop back: the outcomes that continue forward, shown on the forward edge. */
function forwardLabels(steps: readonly Step[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const step of steps) {
    if (!Object.values(step.on).some((transition) => transition.kind === "goto")) continue;
    const forward = step.outcomes.filter((outcome) => (step.on[outcome]?.kind ?? "complete") === "complete");
    if (forward.length > 0) labels.set(step.id, forward.join(" / "));
  }
  return labels;
}

function loopEdges(steps: readonly Step[], run: Run | null): LoopEdge[] {
  return steps.flatMap((step) =>
    Object.entries(step.on).flatMap(([outcome, transition]) => {
      if (transition.kind === "goto") {
        return [{ from: step.id, to: transition.target, outcome, count: run?.loops[`${step.id}->${transition.target}`] ?? 0, max: transition.maxLoops }];
      }
      if (transition.kind !== "ask") return [];
      // One edge per ask target other than the step itself, labelled with the choices that take it.
      // A choice with `outcome` goes on like that outcome: no loop edge.
      const byTarget = new Map<string, { ids: string[]; max: number | undefined }>();
      for (const choice of askChoices(transition)) {
        if (choice.target === step.id || choice.outcome !== undefined) continue;
        const edge = byTarget.get(choice.target) ?? { ids: [], max: choice.maxLoops };
        edge.ids.push(choice.id);
        byTarget.set(choice.target, edge);
      }
      const multi = (transition.choices?.length ?? 0) > 0;
      return [...byTarget].map(([to, edge]) => ({
        from: step.id,
        to,
        outcome: multi ? `${outcome}: ${edge.ids.join(" / ")}` : outcome,
        count: run?.loops[`${step.id}->${to}`] ?? 0,
        max: edge.max,
      }));
    }),
  );
}

export interface GraphProps {
  playbook: Playbook;
  run: Run | null;
  theme: Theme;
  highlighted: string | null;
  onOpenAgent(agentId: string): void;
  onOpenSheet(stepId: string): void;
  onHighlight(stepId: string | null): void;
  /** Host label recorded with gate decisions made in a node. */
  hostLabel: string;
  /** Steps that run longer than usual, by step id (the slow-step warning). */
  slow?: Record<string, SlowInfo>;
}

export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => alive && setReduce(value))
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  return reduce;
}

/** The main graph between Start and End, then the after-tasks below it, each in its own frame. */
export function Graph(props: GraphProps) {
  const [available, setAvailable] = useState(0);
  const main = useMemo(() => props.playbook.steps.filter((step) => !step.afterTask), [props.playbook]);
  return (
    <View onLayout={(event) => setAvailable(event.nativeEvent.layout.width)}>
      <Dag {...props} steps={main} terminals available={available} />
      {props.playbook.after.length > 0 ? <AfterTasks {...props} available={available} /> : null}
    </View>
  );
}

/** Layered top-down DAG built from plain views: nodes in rows, org-chart connectors between rows. */
function Dag(props: GraphProps & { steps: Step[]; terminals: boolean; available: number }) {
  const { playbook, run, theme, steps, available } = props;
  // An after-task's own frame already holds its sub-playbook: no second frame for it.
  const blocks = useMemo(
    () => Object.fromEntries(Object.entries(playbook.blocks).filter(([prefix]) => !playbook.after.some((task) => task.id === prefix))),
    [playbook],
  );
  // Sub-playbooks fold into one node each (ADR 2026-11-13-collapsible-sub-playbooks).
  const stats = useMemo(() => {
    const ids = steps.map((step) => step.id);
    return Object.fromEntries(
      Object.keys(blocks).map((prefix) => [
        prefix,
        blockStats(prefix, ids, (id) => {
          const state = run?.steps[id];
          return state ? { status: state.status, startedAt: state.attempts.map((attempt) => attempt.startedAt) } : undefined;
        }),
      ]),
    );
  }, [blocks, steps, run]);
  const [collapseStates, setCollapseStates] = useState<Record<string, CollapseState>>({});
  const runKey = run?.id ?? "definition";
  const collapse = collapseStates[runKey] ?? EMPTY_COLLAPSE;
  useEffect(() => {
    setCollapseStates((current) => {
      const before = current[runKey] ?? EMPTY_COLLAPSE;
      const after = markSeen(before, stats);
      return after === before ? current : { ...current, [runKey]: after };
    });
  }, [stats, runKey]);
  const collapsedKey = Object.keys(blocks)
    .filter((prefix) => stats[prefix]!.total > 0 && isCollapsed(prefix, stats[prefix]!, collapse, run !== null))
    .join("|");
  const collapsedSet = useMemo(() => new Set(collapsedKey ? collapsedKey.split("|") : []), [collapsedKey]);
  const folded = useMemo(() => collapseNodes(steps, collapsedSet), [steps, collapsedSet]);
  const setCollapsed = (prefix: string, collapsed: boolean) => setCollapseStates((current) => ({ ...current, [runKey]: toggled(current[runKey] ?? EMPTY_COLLAPSE, prefix, collapsed) }));
  // Start and End are laid out like steps: Start above the roots, End below every step nothing needs.
  const nodes = useMemo(() => (props.terminals ? withTerminals(folded.nodes) : folded.nodes), [folded, props.terminals]);
  const needsOf = useMemo(() => new Map(folded.nodes.map((node) => [node.id, node.needs])), [folded]);
  const layout = useMemo(() => layoutGraph(nodes), [nodes]);
  const layers = useMemo(() => layerOf(nodes), [nodes]);
  const loops = useMemo(
    () =>
      loopEdges(steps, run)
        .map((loop) => ({ ...loop, from: folded.nodeOf(loop.from), to: folded.nodeOf(loop.to) }))
        .filter((loop) => loop.from !== loop.to),
    [steps, run, folded],
  );
  const forward = useMemo(() => forwardLabels(steps), [steps]);
  const groups = useMemo(() => groupLoops(loops), [loops]);
  /** The loop badge tapped (its group key): its target is outlined and its outcomes listed. */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedGroup = groups.find((group) => group.key === selectedKey) ?? null;
  /** The step whose loop lines are white: hovered (web, desktop) or pinned by a tap (touch has no hover). */
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const active = activeStep(hovered, pinned);
  const onKeys = useMemo(() => relatedLoops(groups, active), [groups, active]);
  const { lanes, count: laneCount } = useMemo(() => assignLanes(groups, (id) => layers.get(id) ?? 0), [groups, layers]);
  /** Room on each side for the one back-edge lane (both sides, so the graph stays centred). */
  const gutter = groups.length > 0 ? 6 + laneCount * LANE_GAP : 0;
  const columns = Math.max(1, ...layout.layers.map((row) => row.length));
  const nodeWidth = Math.max(NODE_MIN, Math.min(NODE_MAX, Math.floor((available - 2 * gutter) / columns) - GAP));
  const SLOT = nodeWidth + GAP;
  const width = columns * SLOT;
  /** Measured top of each layer (relative to the graph) and height of each node box. */
  const [layerTops, setLayerTops] = useState<Record<number, number>>({});
  const [heights, setHeights] = useState<Record<string, number>>({});
  const centers = useMemo(() => {
    const result = new Map<string, number>();
    for (const row of layout.layers) {
      const offset = (width - row.length * SLOT) / 2;
      row.forEach((id, index) => result.set(id, offset + index * SLOT + SLOT / 2));
    }
    return result;
  }, [layout, width, SLOT]);
  const byId = useMemo(() => new Map(steps.map((step) => [step.id, step])), [steps]);
  /** Steps with a pending decision: their node widens to the graph's width, alone in its row, to hold the choices. */
  const deciding = new Set(run ? run.gates.filter(waitsForHuman).map((gate) => gate.stepId) : []);
  /** Actual width of each node, so loop lines meet its edge. */
  const widthOf = (id: string): number => {
    const row = layout.layers.find((candidate) => candidate.includes(id));
    return deciding.has(id) && row?.length === 1 ? Math.max(nodeWidth, width - GAP) : nodeWidth;
  };
  /** Expanded sub-playbooks that have nodes on screen, and the room their headers need above their first layer. */
  const shown = useMemo(
    () =>
      Object.keys(blocks)
        .filter((prefix) => !collapsedSet.has(prefix))
        .map((prefix) => ({ prefix, ids: folded.nodes.map((node) => node.id).filter((id) => id.startsWith(`${prefix}.`)) }))
        .filter((block) => block.ids.length > 0),
    [blocks, collapsedSet, folded],
  );
  const heads = useMemo(() => layerHeadroom(shown.map((block) => ({ prefix: block.prefix, layer: Math.min(...block.ids.map((id) => layers.get(id) ?? 0)) }))), [shown, layers]);
  /** Top of a layer's nodes: below its header room and, past the first layer, its edge band. */
  const nodeTopOf = (layer: number, layerTop: number) => layerTop + (layer > 0 ? BAND_H : 0) + (heads.get(layer) ?? 0);
  const frames = useMemo(() => {
    const inputs: Array<{ prefix: string; members: Box[] }> = [];
    for (const block of shown) {
      const members: Box[] = [];
      for (const id of block.ids) {
        const layer = layers.get(id) ?? 0;
        const layerTop = layerTops[layer];
        const height = heights[id];
        if (layerTop === undefined || !height) return [];
        const top = nodeTopOf(layer, layerTop);
        const center = gutter + (centers.get(id) ?? 0);
        members.push({ left: center - widthOf(id) / 2, right: center + widthOf(id) / 2, top, bottom: top + height });
      }
      inputs.push({ prefix: block.prefix, members });
    }
    return frameRects(inputs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, layers, layerTops, heights, centers, heads, gutter, nodeWidth, width]);
  const running = new Set(run ? steps.filter((step) => run.steps[step.id]?.status === "running").map((step) => folded.nodeOf(step.id)) : []);

  return (
    <ScrollView horizontal style={{ flexGrow: 0 }} contentContainerStyle={{ minWidth: "100%", justifyContent: "center" }}>
      <View style={{ width: width + 2 * gutter, paddingHorizontal: gutter, paddingTop: 4, paddingBottom: 16 }}>
        <BlockFrames theme={theme} frames={frames} />
        <LoopLines
          theme={theme}
          groups={groups.filter((group) => !onKeys.has(group.key))}
          lanes={lanes}
          on={false}
          layers={layers}
          layerTops={layerTops}
          heights={heights}
          centers={centers}
          offset={gutter}
          widthOf={widthOf}
          nodeTopOf={nodeTopOf}
          laneStart={gutter + width + 6}
        />
        {layout.layers.map((row, index) => (
          <View
            key={row.join(",")}
            onLayout={(event) => {
              const y = event.nativeEvent.layout.y;
              setLayerTops((current) => (current[index] === y ? current : { ...current, [index]: y }));
            }}
          >
            {index === 0 && (heads.get(0) ?? 0) > 0 ? <View style={{ height: heads.get(0) }} /> : null}
            {index > 0 ? (
              <Band
                theme={theme}
                width={width}
                extra={heads.get(index) ?? 0}
                headers={frames.map((frame) => ({ left: frame.header.left - gutter, right: frame.header.right - gutter, top: frame.header.top - (layerTops[index] ?? 0), bottom: frame.header.bottom - (layerTops[index] ?? 0) }))}
                edges={layout.edges.filter((edge) => layers.get(edge.from) === index - 1 && layers.get(edge.to) === index)}
                centers={centers}
                running={running}
                labels={forward}
              />
            ) : null}
            <View style={{ flexDirection: "row", justifyContent: "center" }}>
              {row.map((id) => (
                <View key={id} style={{ width: SLOT, alignItems: "center" }}>
                  {id === START || id === END ? (
                    <Terminal
                      kind={id === START ? "start" : "end"}
                      playbook={playbook}
                      run={run}
                      theme={theme}
                      nodeWidth={nodeWidth}
                      areaWidth={Math.max(nodeWidth, width - GAP)}
                      longNeeds={id === END ? nodes.find((node) => node.id === END)!.needs.filter((need) => (layers.get(need) ?? 0) < index - 1) : []}
                    />
                  ) : folded.prefixes.has(id) ? (
                    <GroupNode
                      theme={theme}
                      title={blocks[folded.prefixes.get(id)!]?.title ?? id}
                      stats={stats[folded.prefixes.get(id)!]!}
                      depth={folded.prefixes.get(id)!.split(".").length - 1}
                      nodeWidth={nodeWidth}
                      longNeeds={(needsOf.get(id) ?? []).filter((need) => (layers.get(need) ?? 0) < index - 1)}
                      onToggle={() => setCollapsed(folded.prefixes.get(id)!, false)}
                      onBoxHeight={(height) => setHeights((current) => (current[id] === height ? current : { ...current, [id]: height }))}
                    />
                  ) : (
                  <Node
                    step={byId.get(id)!}
                    longNeeds={(needsOf.get(id) ?? []).filter((need) => (layers.get(need) ?? 0) < index - 1)}
                    nodeWidth={widthOf(id)}
                    loops={loops.filter((loop) => loop.from === id)}
                    loopGroups={groups.filter((group) => group.from === id)}
                    titleOf={(target) => (byId.get(target) ? stepTitle(byId.get(target)!) : blocks[folded.prefixes.get(target) ?? ""]?.title ?? target)}
                    selectedLoop={selectedKey}
                    loopTarget={selectedGroup?.to === id}
                    inLoops={groups.some((group) => group.from === id || group.to === id)}
                    pinned={pinned === id}
                    onHover={(over) => setHovered((current) => (over ? id : current === id ? null : current))}
                    onTogglePin={() => setPinned((current) => (current === id ? null : id))}
                    onToggleLoop={(key) => {
                      const from = groups.find((group) => group.key === key)?.from ?? null;
                      const clear = selectedKey === key;
                      setSelectedKey(clear ? null : key);
                      setPinned(clear ? null : from);
                    }}
                    onBoxHeight={(height) => setHeights((current) => (current[id] === height ? current : { ...current, [id]: height }))}
                    {...props}
                  />
                  )}
                </View>
              ))}
            </View>
          </View>
        ))}
        <LoopLines
          theme={theme}
          groups={groups.filter((group) => onKeys.has(group.key))}
          lanes={lanes}
          on
          layers={layers}
          layerTops={layerTops}
          heights={heights}
          centers={centers}
          offset={gutter}
          widthOf={widthOf}
          nodeTopOf={nodeTopOf}
          laneStart={gutter + width + 6}
        />
        <BlockHeaders theme={theme} frames={frames} stats={stats} titles={Object.fromEntries(Object.entries(blocks).map(([prefix, block]) => [prefix, block.title]))} onToggle={(prefix) => setCollapsed(prefix, true)} />
        {selectedGroup ? (
          <LoopList
            theme={theme}
            group={selectedGroup}
            onClose={() => {
              setSelectedKey(null);
              setPinned(null);
            }}
          />
        ) : null}
      </View>
    </ScrollView>
  );
}

/** Every outcome of the selected loop badge with its running counter. */
function LoopList(props: { theme: Theme; group: LoopGroup; onClose(): void }) {
  const { theme, group } = props;
  return (
    <View style={{ marginTop: 8, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.accent, backgroundColor: theme.colors.surface1, padding: 8, gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
          Loops from {group.from} back to {group.to}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Hide loops" hitSlop={8} onPress={props.onClose}>
          <Icon name="X" size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
      {group.edges.map((edge) => (
        <Text key={edge.outcome} style={{ color: theme.colors.foreground, fontSize: 11, paddingLeft: 8 }}>
          {loopText(edge)}
        </Text>
      ))}
    </View>
  );
}

function AfterTasks(props: GraphProps & { available: number }) {
  const { playbook, theme } = props;
  const rule = <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.border }} />;
  return (
    <View style={{ gap: 8, paddingBottom: 8 }}>
      <View accessibilityRole="header" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {rule}
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>After the run</Text>
        {rule}
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, textAlign: "center" }}>
        Runs once the run has ended. Its result does not change the run's.
      </Text>
      {playbook.after.map((task) => (
        <AfterTaskFrame key={task.id} {...props} task={task} />
      ))}
    </View>
  );
}

const FRAME_PAD = 8;

function AfterTaskFrame(props: GraphProps & { available: number; task: AfterTask }) {
  const { playbook, run, theme, task } = props;
  const start = useRpc(startAfterTaskRpc);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const steps = useMemo(() => playbook.steps.filter((step) => step.afterTask === task.id), [playbook, task.id]);
  const state = run?.after[task.id];
  const status = state?.status ?? "pending";
  const color =
    !run || status === "pending"
      ? theme.colors.foregroundMuted
      : status === "running"
        ? theme.colors.accent
        : status === "completed"
          ? theme.colors.statusSuccess
          : theme.colors.statusDanger;
  const ended = run !== null && isTerminal(run.status);
  const label = !run
    ? task.trigger === "auto"
      ? "starts when the run completes or fails"
      : "a human starts it once the run has ended"
    : status === "pending"
      ? ended
        ? "not started"
        : task.trigger === "auto"
          ? "starts when the run ends"
          : "can be started once the run ends"
      : status === "running"
        ? "wrapping up"
        : `${status}${state?.detail ? `: ${state.detail}` : ""}`;
  const canStart = ended && task.trigger === "manual" && status === "pending";
  return (
    <View style={{ borderRadius: 12, borderWidth: 1, borderColor: status === "running" ? color : theme.colors.border, backgroundColor: theme.colors.surface0, padding: FRAME_PAD, gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name={status === "running" ? "Loader" : status === "completed" ? "Check" : status === "failed" || status === "canceled" ? "X" : "Hourglass"} size={13} color={color} />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
            {task.title}
            <Text style={{ color: theme.colors.foregroundMuted, fontWeight: "400" }}> · {task.trigger}</Text>
          </Text>
          <Text numberOfLines={2} style={{ color, fontSize: 11 }}>
            {label}
          </Text>
        </View>
        {canStart ? (
          <Button
            theme={theme}
            kind="primary"
            label={busy ? "Starting…" : "Start"}
            disabled={busy}
            accessibilityLabel={`Start the after-task ${task.title}`}
            onPress={() => {
              setBusy(true);
              void start({ runId: run!.id, taskId: task.id })
                .then(() => queryClient.invalidateQueries({ queryKey: ["playbooks"] }))
                .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
                .finally(() => setBusy(false));
            }}
          />
        ) : null}
      </View>
      {steps.length > 0 ? <Dag {...props} steps={steps} terminals={false} available={Math.max(0, props.available - 2 * FRAME_PAD - 2)} /> : null}
    </View>
  );
}

function Band(props: {
  theme: Theme;
  width: number;
  edges: Array<{ from: string; to: string }>;
  centers: Map<string, number>;
  running: Set<string>;
  labels: Map<string, string>;
  /** Extra height under the edge band for the headers of the frames that start on this layer. */
  extra: number;
  /** Frame headers in band coordinates: edges are cut where they would cross one. */
  headers: Box[];
}) {
  const { theme, edges, centers, running, extra } = props;
  const full = BAND_H + extra;
  const sources = [...new Set(edges.map((edge) => edge.from))];
  const targets = [...new Set(edges.map((edge) => edge.to))];
  const xs = [...sources, ...targets].map((id) => centers.get(id) ?? 0);
  const mid = Math.round(BAND_H / 2);
  const stroke = EDGE_STROKE;
  const line = theme.colors.foregroundMuted;
  const hot = theme.colors.accent;
  const segments: Array<{ key: string; left: number; top: number; width: number; height: number; color: string }> = [];
  for (const id of sources) {
    segments.push({ key: `s-${id}`, left: (centers.get(id) ?? 0) - stroke / 2, top: 0, width: stroke, height: mid, color: line });
  }
  for (const id of targets) {
    const color = running.has(id) ? hot : line;
    // Stop the line above the arrowhead.
    const x = centers.get(id) ?? 0;
    clearOfHeaders(x, stroke, mid, full - ARROW + 4, props.headers).forEach(([a, b], index) =>
      segments.push({ key: `t-${id}-${index}`, left: x - stroke / 2, top: a, width: stroke, height: b - a, color }),
    );
  }
  if (xs.length > 0 && Math.max(...xs) - Math.min(...xs) > 1) {
    segments.push({ key: "bus", left: Math.min(...xs) - stroke / 2, top: mid - stroke / 2, width: Math.max(...xs) - Math.min(...xs) + stroke, height: stroke, color: line });
  }
  return (
    <View style={{ height: full, width: props.width }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {segments.map((segment) => (
        <View
          key={segment.key}
          style={{ position: "absolute", left: segment.left, top: segment.top, width: segment.width, height: segment.height, backgroundColor: segment.color }}
        />
      ))}
      {sources
        .filter((id) => props.labels.has(id))
        .map((id) => (
          <Text
            key={`l-${id}`}
            numberOfLines={1}
            style={{ position: "absolute", left: (centers.get(id) ?? 0) + 6, top: 1, color: theme.colors.foregroundMuted, fontSize: 10 }}
          >
            {props.labels.get(id)}
          </Text>
        ))}
      {targets.map((id) => (
        <View key={`a-${id}`} style={{ position: "absolute", left: (centers.get(id) ?? 0) - ARROW / 2, top: full - ARROW, width: ARROW, height: ARROW }}>
          <Icon name="ChevronDown" size={ARROW} color={running.has(id) ? hot : line} />
        </View>
      ))}
    </View>
  );
}

/** The playbook's entry (its inputs) and exit (its outputs), as pills above and below the steps. A finished run's End opens its output values. */
function Terminal(props: {
  kind: "start" | "end";
  playbook: Playbook;
  run: Run | null;
  theme: Theme;
  nodeWidth: number;
  /** Width of the outputs area under End (the graph's width). */
  areaWidth: number;
  longNeeds: string[];
}) {
  const { theme, run, playbook } = props;
  const [open, setOpen] = useState(false);
  const start = props.kind === "start";
  const names = Object.keys(start ? playbook.inputs : playbook.outputs);
  const values = !start && run?.outputs ? Object.entries(run.outputs) : [];
  const color = start
    ? run
      ? theme.colors.statusSuccess
      : theme.colors.foregroundMuted
    : run?.status === "completed"
      ? theme.colors.statusSuccess
      : run?.status === "failed" || run?.status === "canceled"
        ? theme.colors.statusDanger
        : theme.colors.foregroundMuted;
  const label = start ? "Start" : run?.status === "failed" ? "Failed" : run?.status === "canceled" ? "Canceled" : "End";
  const detail = names.length > 0 ? names.join(", ") : start ? "no inputs" : "no outputs";
  const pill = (
    <>
      <Icon name={start ? "CirclePlay" : run?.status === "failed" || run?.status === "canceled" ? "CircleX" : "Flag"} size={13} color={color} />
      <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
        {label}
      </Text>
      <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: 11 }}>
        {detail}
      </Text>
      {values.length > 0 ? <Icon name={open ? "ChevronUp" : "ChevronDown"} size={13} color={theme.colors.foregroundMuted} /> : null}
    </>
  );
  const pillStyle = {
    maxWidth: props.nodeWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: color,
    backgroundColor: theme.colors.surface2,
  } as const;
  return (
    <View style={{ width: props.nodeWidth, alignItems: "center", gap: 6 }}>
      {values.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`${label}. ${open ? "Hide" : "Show"} the run's outputs: ${detail}`}
          onPress={() => setOpen((value) => !value)}
          style={pillStyle}
        >
          {pill}
        </Pressable>
      ) : (
        <View accessible accessibilityLabel={`${label}. ${start ? "Inputs" : "Outputs"}: ${detail}`} style={pillStyle}>
          {pill}
        </View>
      )}
      {open && values.length > 0 ? (
        <View
          style={{
            width: props.areaWidth,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface2,
          }}
        >
          {values.map(([name, value], index) => {
            const text = String(value);
            const isUrl = /^https?:\/\//.test(text);
            return (
              <View
                key={name}
                style={{ gap: 2, paddingHorizontal: 10, paddingVertical: 8, borderTopWidth: index === 0 ? 0 : 1, borderTopColor: theme.colors.border }}
              >
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>{name}</Text>
                <Pressable disabled={!isUrl} onPress={() => void openExternalUrl(text)} accessibilityRole={isUrl ? "link" : "text"}>
                  <Text selectable style={{ color: isUrl ? theme.colors.accent : theme.colors.foreground, fontSize: 12 }}>
                    {text}
                  </Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      ) : null}
      {props.longNeeds.length > 0 ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, textAlign: "center" }}>
          also after {props.longNeeds.join(", ")}
        </Text>
      ) : null}
    </View>
  );
}

/** Dashed loop-back edges, drawn behind the nodes: out of the source's right side, up a lane, into the target's right side. */
/** The frame behind the steps of each expanded sub-playbook (nested ones inside their parent's). Drawing only. */
function BlockFrames(props: { theme: Theme; frames: FrameRect[] }) {
  const { theme } = props;
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}>
      {props.frames.map((frame) => (
        <View
          key={frame.prefix}
          style={{
            position: "absolute",
            left: frame.box.left,
            top: frame.box.top,
            width: frame.box.right - frame.box.left,
            height: frame.box.bottom - frame.box.top,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: frame.depth % 2 === 0 ? theme.colors.surface0 : theme.colors.surface1,
          }}
        />
      ))}
    </View>
  );
}

/**
 * The toggle strip of each expanded frame, drawn after (above) the steps, edges and loop lines so nothing
 * paints over it or swallows its clicks; the layout reserves its room, so no card sits under it. The whole
 * strip is the button.
 */
function BlockHeaders(props: { theme: Theme; frames: FrameRect[]; stats: Record<string, BlockStats>; titles: Record<string, string>; onToggle(prefix: string): void }) {
  const { theme } = props;
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, zIndex: 10 }}>
      {props.frames.map((frame) => {
        const stat = props.stats[frame.prefix];
        const title = props.titles[frame.prefix] ?? frame.prefix;
        return (
          <Pressable
            key={frame.prefix}
            accessibilityRole="button"
            accessibilityLabel={`Sub-playbook ${title}, expanded. Tap to collapse`}
            accessibilityState={{ expanded: true }}
            onPress={() => props.onToggle(frame.prefix)}
            style={(state) => {
              const hovered = (state as { hovered?: boolean }).hovered === true;
              return {
                position: "absolute",
                left: frame.header.left + 1,
                top: frame.header.top + 1,
                width: frame.header.right - frame.header.left - 2,
                height: HEADER_H - 1,
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: 10,
                borderTopLeftRadius: 13,
                borderTopRightRadius: 13,
                backgroundColor: state.pressed ? theme.colors.surface2 : hovered ? theme.colors.surface1 : "transparent",
                cursor: "pointer",
              } as never;
            }}
          >
            <Icon name="ChevronDown" size={18} color={theme.colors.foregroundMuted} />
            <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
              {title}
            </Text>
            {stat ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{`${stat.done}/${stat.total}`}</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const BLOCK_STATUS_LABEL: Record<BlockStatus, string> = {
  pending: "not started",
  running: "running",
  waiting: "needs attention",
  failed: "failed",
  completed: "completed",
};

/** A collapsed sub-playbook: one node with its name, status, progress and, while it runs, its elapsed time. Tap to expand. */
function GroupNode(props: {
  theme: Theme;
  title: string;
  stats: BlockStats;
  depth: number;
  nodeWidth: number;
  longNeeds: string[];
  onToggle(): void;
  onBoxHeight(height: number): void;
}) {
  const { theme, stats } = props;
  const status = blockStatus(stats);
  const now = useNow();
  const elapsed = status === "running" ? runningFor(stats.startedAt, now) : null;
  const color =
    status === "failed" ? theme.colors.statusDanger : status === "running" ? theme.colors.accent : status === "waiting" ? theme.colors.statusWarning : status === "completed" ? theme.colors.statusSuccess : theme.colors.border;
  const summary = [BLOCK_STATUS_LABEL[status], progressText(stats), elapsed].filter(Boolean).join(" · ");
  return (
    <View style={{ width: props.nodeWidth }}>
      <View style={{ borderRadius: 14, backgroundColor: theme.colors.surface1 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: false }}
          accessibilityLabel={`Sub-playbook ${props.title}, collapsed, ${summary}. Tap to expand`}
          onLayout={(event) => props.onBoxHeight(Math.round(event.nativeEvent.layout.height))}
          onPress={props.onToggle}
          style={{
            minHeight: 48,
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: 10,
            paddingVertical: 8,
            borderRadius: 14,
            borderWidth: status === "running" ? 2 : 1,
            borderStyle: "dashed",
            borderColor: color,
            backgroundColor: theme.colors.surface0,
          }}
        >
          <Icon name="ChevronRight" size={16} color={theme.colors.foregroundMuted} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
              {props.title}
            </Text>
            <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {summary}
            </Text>
          </View>
        </Pressable>
      </View>
      {props.longNeeds.length > 0 ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, textAlign: "center" }}>also after {props.longNeeds.join(", ")}</Text>
      ) : null}
    </View>
  );
}

/**
 * Loop back-edges, one per source and target: out of the source's right side, along a lane, into the
 * target's right side. Grey and dotted behind the nodes; `on` draws the highlighted ones white, solid
 * and with short labels, on top.
 */
function LoopLines(props: {
  theme: Theme;
  groups: LoopGroup[];
  lanes: Map<string, number>;
  on: boolean;
  layers: Map<string, number>;
  layerTops: Record<number, number>;
  heights: Record<string, number>;
  centers: Map<string, number>;
  offset: number;
  widthOf(id: string): number;
  nodeTopOf(layer: number, layerTop: number): number;
  nodeTopOf(layer: number, layerTop: number): number;
  laneStart: number;
}) {
  const { theme, on } = props;
  const color = on ? theme.colors.foreground : theme.colors.foregroundMuted;
  const stroke = on ? LOOP_STROKE_ON : LOOP_STROKE;
  const segments: Array<{ key: string; x: number; y: number; length: number; vertical: boolean }> = [];
  const arrows: Array<{ key: string; x: number; y: number }> = [];
  const labels: Array<{ key: string; x: number; y: number; lines: string[] }> = [];
  for (const group of props.groups) {
    const fromLayer = props.layers.get(group.from) ?? 0;
    const toLayer = props.layers.get(group.to) ?? 0;
    const fromTop = props.layerTops[fromLayer];
    const toTop = props.layerTops[toLayer];
    const fromH = props.heights[group.from];
    const toH = props.heights[group.to];
    if (fromTop === undefined || toTop === undefined || !fromH || !toH) continue;
    const top = props.nodeTopOf;
    const y1 = Math.round(top(fromLayer, fromTop) + fromH * 0.6);
    const y2 = Math.round(top(toLayer, toTop) + toH * 0.4);
    const x1 = props.offset + (props.centers.get(group.from) ?? 0) + props.widthOf(group.from) / 2;
    const x2 = props.offset + (props.centers.get(group.to) ?? 0) + props.widthOf(group.to) / 2;
    const lane = props.laneStart + (props.lanes.get(group.key) ?? 0) * LANE_GAP;
    segments.push({ key: `${group.key}-out`, x: x1, y: y1, length: lane - x1, vertical: false });
    segments.push({ key: `${group.key}-up`, x: lane, y: Math.min(y1, y2), length: Math.abs(y1 - y2) + stroke, vertical: true });
    segments.push({ key: `${group.key}-in`, x: x2 + ARROW / 2, y: y2, length: lane - x2 - ARROW / 2, vertical: false });
    arrows.push({ key: group.key, x: x2, y: y2 });
    labels.push({ key: group.key, x: lane, y: (y1 + y2) / 2, lines: group.edges.map(loopText) });
  }
  const bar = (key: string, segment: (typeof segments)[number], start: number, size: number) => (
    <View
      key={key}
      style={{
        position: "absolute",
        left: segment.vertical ? segment.x - stroke / 2 : segment.x + start,
        top: segment.vertical ? segment.y + start : segment.y - stroke / 2,
        width: segment.vertical ? stroke : size,
        height: segment.vertical ? size : stroke,
        backgroundColor: color,
      }}
    />
  );
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {segments.map((segment) => {
        if (on) return bar(segment.key, segment, 0, segment.length);
        // Dotted: short dashes with gaps, at reduced opacity so the lines stay quiet next to the nodes.
        return (
          <View key={segment.key} style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, opacity: 0.7 }}>
            {Array.from({ length: Math.max(0, Math.ceil(segment.length / (DOT + DOT_GAP))) }, (_, index) => {
              const start = index * (DOT + DOT_GAP);
              const size = Math.min(DOT, segment.length - start);
              return size > 0 ? bar(`${segment.key}-${index}`, segment, start, size) : null;
            })}
          </View>
        );
      })}
      {arrows.map((arrow) => (
        <View key={`a-${arrow.key}`} style={{ position: "absolute", left: arrow.x - 2, top: arrow.y - ARROW / 2, width: ARROW, height: ARROW, opacity: on ? 1 : 0.7 }}>
          <Icon name="ChevronLeft" size={ARROW} color={color} />
        </View>
      ))}
      {on
        ? labels.map((label) => (
            <View
              key={`l-${label.key}`}
              style={{
                position: "absolute",
                left: label.x - 6 - 150,
                top: label.y - (label.lines.length * LOOP_LABEL_H) / 2,
                width: 150,
                alignItems: "flex-end",
              }}
            >
              <View style={{ borderRadius: 4, backgroundColor: theme.colors.surface2, paddingHorizontal: 4 }}>
              {label.lines.map((line) => (
                <Text key={line} numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 10, lineHeight: LOOP_LABEL_H }}>
                  {line}
                </Text>
              ))}
              </View>
            </View>
          ))
        : null}
    </View>
  );
}

function Node(props: GraphProps & { step: Step; longNeeds: string[]; nodeWidth: number; loops: LoopEdge[]; loopGroups: LoopGroup[]; titleOf(id: string): string; selectedLoop: string | null; loopTarget: boolean; inLoops: boolean; pinned: boolean; onHover(over: boolean): void; onTogglePin(): void; onToggleLoop(key: string): void; onBoxHeight(height: number): void }) {
  const { step, run, theme, playbook, highlighted } = props;
  const state = run?.steps[step.id];
  const attempts = state?.attempts ?? [];
  const latest = attempts.at(-1);
  const isScript = step.kind === "script";
  const isHandoff = step.kind === "handoff";
  // Script and hand-off steps have no agent: their attempts open the details sheet instead of a conversation.
  const isFanout = step.kind === "fanout";
  const agentless = isScript || isHandoff || isFanout;
  const latestAgent = latest && !agentless ? latest.agentId : null;
  const live = useAgent(latestAgent ?? "", (agent) => ({ status: agent.status, attention: agent.attentionReason }));
  const reduceMotion = useReduceMotion();
  let nodeState: NodeState = run ? state?.status ?? "pending" : "definition";
  if (nodeState === "running" && live?.attention === "permission") nodeState = "needs_permission";
  const color = nodeColor(theme, nodeState);
  const dimmed = nodeState === "pending" || nodeState === "skipped";
  const isGate = step.kind === "gate";
  const pendingGate = run?.gates.find((gate) => gate.status === "pending" && gate.stepId === step.id);
  const role = step.role ? playbook.roles[step.role] : undefined;
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (nodeState !== "running" || reduceMotion) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 900, useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [nodeState, reduceMotion, pulse]);

  const condition = step.when?.length ? ` · if ${step.when.map(conditionText).join(", ")}` : "";
  const chosen = run?.steps[step.id]?.branch ?? null;
  const subtitle = (step.kind === "branch"
    ? `Branch${chosen ? ` → ${chosen}` : ` · ${step.branch?.cases.map((candidate) => candidate.name).join(" | ") ?? ""}`}`
    : isGate
    ? "Gate"
    : isScript
      ? `Script${nodeState === "running" && latest?.checks ? ` · check ${latest.checks}` : ""}`
      : isHandoff
        ? `Hand-off → ${step.handoff}`
        : isFanout
          ? `Fan-out → ${step.fanout?.playbook ?? ""}`
        : `${role?.title ?? step.role}${role?.readonly ? " · ro" : ""}`) + condition;
  // A hand-off's job once handed off (its run does not follow it any further).
  const jobLine = isFanout && state?.fanout ? engineText(state.fanout) : isHandoff ? (latest?.job ? `Handed off to ${step.handoff} (${latest.job.jobId})` : nodeState === "running" ? latest?.lastMessage ?? null : null) : latest?.waiting && nodeState === "running" ? `Waiting for tokens until ${new Date(latest.waiting.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : null;
  const stateLabel = nodeStateLabel(nodeState);
  // The current attempt's elapsed time while it runs; a gate waiting on a human is not running.
  const now = useNow();
  const elapsed = (nodeState === "running" || nodeState === "needs_permission") && !pendingGate ? runningFor(latest?.startedAt, now) : null;
  const onPress = () => (latestAgent ? props.onOpenAgent(latestAgent) : props.onOpenSheet(step.id));
  const isHighlighted = highlighted === step.id || props.loopTarget;
  const [expanded, setExpanded] = useState(false);
  const { shown, hidden } = visibleAttempts(attempts, expanded);

  return (
    <View style={{ width: props.nodeWidth }}>
      {/* Opaque layer under the (tinted, dimmed or pulsing) box, so loop lines behind never show through. */}
      <View style={{ borderRadius: isGate ? 4 : 12, backgroundColor: theme.colors.surface1 }}>
      <Animated.View
        onLayout={(event) => props.onBoxHeight(Math.round(event.nativeEvent.layout.height))}
        style={{
          borderRadius: isGate ? 4 : 12,
          borderWidth: nodeState === "running" || isHighlighted ? 2 : 1,
          borderColor: isHighlighted ? theme.colors.accent : color,
          backgroundColor: isGate ? gateBackground(theme) : agentBackground(theme),
          opacity: dimmed ? 0.55 : nodeState === "running" ? pulse.interpolate({ inputRange: [0.35, 1], outputRange: [0.7, 1] }) : 1,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${stepTitle(step)}, ${STEP_KINDS[step.kind].label} step, ${subtitle}${stateLabel ? `, ${stateLabel}` : ""}${props.loops.map((loop) => `, on ${loop.outcome} loops back to ${loop.to}${loop.max !== undefined ? ` (${loop.count} of ${loop.max})` : ""}`).join("")}${latest ? `, attempt ${latest.n}` : ""}${latestAgent ? ", opens conversation" : ", opens details"}`}
          onPress={onPress}
          onHoverIn={() => props.onHover(true)}
          onHoverOut={() => props.onHover(false)}
          style={{ paddingHorizontal: 8, paddingVertical: 6, gap: 2 }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Icon name={isGate ? "Diamond" : nodeIcon(nodeState)} size={13} color={nodeState === "definition" ? theme.colors.foregroundMuted : color} />
            <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
              {stepTitle(step)}
            </Text>
            {props.inLoops ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: props.pinned }}
                accessibilityLabel={`${props.pinned ? "Stop highlighting" : "Highlight"} the loops of ${step.id}`}
                hitSlop={8}
                onPress={props.onTogglePin}
              >
                <Icon name="Repeat" size={13} color={props.pinned ? theme.colors.foreground : theme.colors.foregroundMuted} />
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Details for ${step.id}`}
              hitSlop={8}
              onPress={() => props.onOpenSheet(step.id)}
            >
              <Icon name="Info" size={13} color={theme.colors.foregroundMuted} />
            </Pressable>
          </View>
          {/* The kind icon sits on the subtitle row, apart from the status marker on the title row; the subtitle still names the kind. */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Icon name={STEP_KINDS[step.kind].icon} size={11} color={theme.colors.foregroundMuted} />
            <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {subtitle}
            </Text>
          </View>
          {stateLabel ? (
            <Text numberOfLines={1} style={{ color, fontSize: 10 }}>
              {stateLabel}
            </Text>
          ) : null}
          {run && nodeState === "pending" && state?.waitUntil && !isTerminal(run.status) ? (
            <Text numberOfLines={1} accessibilityLabel={`Waits until ${new Date(state.waitUntil).toLocaleTimeString()} (loop-back delay)`} style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
              {`waits until ${new Date(state.waitUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`}
            </Text>
          ) : null}
          {elapsed ? (
            <Text numberOfLines={1} accessibilityLabel={`Running for ${elapsed}`} style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
              {`running for ${elapsed}`}
            </Text>
          ) : null}
          {props.slow?.[step.id] ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }} accessible accessibilityLabel={`Slow step: ${slowDetail(props.slow[step.id]!)}`}>
              <Icon name="TriangleAlert" size={11} color={theme.colors.statusWarning} />
              <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foregroundMuted, fontSize: 10 }}>
                {slowDetail(props.slow[step.id]!)}
              </Text>
            </View>
          ) : null}
          {jobLine ? (
            <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
              {jobLine}
            </Text>
          ) : null}
        </Pressable>
        {pendingGate && run && waitsForHuman(pendingGate) ? (
          <View style={{ paddingHorizontal: 8, paddingBottom: 8 }}>
            <GateActions theme={theme} run={run} gate={pendingGate} hostLabel={props.hostLabel} />
          </View>
        ) : pendingGate ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, paddingHorizontal: 8, paddingBottom: 8 }}>Advisor deciding</Text>
        ) : null}
        {attempts.length > 1 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, paddingHorizontal: 8, paddingBottom: 6 }}>
            {hidden > 0 || expanded ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={expanded ? `Collapse the attempts of ${step.id}` : `Show all ${attempts.length} attempts of ${step.id}`}
                onPress={() => setExpanded((current) => !current)}
                style={{ borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1, borderWidth: 1, borderColor: theme.colors.border }}
              >
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>{expanded ? "Collapse" : `${attempts.length} attempts · +${hidden} earlier`}</Text>
              </Pressable>
            ) : null}
            {shown.map((attempt) => (
              <Pressable
                key={attempt.n}
                accessibilityRole="button"
                accessibilityLabel={`Open attempt ${attempt.n} of ${step.id}`}
                onPress={() => (agentless ? props.onOpenSheet(step.id) : props.onOpenAgent(attempt.agentId))}
                style={{ borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1, backgroundColor: theme.colors.surface2 }}
              >
                <Text style={{ color: theme.colors.foreground, fontSize: 10 }}>#{attempt.n}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {props.loopGroups.length > 0 ? (
          <View style={{ gap: 4, paddingHorizontal: 8, paddingBottom: 6 }}>
            {props.loopGroups.map((group) => (
              <Pressable
                key={group.key}
                accessibilityRole="button"
                accessibilityState={{ selected: props.selectedLoop === group.key }}
                accessibilityLabel={`Loops back to ${group.to}: ${group.edges.map(loopText).join(", ")}`}
                hitSlop={4}
                onPress={() => props.onToggleLoop(group.key)}
                style={{ borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3, borderWidth: 1, borderColor: props.selectedLoop === group.key ? theme.colors.accent : theme.colors.border }}
              >
                <Text numberOfLines={1} style={{ color: group.exhausted ? theme.colors.foregroundMuted : theme.colors.foreground, fontSize: 10 }}>
                  {badgeText(group, props.titleOf(group.to))}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </Animated.View>
      </View>
      {props.longNeeds.length > 0 ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, textAlign: "center", marginTop: 2 }}>
          also needs {props.longNeeds.join(", ")}
        </Text>
      ) : null}
    </View>
  );
}

/** "2 of 5 done: 1 running": a fan-out step's progress on its node. */
function engineText(state: NonNullable<Run["steps"][string]["fanout"]>): string {
  const done = state.children.filter((child) => ["completed", "failed", "canceled", "not_started"].includes(child.status)).length;
  const running = state.children.filter((child) => child.status === "running" || child.status === "starting").length;
  const queued = state.children.filter((child) => child.status === "pending").length;
  if (state.pool) return `${running} running · ${done} done${queued ? ` · ${queued} queued` : ""} · refills ${state.pool.refills}`;
  return `${done} of ${state.children.length} done${running ? `, ${running} running` : ""}`;
}
