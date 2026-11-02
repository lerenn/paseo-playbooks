import { openExternalUrl, useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { cancelRunRpc, listPlaybooks, listRuns } from "../shared/contracts";
import { isTerminal, type Playbook, type PlaybookEntry, type Run } from "../shared/types";
import { Graph } from "./graph";
import { Button, GateActions, StepSheet } from "./sheet";
import { StartForm } from "./start-form";
import { runStatusColor, runStatusLabel, type Theme } from "./theme";

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
    refetchInterval: (query) => (query.state.data?.runs.some((run) => !isTerminal(run.status)) ? 3_000 : 30_000),
  });
  const queryClient = useQueryClient();

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
          {cards.map((card) => (
            <PlaybookCard
              key={card.id}
              card={card}
              compact={layout.compact}
              theme={theme}
              workspaceId={workspaceId}
              hostLabel={props.host.label}
              onOpenAgent={(agentId) => navigation?.openAgent({ agentId })}
              onOpenWorkspace={(id) => navigation?.openWorkspace({ workspaceId: id })}
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

function PlaybookCard(props: {
  compact: boolean;
  card: Card;
  theme: Theme;
  workspaceId: string;
  hostLabel: string;
  onOpenAgent(agentId: string): void;
  onOpenWorkspace(workspaceId: string): void;
}) {
  const { card, theme } = props;
  const queryClient = useQueryClient();
  const active = card.runs.find((run) => !isTerminal(run.status));
  const [expanded, setExpanded] = useState(true);
  const [selected, setSelected] = useState<string | "definition" | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [starting, setStarting] = useState<"current" | "new" | null>(null);
  const runId = selected ?? active?.id ?? card.runs[0]?.id ?? "definition";
  const run = runId === "definition" ? null : card.runs.find((candidate) => candidate.id === runId) ?? null;
  const playbook: Playbook | null = run?.playbook ?? card.entry?.playbook ?? null;
  const title = playbook?.title ?? card.entry?.title ?? card.id;
  const errors = card.entry?.errors ?? [];

  return (
    <View style={{ borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, padding: 10, gap: 8 }}>
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
        {card.entry?.playbook ? <StartButton theme={theme} title={title} onStart={setStarting} /> : null}
      </View>
      {errors.map((error) => (
        <Text key={error} selectable style={{ color: theme.colors.statusDanger, fontSize: 12 }}>
          ⚠ {error}
        </Text>
      ))}
      {expanded && card.runs.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, zIndex: 15 }}>
          {card.runs.map((candidate) => (
            <RunChip
              key={candidate.id}
              theme={theme}
              run={candidate}
              selected={candidate.id === runId}
              onSelect={() => setSelected(candidate.id)}
              onCanceled={() => void queryClient.invalidateQueries({ queryKey: ["playbooks"] })}
            />
          ))}
          {card.entry?.playbook ? (
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: runId === "definition" }}
              onPress={() => setSelected("definition")}
              style={{ borderRadius: 10, borderWidth: 1, borderColor: runId === "definition" ? theme.colors.foregroundMuted : theme.colors.border, paddingHorizontal: 8, paddingVertical: 2 }}
            >
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>definition</Text>
            </Pressable>
          ) : null}
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
        />
      ) : null}
      {expanded && run ? (
        <Pressable accessibilityRole="button" onPress={() => props.onOpenAgent(run.managerAgentId)}>
          <Text style={{ color: theme.colors.accent, fontSize: 12 }}>Open the Playbook Manager ↗</Text>
        </Pressable>
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
            if (result.reusedAgent) props.onOpenAgent(result.managerAgentId);
            else props.onOpenWorkspace(result.workspaceId);
          }}
        />
      ) : null}
    </View>
  );
}

