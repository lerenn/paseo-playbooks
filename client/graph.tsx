import { useAgent } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Pressable, Text, View } from "react-native";
import { GateActions } from "./sheet";
import { END, layerOf, layoutGraph, START, withTerminals } from "../shared/graph";
import type { Playbook, Run, Step } from "../shared/types";
import { agentBackground, gateBackground, stepLabel, nodeColor, nodeIcon, nodeStateLabel, type NodeState, type Theme } from "./theme";

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
function forwardLabels(playbook: Playbook): Map<string, string> {
  const labels = new Map<string, string>();
  for (const step of playbook.steps) {
    if (!Object.values(step.on).some((transition) => transition.kind === "goto")) continue;
    const forward = step.outcomes.filter((outcome) => (step.on[outcome]?.kind ?? "complete") === "complete");
    if (forward.length > 0) labels.set(step.id, forward.join(" / "));
  }
  return labels;
}

function loopEdges(playbook: Playbook, run: Run | null): LoopEdge[] {
  return playbook.steps.flatMap((step) =>
    Object.entries(step.on).flatMap(([outcome, transition]) =>
      transition.kind === "goto"
        ? [{ from: step.id, to: transition.target, outcome, count: run?.loops[`${step.id}->${transition.target}`] ?? 0, max: transition.maxLoops }]
        : [],
    ),
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

function useReduceMotion(): boolean {
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

/** Layered top-down DAG built from plain views: nodes in rows, org-chart connectors between rows. */
export function Graph(props: GraphProps) {
  const { playbook, run, theme } = props;
  // Start and End are laid out like steps: Start above the roots, End below every step nothing needs.
  const nodes = useMemo(() => withTerminals(playbook.steps), [playbook]);
  const layout = useMemo(() => layoutGraph(nodes), [nodes]);
  const layers = useMemo(() => layerOf(nodes), [nodes]);
  const [available, setAvailable] = useState(0);
  const loops = useMemo(() => loopEdges(playbook, run), [playbook, run]);
  const forward = useMemo(() => forwardLabels(playbook), [playbook]);
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
  const byId = useMemo(() => new Map(playbook.steps.map((step) => [step.id, step])), [playbook]);
  /** Steps with a pending decision: their node widens to the graph's width, alone in its row, to hold the choices. */
  const deciding = new Set(run ? run.gates.filter((gate) => gate.status === "pending").map((gate) => gate.stepId) : []);
  const running = new Set(run ? playbook.steps.filter((step) => run.steps[step.id]?.status === "running").map((step) => step.id) : []);

  return (
    <View onLayout={(event) => setAvailable(event.nativeEvent.layout.width)}>
    <ScrollView horizontal style={{ flexGrow: 0 }} contentContainerStyle={{ minWidth: "100%", justifyContent: "center" }}>
      <View style={{ width: width + 2 * gutter, paddingHorizontal: gutter, paddingTop: 4, paddingBottom: 16 }}>
        <LoopLines
          theme={theme}
          loops={loops}
          layers={layers}
          layerTops={layerTops}
          heights={heights}
          centers={centers}
          offset={gutter}
          nodeWidth={nodeWidth}
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
                      longNeeds={id === END ? nodes.find((node) => node.id === END)!.needs.filter((need) => (layers.get(need) ?? 0) < index - 1) : []}
                    />
                  ) : (
                  <Node
                    step={byId.get(id)!}
                    longNeeds={byId.get(id)!.needs.filter((need) => (layers.get(need) ?? 0) < index - 1)}
                    nodeWidth={deciding.has(id) && row.length === 1 ? Math.max(nodeWidth, width - GAP) : nodeWidth}
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

/** The playbook's entry (its inputs) and exit (its outputs), as pills above and below the steps. */
function Terminal(props: { kind: "start" | "end"; playbook: Playbook; run: Run | null; theme: Theme; nodeWidth: number; longNeeds: string[] }) {
  const { theme, run, playbook } = props;
  const start = props.kind === "start";
  const names = Object.keys(start ? playbook.inputs : playbook.outputs);
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
  return (
    <View style={{ width: props.nodeWidth, alignItems: "center" }}>
      <View
        accessible
        accessibilityLabel={`${label}. ${start ? "Inputs" : "Outputs"}: ${detail}`}
        style={{
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
        }}
      >
        <Icon name={start ? "CirclePlay" : run?.status === "failed" || run?.status === "canceled" ? "CircleX" : "Flag"} size={13} color={color} />
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
          {label}
        </Text>
        <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: 11 }}>
          {detail}
        </Text>
      </View>
      {props.longNeeds.length > 0 ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, textAlign: "center", marginTop: 2 }}>
          also after {props.longNeeds.join(", ")}
        </Text>
      ) : null}
    </View>
  );
}

