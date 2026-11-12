import { openExternalUrl, useAgent, useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Pressable, Text, View } from "react-native";
import { Button, GateActions } from "./sheet";
import { startAfterTaskRpc } from "../shared/contracts";
import { askChoices } from "../shared/gates";
import { END, layerOf, layoutGraph, START, withTerminals } from "../shared/graph";
import { isTerminal, type AfterTask, type Playbook, type Run, type Step } from "../shared/types";
import { conditionText } from "../shared/labels";
import { agentBackground, gateBackground, stepTitle, nodeColor, nodeIcon, nodeStateLabel, type NodeState, type Theme } from "./theme";

/** Nodes grow with the panel between these widths; below the minimum the graph scrolls sideways. */
const NODE_MIN = 132;
const NODE_MAX = 240;
const GAP = 14;
const BAND_H = 32;
/** Edge thickness and arrowhead size, in px. */
const EDGE_STROKE = 2;
const ARROW = 14;
/** Loop-back lanes on the right of the graph: spacing between lanes, dash and gap lengths. */
const LANE_GAP = 14;
const DASH = 5;
const DASH_GAP = 4;
const LABEL_H = 13;

interface LoopEdge {
  from: string;
  to: string;
  outcome: string;
  count: number;
  max: number | undefined;
}

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
  // Start and End are laid out like steps: Start above the roots, End below every step nothing needs.
  const nodes = useMemo(() => (props.terminals ? withTerminals(steps) : steps), [steps, props.terminals]);
  const layout = useMemo(() => layoutGraph(nodes), [nodes]);
  const layers = useMemo(() => layerOf(nodes), [nodes]);
  const loops = useMemo(() => loopEdges(steps, run), [steps, run]);
  const forward = useMemo(() => forwardLabels(steps), [steps]);
  // An after-task's own frame already holds its sub-playbook: no second frame for it.
  const blocks = useMemo(
    () => Object.fromEntries(Object.entries(playbook.blocks).filter(([prefix]) => !playbook.after.some((task) => task.id === prefix))),
    [playbook],
  );
  /** Room on each side for the loop lanes (both sides, so the graph stays centred). */
  const gutter = loops.length > 0 ? 6 + loops.length * LANE_GAP : 0;
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
  const deciding = new Set(run ? run.gates.filter((gate) => gate.status === "pending").map((gate) => gate.stepId) : []);
  /** Actual width of each node, so loop lines meet its edge. */
  const widthOf = (id: string): number => {
    const row = layout.layers.find((candidate) => candidate.includes(id));
    return deciding.has(id) && row?.length === 1 ? Math.max(nodeWidth, width - GAP) : nodeWidth;
  };
  const running = new Set(run ? steps.filter((step) => run.steps[step.id]?.status === "running").map((step) => step.id) : []);

  return (
    <ScrollView horizontal style={{ flexGrow: 0 }} contentContainerStyle={{ minWidth: "100%", justifyContent: "center" }}>
      <View style={{ width: width + 2 * gutter, paddingHorizontal: gutter, paddingTop: 4, paddingBottom: 16 }}>
        <BlockFrames
          theme={theme}
          blocks={blocks}
          stepIds={steps.map((step) => step.id)}
          layers={layers}
          layerTops={layerTops}
          heights={heights}
          centers={centers}
          offset={gutter}
          widthOf={widthOf}
        />
        <LoopLines
          theme={theme}
          loops={loops}
          layers={layers}
          layerTops={layerTops}
          heights={heights}
          centers={centers}
          offset={gutter}
          widthOf={widthOf}
          laneStart={gutter + width + 6}
          highlighted={props.highlighted}
        />
        {layout.layers.map((row, index) => (
          <View
            key={row.join(",")}
            onLayout={(event) => {
              const y = event.nativeEvent.layout.y;
              setLayerTops((current) => (current[index] === y ? current : { ...current, [index]: y }));
            }}
          >
            {index > 0 ? (
              <Band
                theme={theme}
                width={width}
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
                  ) : (
                  <Node
                    step={byId.get(id)!}
                    longNeeds={byId.get(id)!.needs.filter((need) => (layers.get(need) ?? 0) < index - 1)}
                    nodeWidth={widthOf(id)}
                    loops={loops.filter((loop) => loop.from === id)}
                    onBoxHeight={(height) => setHeights((current) => (current[id] === height ? current : { ...current, [id]: height }))}
                    {...props}
                  />
                  )}
                </View>
              ))}
            </View>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

/** Below End: what runs once the run has ended. It never changes the run's result. */
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
}) {
  const { theme, edges, centers, running } = props;
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
    segments.push({ key: `t-${id}`, left: (centers.get(id) ?? 0) - stroke / 2, top: mid, width: stroke, height: BAND_H - mid - ARROW + 4, color });
  }
  if (xs.length > 0 && Math.max(...xs) - Math.min(...xs) > 1) {
    segments.push({ key: "bus", left: Math.min(...xs) - stroke / 2, top: mid - stroke / 2, width: Math.max(...xs) - Math.min(...xs) + stroke, height: stroke, color: line });
  }
  return (
    <View style={{ height: BAND_H, width: props.width }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
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
        <View key={`a-${id}`} style={{ position: "absolute", left: (centers.get(id) ?? 0) - ARROW / 2, top: BAND_H - ARROW, width: ARROW, height: ARROW }}>
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
/** A labelled frame behind the steps of each sub-playbook (nested ones inside their parent's). */
function BlockFrames(props: {
  theme: Theme;
  blocks: Playbook["blocks"];
  stepIds: string[];
  layers: Map<string, number>;
  layerTops: Record<number, number>;
  heights: Record<string, number>;
  centers: Map<string, number>;
  offset: number;
  widthOf(id: string): number;
}) {
  const { theme } = props;
  const frames = Object.entries(props.blocks).flatMap(([prefix, block]) => {
    const members = props.stepIds.filter((id) => id.startsWith(`${prefix}.`));
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (const id of members) {
      const layer = props.layers.get(id) ?? 0;
      const layerTop = props.layerTops[layer];
      const height = props.heights[id];
      if (layerTop === undefined || !height) return [];
      const nodeTop = layerTop + (layer > 0 ? BAND_H : 0);
      const center = props.offset + (props.centers.get(id) ?? 0);
      left = Math.min(left, center - props.widthOf(id) / 2);
      right = Math.max(right, center + props.widthOf(id) / 2);
      top = Math.min(top, nodeTop);
      bottom = Math.max(bottom, nodeTop + height);
    }
    if (members.length === 0) return [];
    const depth = prefix.split(".").length - 1;
    const pad = Math.max(4, 10 - depth * 4);
    return [{ prefix, title: block.title, depth, left: left - pad, top: top - pad - 8, width: right - left + 2 * pad, height: bottom - top + 2 * pad + 8 }];
  });
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}>
      {frames
        .sort((a, b) => a.depth - b.depth)
        .map((frame) => (
          <View
            key={frame.prefix}
            accessible
            accessibilityLabel={`Sub-playbook ${frame.title}`}
            style={{
              position: "absolute",
              left: frame.left,
              top: frame.top,
              width: frame.width,
              height: frame.height,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: frame.depth % 2 === 0 ? theme.colors.surface0 : theme.colors.surface1,
            }}
          >
            <Text numberOfLines={1} style={{ position: "absolute", top: 2, left: 10, right: 10, color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "600" }}>
              {frame.title}
            </Text>
          </View>
        ))}
    </View>
  );
}

