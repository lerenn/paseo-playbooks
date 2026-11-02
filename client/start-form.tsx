import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { listWorkspaceAgents, startRun } from "../shared/contracts";
import type { Playbook, VarValue } from "../shared/types";
import { Button } from "./sheet";
import type { Theme } from "./theme";

function initialValues(playbook: Playbook): Record<string, string | boolean> {
  return Object.fromEntries(
    Object.entries(playbook.inputs).map(([name, def]) => [
      name,
      def.type === "boolean" ? def.default === true : def.default !== undefined ? String(def.default) : def.type === "enum" ? def.values?.[0] ?? "" : "",
    ]),
  );
}

export function StartForm(props: {
  theme: Theme;
  playbook: Playbook;
  workspaceId: string;
  /** "current": the workspace's agent manages the run here; "new": a new worktree and manager. */
  target: "current" | "new";
  onClose(): void;
  /** reusedAgent: an existing agent of this workspace manages the run (no new worktree). */
  onStarted(result: { workspaceId: string; managerAgentId: string; reusedAgent: boolean }): void;
  compact: boolean;
}) {
  const { theme, playbook } = props;
  const start = useRpc(startRun);
  const toast = useToast();
  const [values, setValues] = useState(() => initialValues(playbook));
  const [busy, setBusy] = useState(false);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const listAgents = useRpc(listWorkspaceAgents);
  const agents = useQuery({ queryKey: ["playbooks", "agents", props.workspaceId], queryFn: () => listAgents({ workspaceId: props.workspaceId }) });
  const current = props.target === "current";
  /** The current agent: the most recent agent of the workspace that manages no active run. */
  const manager = current ? agents.data?.agents.find((agent) => !agent.managing) ?? null : null;
  const blocked = current && (agents.isLoading || manager === null);
  /** Descriptions shown on hover (desktop, web); pressing pins them (phones have no hover). */
  const [hovered, setHovered] = useState<string | null>(null);
  const [info, setInfo] = useState<Set<string>>(() => new Set());
  const toggleInfo = (name: string) =>
    setInfo((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const compact = props.compact;
  const set = (name: string, value: string | boolean) => setValues((current) => ({ ...current, [name]: value }));

  const submit = async (force: boolean) => {
    setBusy(true);
    try {
      const inputs: Record<string, VarValue> = {};
      for (const [name, def] of Object.entries(playbook.inputs)) {
        const value = values[name];
        if (value === "" || value === undefined) continue;
        inputs[name] = def.type === "number" ? Number(value) : value;
      }
      const agentId = manager?.id;
      const result = await start({ workspaceId: props.workspaceId, playbook: playbook.id, inputs, force, ...(agentId ? { agentId } : {}) });
      if (result.status === "duplicate") {
        setDuplicate(result.message);
        return;
      }
      toast.show(result.queued ? `Queued ${result.runId}: the agent starts it when its current turn ends` : `Started ${result.runId}`, { variant: "success" });
      props.onStarted({ workspaceId: result.workspaceId, managerAgentId: result.managerAgentId, reusedAgent: agentId !== undefined });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const fieldStyle = {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 8,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
  } as const;

  return (
    <Modal title={`Start · ${playbook.title}`} open onOpenChange={(open) => !open && props.onClose()}>
      <Modal.Content>
        {playbook.description ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{playbook.description}</Text> : null}
        <Text style={{ color: current && !agents.isLoading && !manager ? theme.colors.statusWarning : theme.colors.foregroundMuted, fontSize: 12 }}>
          {!current
            ? "Creates a worktree on a new branch from this workspace, with a new Playbook Manager agent in it."
            : agents.isLoading
              ? "Finding this workspace's agent…"
              : manager
                ? `${manager.title ?? manager.id.slice(0, 8)} manages the run, in this workspace on its current branch. It is reloaded to get the playbook tools, then receives the kickoff${manager.status === "running" ? " when its current turn ends (it is busy now; it is not interrupted)" : ""}.`
                : "No agent in this workspace can manage the run. Use “Start on a new agent” instead."}
        </Text>
        {Object.keys(playbook.inputs).length > 0 ? (
          <View style={{ borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border }}>
            {Object.entries(playbook.inputs).map(([name, def], index) => (
              <View
                key={name}
                style={{
                  flexDirection: compact ? "column" : "row",
                  alignItems: compact ? "stretch" : "center",
                  gap: compact ? 6 : 12,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  borderTopWidth: index === 0 ? 0 : 1,
                  borderTopColor: theme.colors.border,
                  // The open tooltip must sit above the following rows.
                  zIndex: hovered === name || info.has(name) ? 10 : 0,
                }}
              >
                <View style={{ width: compact ? undefined : 140, gap: 4 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, zIndex: 10 }}>
                    <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flexShrink: 1 }}>
                      {name}
                      {def.required ? <Text style={{ color: theme.colors.statusDanger }}> *</Text> : null}
                    </Text>
                    {def.description ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${info.has(name) ? "Hide" : "Show"} description of ${name}`}
                        hitSlop={8}
                        onHoverIn={() => setHovered(name)}
                        onHoverOut={() => setHovered((current) => (current === name ? null : current))}
                        onPress={() => toggleInfo(name)}
                      >
                        <Icon name="Info" size={13} color={hovered === name || info.has(name) ? theme.colors.accent : theme.colors.foregroundMuted} />
                      </Pressable>
                    ) : null}
                    {def.description && (hovered === name || info.has(name)) ? (
                      <View
                        pointerEvents="none"
                        accessibilityLiveRegion="polite"
                        style={{
                          position: "absolute",
                          top: 22,
                          left: 0,
                          width: 260,
                          padding: 8,
                          borderRadius: 8,
                          borderWidth: 1,
                          borderColor: theme.colors.border,
                          backgroundColor: theme.colors.surface0,
                          elevation: 6,
                        }}
                      >
                        <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{def.description}</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{def.type === "enum" ? "choice" : def.type}</Text>
                </View>
                <View style={{ flex: compact ? undefined : 1, gap: 6 }}>
                {def.type === "boolean" ? (
                  <Switch accessibilityLabel={name} value={values[name] === true} onValueChange={(value) => set(name, value)} />
                ) : def.type === "enum" ? (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                    {(def.values ?? []).map((option) => {
                      const selected = values[name] === option;
                      return (
                        <Pressable
                          key={option}
                          accessibilityRole="radio"
                          accessibilityState={{ selected }}
                          onPress={() => set(name, option)}
                          style={{ borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: selected ? theme.colors.accent : theme.colors.surface2 }}
                        >
                          <Text style={{ color: selected ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 13 }}>{option}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : (
                  <TextInput
                    accessibilityLabel={name}
                    value={String(values[name] ?? "")}
                    onChangeText={(text) => set(name, text)}
                    keyboardType={def.type === "number" ? "numeric" : "default"}
                    multiline={def.type === "string" && name === "request"}
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={[fieldStyle, def.type === "string" && name === "request" ? { minHeight: 72 } : {}]}
                  />
                )}
                </View>
              </View>
            ))}
          </View>
        ) : null}
        {duplicate ? (
          <View style={{ gap: 6 }}>
            <Text style={{ color: theme.colors.statusWarning, fontSize: 13 }}>{duplicate}</Text>
            <Button theme={theme} kind="primary" label="Start anyway" disabled={busy} onPress={() => void submit(true)} />
          </View>
        ) : (
          <Button theme={theme} kind="primary" label={busy ? "Starting…" : "Start"} disabled={busy || blocked} onPress={() => void submit(false)} />
        )}
      </Modal.Content>
    </Modal>
  );
}
