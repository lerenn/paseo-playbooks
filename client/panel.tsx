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
      <View style={{ flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: pad, paddingTop: 8, paddingBottom: 4 }}>
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
  const [starting, setStarting] = useState(false);
  const runId = selected ?? active?.id ?? card.runs[0]?.id ?? "definition";
  const run = runId === "definition" ? null : card.runs.find((candidate) => candidate.id === runId) ?? null;
  const playbook: Playbook | null = run?.playbook ?? card.entry?.playbook ?? null;
  const title = playbook?.title ?? card.entry?.title ?? card.id;
  const errors = card.entry?.errors ?? [];

  return (
    <View style={{ borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, padding: 10, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
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
        {card.entry?.playbook ? <Button theme={theme} kind="primary" label="▶ Start" onPress={() => setStarting(true)} accessibilityLabel={`Start ${title}`} /> : null}
      </View>
      {errors.map((error) => (
        <Text key={error} selectable style={{ color: theme.colors.statusDanger, fontSize: 12 }}>
          ⚠ {error}
        </Text>
      ))}
      {expanded && card.runs.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {[...card.runs.map((candidate) => ({ id: candidate.id, label: `${candidate.id.replace(/^run_/, "")} · ${runStatusLabel(candidate.status)}`, color: runStatusColor(theme, candidate.status) })), card.entry?.playbook ? { id: "definition", label: "definition", color: theme.colors.foregroundMuted } : null]
            .filter((chip): chip is { id: string; label: string; color: string } => chip !== null)
            .map((chip) => {
              const isSelected = chip.id === runId;
              return (
                <Pressable
                  key={chip.id}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: isSelected }}
                  onPress={() => setSelected(chip.id)}
                  style={{ borderRadius: 10, borderWidth: 1, borderColor: isSelected ? chip.color : theme.colors.border, paddingHorizontal: 8, paddingVertical: 2 }}
                >
                  <Text style={{ color: isSelected ? chip.color : theme.colors.foregroundMuted, fontSize: 11 }}>{chip.label}</Text>
                </Pressable>
              );
            })}
        </View>
      ) : null}
      {expanded && run ? <RunBar theme={theme} run={run} hostLabel={props.hostLabel} onDone={() => void queryClient.invalidateQueries({ queryKey: ["playbooks"] })} /> : null}
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
          onClose={() => setStarting(false)}
          onStarted={(workspaceId) => {
            setStarting(false);
            void queryClient.invalidateQueries({ queryKey: ["playbooks"] });
            props.onOpenWorkspace(workspaceId);
          }}
        />
      ) : null}
    </View>
  );
}

function RunBar(props: { theme: Theme; run: Run; hostLabel: string; onDone(): void }) {
  const { theme, run } = props;
  const cancel = useRpc(cancelRunRpc);
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const pending = run.gates.filter((gate) => gate.status === "pending");
  const color = runStatusColor(theme, run.status);
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
        <Text style={{ color, fontSize: 12, fontWeight: "600" }}>{runStatusLabel(run.status)}</Text>
        {run.branch ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>· {run.branch}</Text> : null}
        <View style={{ flex: 1 }} />
        {!isTerminal(run.status) ? (
          confirming ? (
            <View style={{ flexDirection: "row", gap: 6 }}>
              <Button
                theme={theme}
                kind="danger"
                label="Cancel run"
                onPress={() =>
                  void cancel({ runId: run.id })
                    .then(() => {
                      setConfirming(false);
                      props.onDone();
                    })
                    .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
                }
              />
              <Button theme={theme} label="Keep" onPress={() => setConfirming(false)} />
            </View>
          ) : (
            <Button theme={theme} label="Cancel…" onPress={() => setConfirming(true)} accessibilityLabel="Cancel this run" />
          )
        ) : null}
      </View>
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