function LoopLines(props: {
  theme: Theme;
  loops: LoopEdge[];
  layers: Map<string, number>;
  layerTops: Record<number, number>;
  heights: Record<string, number>;
  centers: Map<string, number>;
  offset: number;
  widthOf(id: string): number;
  laneStart: number;
  highlighted: string | null;
}) {
  const { theme } = props;
  const segments: Array<{ key: string; x: number; y: number; length: number; vertical: boolean; color: string }> = [];
  const arrows: Array<{ key: string; x: number; y: number; color: string }> = [];
  const labels: Array<{ key: string; x: number; y: number; span: number; text: string; color: string }> = [];
  props.loops.forEach((loop, index) => {
    const fromLayer = props.layers.get(loop.from) ?? 0;
    const toLayer = props.layers.get(loop.to) ?? 0;
    const fromTop = props.layerTops[fromLayer];
    const toTop = props.layerTops[toLayer];
    const fromH = props.heights[loop.from];
    const toH = props.heights[loop.to];
    if (fromTop === undefined || toTop === undefined || !fromH || !toH) return;
    const top = (layer: number, layerTop: number) => layerTop + (layer > 0 ? BAND_H : 0);
    const y1 = Math.round(top(fromLayer, fromTop) + fromH * 0.6);
    const y2 = Math.round(top(toLayer, toTop) + toH * 0.4);
    const x1 = props.offset + (props.centers.get(loop.from) ?? 0) + props.widthOf(loop.from) / 2;
    const x2 = props.offset + (props.centers.get(loop.to) ?? 0) + props.widthOf(loop.to) / 2;
    const lane = props.laneStart + index * LANE_GAP;
    const exhausted = loop.max !== undefined && loop.count >= loop.max;
    const color = props.highlighted === loop.to ? theme.colors.accent : exhausted ? theme.colors.border : theme.colors.foregroundMuted;
    const key = `${loop.from}-${loop.outcome}`;
    segments.push({ key: `${key}-out`, x: x1, y: y1, length: lane - x1, vertical: false, color });
    segments.push({ key: `${key}-up`, x: lane, y: Math.min(y1, y2), length: Math.abs(y1 - y2) + EDGE_STROKE, vertical: true, color });
    segments.push({ key: `${key}-in`, x: x2 + ARROW / 2, y: y2, length: lane - x2 - ARROW / 2, vertical: false, color });
    arrows.push({ key, x: x2, y: y2, color });
    labels.push({
      key,
      x: lane,
      y: (y1 + y2) / 2,
      span: Math.max(40, Math.abs(y1 - y2) - 16),
      text: `${loop.outcome}${loop.max !== undefined ? ` · ${loop.count}/${loop.max}` : ""}`,
      color: color === theme.colors.border ? theme.colors.foregroundMuted : color,
    });
  });
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {segments.map((segment) =>
        Array.from({ length: Math.max(1, Math.ceil(segment.length / (DASH + DASH_GAP))) }, (_, dash) => {
          const start = dash * (DASH + DASH_GAP);
          const size = Math.min(DASH, segment.length - start);
          if (size <= 0) return null;
          return (
            <View
              key={`${segment.key}-${dash}`}
              style={{
                position: "absolute",
                left: segment.vertical ? segment.x - EDGE_STROKE / 2 : segment.x + start,
                top: segment.vertical ? segment.y + start : segment.y - EDGE_STROKE / 2,
                width: segment.vertical ? EDGE_STROKE : size,
                height: segment.vertical ? size : EDGE_STROKE,
                backgroundColor: segment.color,
              }}
            />
          );
        }),
      )}
      {labels.map((label) => (
        // Written along the lane, bottom to top; the background breaks the dashes behind the text.
        <View
          key={`l-${label.key}`}
          style={{
            position: "absolute",
            left: label.x - label.span / 2,
            top: label.y - LABEL_H / 2,
            width: label.span,
            height: LABEL_H,
            alignItems: "center",
            justifyContent: "center",
            transform: [{ rotate: "-90deg" }],
          }}
        >
          <Text numberOfLines={1} style={{ color: label.color, fontSize: 10, lineHeight: LABEL_H, paddingHorizontal: 3, backgroundColor: theme.colors.surface1 }}>
            {label.text}
          </Text>
        </View>
      ))}
      {arrows.map((arrow) => (
        <View key={`a-${arrow.key}`} style={{ position: "absolute", left: arrow.x - 2, top: arrow.y - ARROW / 2, width: ARROW, height: ARROW }}>
          <Icon name="ChevronLeft" size={ARROW} color={arrow.color} />
        </View>
      ))}
    </View>
  );
}