/** Dashed loop-back edges, drawn behind the nodes: out of the source's right side, up a lane, into the target's right side. */
function LoopLines(props: {
  theme: Theme;
  loops: LoopEdge[];
  layers: Map<string, number>;
  layerTops: Record<number, number>;
  heights: Record<string, number>;
  centers: Map<string, number>;
  offset: number;
  nodeWidth: number;
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
    const x1 = props.offset + (props.centers.get(loop.from) ?? 0) + props.nodeWidth / 2;
    const x2 = props.offset + (props.centers.get(loop.to) ?? 0) + props.nodeWidth / 2;
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
  const live = useAgent(latest?.agentId ?? "", (agent) => ({ status: agent.status, attention: agent.attentionReason }));
  const reduceMotion = useReduceMotion();
  let nodeState: NodeState = run ? state?.status ?? "pending" : "definition";
  if (nodeState === "running" && live?.attention === "permission") nodeState = "needs_permission";
  const color = nodeColor(theme, nodeState);
  const dimmed = nodeState === "pending";
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

  const subtitle = isGate ? "Gate" : `${role?.title ?? step.role}${role?.readonly ? " · ro" : ""}`;
  const stateLabel = nodeStateLabel(nodeState);
  const onPress = () => (latest ? props.onOpenAgent(latest.agentId) : props.onOpenSheet(step.id));
  const isHighlighted = highlighted === step.id;

  return (
    <View style={{ width: props.nodeWidth, opacity: dimmed ? 0.55 : 1 }}>
      <Animated.View
        onLayout={(event) => props.onBoxHeight(Math.round(event.nativeEvent.layout.height))}
        style={{
          borderRadius: isGate ? 4 : 12,
          borderWidth: nodeState === "running" || isHighlighted ? 2 : 1,
          borderColor: isHighlighted ? theme.colors.accent : color,
          backgroundColor: isGate ? gateBackground(theme) : agentBackground(theme),
          opacity: nodeState === "running" ? pulse.interpolate({ inputRange: [0.35, 1], outputRange: [0.7, 1] }) : 1,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${stepLabel(step.id)}, ${subtitle}${stateLabel ? `, ${stateLabel}` : ""}${props.loops.map((loop) => `, on ${loop.outcome} loops back to ${loop.to}${loop.max !== undefined ? ` (${loop.count} of ${loop.max})` : ""}`).join("")}${latest ? `, attempt ${latest.n}, opens conversation` : ", opens details"}`}
          onPress={onPress}
          style={{ paddingHorizontal: 8, paddingVertical: 6, gap: 2 }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Icon name={isGate ? "Diamond" : nodeIcon(nodeState)} size={13} color={nodeState === "definition" ? theme.colors.foregroundMuted : color} />
            <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
              {stepLabel(step.id)}
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
                onPress={() => props.onOpenAgent(attempt.agentId)}
                style={{ borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1, backgroundColor: theme.colors.surface2 }}
              >
                <Text style={{ color: theme.colors.foreground, fontSize: 10 }}>#{attempt.n}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </Animated.View>
      {props.longNeeds.length > 0 ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, textAlign: "center", marginTop: 2 }}>
          also needs {props.longNeeds.join(", ")}
        </Text>
      ) : null}
    </View>
  );
}
