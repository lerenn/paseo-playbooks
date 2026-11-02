import { useAgent } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Pressable, Text, View } from "react-native";
import { layerOf, layoutGraph } from "../shared/graph";
import type { Playbook, Run, Step } from "../shared/types";
import { agentBackground, gateBackground, nodeColor, nodeIcon, nodeStateLabel, type NodeState, type Theme } from "./theme";

/** Nodes grow with the panel between these widths; below the minimum the graph scrolls sideways. */
const NODE_MIN = 132;
const NODE_MAX = 240;
const GAP = 14;
const BAND_H = 32;
/** Edge thickness and arrowhead size, in px. */
const EDGE_STROKE = 2;
const ARROW = 14;

export interface GraphProps {
  playbook: Playbook;
  run: Run | null;
  theme: Theme;
  highlighted: string | null;
  onOpenAgent(agentId: string): void;
  onOpenSheet(stepId: string): void;
  onHighlight(stepId: string | null): void;
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
  const layout = useMemo(() => layoutGraph(playbook.steps), [playbook]);
  const layers = useMemo(() => layerOf(playbook.steps), [playbook]);
  const [available, setAvailable] = useState(0);
  const columns = Math.max(1, ...layout.layers.map((row) => row.length));
  const nodeWidth = Math.max(NODE_MIN, Math.min(NODE_MAX, Math.floor(available / columns) - GAP));
  const SLOT = nodeWidth + GAP;
  const width = columns * SLOT;
  const centers = useMemo(() => {
    const result = new Map<string, number>();
    for (const row of layout.layers) {
      const offset = (width - row.length * SLOT) / 2;
      row.forEach((id, index) => result.set(id, offset + index * SLOT + SLOT / 2));
    }
    return result;
  }, [layout, width, SLOT]);
  const byId = useMemo(() => new Map(playbook.steps.map((step) => [step.id, step])), [playbook]);
  const running = new Set(run ? playbook.steps.filter((step) => run.steps[step.id]?.status === "running").map((step) => step.id) : []);

  return (
    <View onLayout={(event) => setAvailable(event.nativeEvent.layout.width)}>
    <ScrollView horizontal style={{ flexGrow: 0 }} contentContainerStyle={{ minWidth: "100%", justifyContent: "center" }}>
      <View style={{ width, paddingTop: 4, paddingBottom: 16 }}>
        {layout.layers.map((row, index) => (
          <View key={row.join(",")}>
            {index > 0 ? (
              <Band
                theme={theme}
                width={width}
                edges={layout.edges.filter((edge) => layers.get(edge.from) === index - 1 && layers.get(edge.to) === index)}
                centers={centers}
                running={running}
              />
            ) : null}
            <View style={{ flexDirection: "row", justifyContent: "center" }}>
              {row.map((id) => (
                <View key={id} style={{ width: SLOT, alignItems: "center" }}>
                  <Node
                    step={byId.get(id)!}
                    longNeeds={byId.get(id)!.needs.filter((need) => (layers.get(need) ?? 0) < index - 1)}
                    nodeWidth={nodeWidth}
                    {...props}
                  />
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
      {targets.map((id) => (
        <View key={`a-${id}`} style={{ position: "absolute", left: (centers.get(id) ?? 0) - ARROW / 2, top: BAND_H - ARROW, width: ARROW, height: ARROW }}>
          <Icon name="ChevronDown" size={ARROW} color={running.has(id) ? hot : line} />
        </View>
      ))}
    </View>
  );
}

function Node(props: GraphProps & { step: Step; longNeeds: string[]; nodeWidth: number }) {
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

  const loops = Object.entries(step.on).flatMap(([outcome, transition]) =>
    transition.kind === "goto"
      ? [{ outcome, target: transition.target, count: run?.loops[`${step.id}->${transition.target}`] ?? 0, max: transition.maxLoops }]
      : [],
  );
  const subtitle = isGate ? "gate" : `${role?.title ?? step.role}${role?.readonly ? " · ro" : ""}`;
  const stateLabel = nodeStateLabel(nodeState);
  const onPress = () => (latest ? props.onOpenAgent(latest.agentId) : props.onOpenSheet(step.id));
  const isHighlighted = highlighted === step.id;

  return (
    <View style={{ width: props.nodeWidth, opacity: dimmed ? 0.55 : 1 }}>
      <Animated.View
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
          accessibilityLabel={`${step.id}, ${subtitle}${stateLabel ? `, ${stateLabel}` : ""}${latest ? `, attempt ${latest.n}, opens conversation` : ", opens details"}`}
          onPress={onPress}
          style={{ paddingHorizontal: 8, paddingVertical: 6, gap: 2 }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Icon name={isGate ? "Diamond" : nodeIcon(nodeState)} size={13} color={nodeState === "definition" ? theme.colors.foregroundMuted : color} />
            <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
              {step.id}
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
      {loops.map((loop) => (
        <Pressable
          key={loop.outcome}
          accessibilityRole="button"
          accessibilityLabel={`On ${loop.outcome}, loops back to ${loop.target}. Highlight it.`}
          onPressIn={() => props.onHighlight(loop.target)}
          onPressOut={() => props.onHighlight(null)}
          style={{ marginTop: 3, alignSelf: "center" }}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, textAlign: "center" }}>
            ↺ {loop.outcome} → {loop.target}
            {loop.max !== undefined ? ` · ${loop.count}/${loop.max}` : loop.count > 0 ? ` · ${loop.count}` : ""}
          </Text>
        </Pressable>
      ))}
      {props.longNeeds.length > 0 ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, textAlign: "center", marginTop: 2 }}>
          also needs {props.longNeeds.join(", ")}
        </Text>
      ) : null}
    </View>
  );
}