function Node(props: GraphProps & { step: Step; longNeeds: string[]; nodeWidth: number; loops: LoopEdge[]; onBoxHeight(height: number): void }) {
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
          ? `Fan-out → ${step.fanout?.playbook ?? ""}${state?.fanout ? ` · ${engineText(state.fanout)}` : ""}`
        : `${role?.title ?? step.role}${role?.readonly ? " · ro" : ""}`) + condition;
  // Where a hand-off's job is: its boarding run, the run carrying it, or its result.
  const jobLine = isHandoff && nodeState === "running" ? latest?.lastMessage ?? null : latest?.waiting && nodeState === "running" ? `Waiting for tokens until ${new Date(latest.waiting.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : null;
  const stateLabel = nodeStateLabel(nodeState);
  const onPress = () => (latestAgent ? props.onOpenAgent(latestAgent) : props.onOpenSheet(step.id));
  const isHighlighted = highlighted === step.id;

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
          accessibilityLabel={`${stepTitle(step)}, ${subtitle}${stateLabel ? `, ${stateLabel}` : ""}${props.loops.map((loop) => `, on ${loop.outcome} loops back to ${loop.to}${loop.max !== undefined ? ` (${loop.count} of ${loop.max})` : ""}`).join("")}${latest ? `, attempt ${latest.n}` : ""}${latestAgent ? ", opens conversation" : ", opens details"}`}
          onPress={onPress}
          style={{ paddingHorizontal: 8, paddingVertical: 6, gap: 2 }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Icon name={isGate ? "Diamond" : nodeIcon(nodeState)} size={13} color={nodeState === "definition" ? theme.colors.foregroundMuted : color} />
            <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
              {stepTitle(step)}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Details for ${step.id}`}
              hitSlop={8}
              onPress={() => props.onOpenSheet(step.id)}
            >
              <Icon name="Info" size={13} color={theme.colors.foregroundMuted} />
            </Pressable>
          </View>
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            {subtitle}
          </Text>
          {stateLabel ? (
            <Text numberOfLines={1} style={{ color, fontSize: 10 }}>
              {stateLabel}
            </Text>
          ) : null}
          {jobLine ? (
            <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
              {jobLine}
            </Text>
          ) : null}
        </Pressable>
        {pendingGate && run ? (
          <View style={{ paddingHorizontal: 8, paddingBottom: 8 }}>
            <GateActions theme={theme} run={run} gate={pendingGate} hostLabel={props.hostLabel} />
          </View>
        ) : null}
        {attempts.length > 1 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, paddingHorizontal: 8, paddingBottom: 6 }}>
            {attempts.map((attempt) => (
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
  return `${done} of ${state.children.length} done${running ? `, ${running} running` : ""}`;
}