function RunBar(props: { theme: Theme; run: Run; hostLabel: string }) {
  const { theme, run } = props;
  const pending = run.gates.filter((gate) => gate.status === "pending");
  return (
    <View style={{ gap: 6 }}>
      {run.branch ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Branch {run.branch}</Text> : null}
      {Object.keys(run.inputs).length > 0 ? (
        <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {Object.entries(run.inputs)
            .map(([name, value]) => `${name}: ${value}`)
            .join(" · ")}
        </Text>
      ) : null}
      {run.failure ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{run.failure}</Text> : null}
      {run.outputs && Object.keys(run.outputs).length > 0 ? (
        <View style={{ gap: 2 }}>
          {Object.entries(run.outputs).map(([name, value]) => {
            const text = String(value);
            const isUrl = /^https?:\/\//.test(text);
            return (
              <Pressable key={name} disabled={!isUrl} onPress={() => void openExternalUrl(text)} accessibilityRole={isUrl ? "link" : "text"}>
                <Text style={{ color: isUrl ? theme.colors.accent : theme.colors.foreground, fontSize: 12 }}>
                  {name}: {text}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {run.status === "completed" && run.playbook.next.length > 0 ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          Next offered to the manager: {run.playbook.next.map((next) => next.playbook).join(", ")}
        </Text>
      ) : null}
      {pending.map((gate) => (
        <View key={gate.id} style={{ borderRadius: 8, borderWidth: 1, borderColor: theme.colors.statusWarning, padding: 8, gap: 4 }}>
          <Text style={{ color: theme.colors.statusWarning, fontSize: 12, fontWeight: "600" }}>
            ◆ {gate.kind === "loop_limit" ? "Loop limit" : gate.stepId} needs a decision
          </Text>
          <GateActions theme={theme} run={run} gate={gate} hostLabel={props.hostLabel} />
        </View>
      ))}
    </View>
  );
}

/** Split button: Start runs with the workspace's agent; the chevron menu offers a new agent in a new worktree. */
function StartButton(props: { theme: Theme; title: string; onStart(target: "current" | "new"): void }) {
  const { theme } = props;
  const [menu, setMenu] = useState(false);
  const [hover, setHover] = useState(false);
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
          <Pressable
            accessibilityRole="menuitem"
            onPress={() => {
              setMenu(false);
              props.onStart("new");
            }}
            onHoverIn={() => setHover(true)}
            onHoverOut={() => setHover(false)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: 10,
              paddingVertical: 8,
              borderRadius: 6,
              backgroundColor: hover ? theme.colors.surface1 : "transparent",
            }}
          >
            <Icon name="GitBranchPlus" size={15} color={theme.colors.foreground} />
            <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>Start on a new agent</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/** A run tab; active runs get a chevron menu with Cancel (confirmed in place), like the Start split button. */
function RunChip(props: { theme: Theme; run: Run; selected: boolean; onSelect(): void; onCanceled(): void }) {
  const { theme, run, selected } = props;
  const cancel = useRpc(cancelRunRpc);
  const toast = useToast();
  const [menu, setMenu] = useState<"closed" | "open" | "confirm">("closed");
  const color = runStatusColor(theme, run.status);
  const active = !isTerminal(run.status);
  const border = selected ? color : theme.colors.border;
  const text = selected ? color : theme.colors.foregroundMuted;
  return (
    <View style={{ zIndex: menu === "closed" ? 0 : 30 }}>
      <View style={{ flexDirection: "row", borderRadius: 10, borderWidth: 1, borderColor: border, overflow: "hidden" }}>
        <Pressable accessibilityRole="tab" accessibilityState={{ selected }} onPress={props.onSelect} style={{ paddingLeft: 8, paddingRight: active ? 6 : 8, paddingVertical: 2 }}>
          <Text style={{ color: text, fontSize: 11 }}>
            {run.id.replace(/^run_/, "")} · {runStatusLabel(run.status)}
          </Text>
        </Pressable>
        {active ? (
          <>
            <View style={{ width: 1, backgroundColor: border }} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Actions for run ${run.id}`}
              accessibilityState={{ expanded: menu !== "closed" }}
              onPress={() => setMenu((value) => (value === "closed" ? "open" : "closed"))}
              style={{ paddingHorizontal: 5, justifyContent: "center" }}
            >
              <Icon name="ChevronDown" size={12} color={text} />
            </Pressable>
          </>
        ) : null}
      </View>
      {menu !== "closed" ? (
        <View
          accessibilityRole="menu"
          style={{
            position: "absolute",
            top: 26,
            left: 0,
            minWidth: 180,
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
            <Pressable
              accessibilityRole="menuitem"
              onPress={() => setMenu("confirm")}
              style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6 }}
            >
              <Icon name="CircleStop" size={15} color={theme.colors.statusDanger} />
              <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>Cancel run…</Text>
            </Pressable>
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
