import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { listWorkspaceAgents, startRun } from "../shared/contracts";
import type { Playbook, VarValue } from "../shared/types";
import { sanitizeWorkspaceName, WORKSPACE_NAME_MAX } from "../shared/workspace-name";
import { inputErrors, type RunProject } from "./run-form";
import { Button } from "./sheet";
import type { Theme } from "./theme";

export type StartTarget = "current" | "agent" | "workspace";

function initialValues(playbook: Playbook): Record<string, string | boolean> {
  return Object.fromEntries(
    Object.entries(playbook.inputs).map(([name, def]) => [
      name,
      def.type === "boolean" ? def.default === true : def.default !== undefined ? String(def.default) : def.type === "enum" ? def.values?.[0] ?? "" : "",
    ]),
  );
}

/** A playbook's description: a closed disclosure row (chevron and "Description") that expands to the full text. */
export function DescriptionToggle(props: { theme: Theme; description: string }) {
  const { theme } = props;
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${open ? "Hide" : "Show"} description`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} size={16} color={theme.colors.foregroundMuted} />
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>Description</Text>
      </Pressable>
      {open ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{props.description}</Text> : null}
    </View>
  );
}

export function StartForm(props: {
  theme: Theme;
  playbook: Playbook;
  workspaceId: string;
  /** "current": the workspace's agent manages the run here; "agent": a new manager in this workspace; "workspace": a new worktree and manager. */
  target: StartTarget;
  onClose(): void;
  /** sameWorkspace: the manager is in this workspace (open the agent rather than a new workspace). */
  onStarted(result: { workspaceId: string; managerAgentId: string; sameWorkspace: boolean }): void;
  compact: boolean;
  /** The Run Playbook form: its title and the playbook dropdown shown above the inputs. */
  title?: string;
  picker?: ReactNode;
}) {
  const { theme, playbook } = props;
  const start = useRpc(startRun);
  const toast = useToast();
  const [values, setValues] = useState(() => initialValues(playbook));
  const [busy, setBusy] = useState(false);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  /** Shown inline in the form: a failed start, or the inputs that are missing. */
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
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
    const problems = inputErrors(playbook, values);
    setFieldErrors(problems);
    setError(null);
    if (Object.keys(problems).length > 0) {
      setError("Fill in the highlighted inputs.");
      return;
    }
    setBusy(true);
    try {
      const inputs: Record<string, VarValue> = {};
      for (const [name, def] of Object.entries(playbook.inputs)) {
        const value = values[name];
        if (value === "" || value === undefined) continue;
        inputs[name] = def.type === "number" ? Number(value) : value;
      }
      const agentId = manager?.id;
      const result = await start({
        workspaceId: props.workspaceId,
        playbook: playbook.id,
        inputs,
        force,
        sameWorkspace: props.target === "agent",
        ...(props.target === "workspace" && sanitizeWorkspaceName(workspaceName) ? { workspaceName: sanitizeWorkspaceName(workspaceName)! } : {}),
        ...(agentId ? { agentId } : {}),
      });
      if (result.status === "duplicate") {
        setDuplicate(result.message);
        return;
      }
      const where = props.target === "workspace" ? sanitizeWorkspaceName(workspaceName) || playbook.title : "this workspace";
      toast.show(result.queued ? `Queued ${playbook.title} in ${where}: the agent starts it when its current turn ends` : `Started ${playbook.title} in ${where}`, { variant: "success" });
      props.onStarted({ workspaceId: result.workspaceId, managerAgentId: result.managerAgentId, sameWorkspace: props.target !== "workspace" });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
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
    <Modal title={props.title ?? `Start · ${playbook.title}`} open onOpenChange={(open) => !open && props.onClose()}>
      <Modal.Content>
        {props.picker}
        {props.target === "workspace" ? (
          <View style={{ gap: 4 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>Workspace name</Text>
            <TextInput
              accessibilityLabel="Workspace name"
              value={workspaceName}
              onChangeText={setWorkspaceName}
              maxLength={WORKSPACE_NAME_MAX}
              placeholder={`Optional: default is “${playbook.title}: …”`}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={fieldStyle}
            />
          </View>
        ) : null}
        <Text style={{ color: current && !agents.isLoading && !manager ? theme.colors.statusWarning : theme.colors.foregroundMuted, fontSize: 12 }}>
          {props.target === "workspace"
            ? "Creates a new workspace (a worktree on a new branch from this one), with a new Playbook Manager agent in it."
            : props.target === "agent"
              ? "Creates a new Playbook Manager agent in this workspace; the run uses this workspace's current branch."
              : agents.isLoading
              ? "Finding this workspace's agent…"
              : manager
                ? `${manager.title ?? manager.id.slice(0, 8)} manages the run, in this workspace on its current branch. It is reloaded to get the playbook tools, then receives the kickoff${manager.status === "running" ? " when its current turn ends (it is busy now; it is not interrupted)" : ""}.`
                : "No agent in this workspace can manage the run. Use “Start on a new agent” instead."}
        </Text>
        {playbook.description ? <DescriptionToggle theme={theme} description={playbook.description} /> : null}
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
                    style={[fieldStyle, def.type === "string" && name === "request" ? { minHeight: 72 } : {}, fieldErrors[name] ? { borderColor: theme.colors.statusDanger } : {}]}
                  />
                )}
                {fieldErrors[name] ? <Text style={{ color: theme.colors.statusDanger, fontSize: 11 }}>{fieldErrors[name]}</Text> : null}
                </View>
              </View>
            ))}
          </View>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" selectable style={{ color: theme.colors.statusDanger, fontSize: 13 }}>
            {error}
          </Text>
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

/**
 * The panel's "Run Playbook" form: pick a playbook of this workspace's project, name the new workspace, fill in the
 * inputs and start the run in a new workspace. It is the start form with a playbook dropdown above the inputs.
 */
export function RunPlaybookForm(props: {
  theme: Theme;
  playbooks: Playbook[];
  workspaceId: string;
  onClose(): void;
  onStarted(result: { workspaceId: string; managerAgentId: string; sameWorkspace: boolean }): void;
  compact: boolean;
  /** Shown above the playbook dropdown (the overview's project selector). */
  lead?: ReactNode;
}) {
  const { theme, playbooks } = props;
  const [selected, setSelected] = useState(playbooks[0]?.id ?? "");
  const [open, setOpen] = useState(false);
  const playbook = playbooks.find((candidate) => candidate.id === selected);
  if (!playbook) return null;
  const picker = (
    <>
    {props.lead}
    <View style={{ gap: 4, zIndex: 20 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>Playbook</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Playbook: ${playbook.title}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, padding: 8, backgroundColor: theme.colors.surface2 }}
      >
        <Text style={{ color: theme.colors.foreground, fontSize: 13, flexShrink: 1 }}>{playbook.title}</Text>
        <Icon name="ChevronDown" size={14} color={theme.colors.foregroundMuted} />
      </Pressable>
      {open ? (
        <View accessibilityRole="menu" style={{ borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface2, padding: 4 }}>
          {playbooks.map((candidate) => (
            <Pressable
              key={candidate.id}
              accessibilityRole="menuitem"
              accessibilityState={{ selected: candidate.id === selected }}
              onPress={() => {
                setSelected(candidate.id);
                setOpen(false);
              }}
              style={{ paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6, backgroundColor: candidate.id === selected ? theme.colors.surface1 : "transparent" }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{candidate.title}</Text>
              {candidate.id !== candidate.title ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{candidate.id}</Text> : null}
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
    </>
  );
  return (
    <StartForm
      key={playbook.id}
      theme={theme}
      playbook={playbook}
      workspaceId={props.workspaceId}
      target="workspace"
      title="Run Playbook"
      picker={picker}
      compact={props.compact}
      onClose={props.onClose}
      onStarted={props.onStarted}
    />
  );
}

/** The Run Playbook button, in the panel and the overview. Disabled while the playbook lists load. */
export function RunPlaybookButton(props: { theme: Theme; loading?: boolean; onPress(): void }) {
  const { theme } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Run Playbook: start a playbook in a new workspace"
      accessibilityState={{ disabled: props.loading === true }}
      disabled={props.loading === true}
      onPress={props.onPress}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: theme.colors.accent, backgroundColor: theme.colors.accent, opacity: props.loading ? 0.5 : 1 }}
    >
      <Icon name="Play" size={13} color={theme.colors.accentForeground} />
      <Text style={{ color: theme.colors.accentForeground, fontSize: 13, fontWeight: "600" }}>Run Playbook</Text>
    </Pressable>
  );
}

/** The overview's project selector: a dropdown of the projects that have a runnable playbook. */
export function ProjectPicker(props: { theme: Theme; projects: RunProject[]; selected: string | null; onSelect(projectId: string): void }) {
  const { theme } = props;
  const [open, setOpen] = useState(false);
  const current = props.projects.find((project) => project.projectId === props.selected);
  return (
    <View style={{ gap: 4, zIndex: 30 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>Project</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Project: ${current?.label ?? "choose one"}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, padding: 8, backgroundColor: theme.colors.surface2 }}
      >
        <Text style={{ color: current ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 13, flexShrink: 1 }}>{current?.label ?? "Choose a project"}</Text>
        <Icon name="ChevronDown" size={14} color={theme.colors.foregroundMuted} />
      </Pressable>
      {open ? (
        <View accessibilityRole="menu" style={{ borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface2, padding: 4 }}>
          {props.projects.map((project) => (
            <Pressable
              key={project.projectId}
              accessibilityRole="menuitem"
              accessibilityState={{ selected: project.projectId === props.selected }}
              onPress={() => {
                props.onSelect(project.projectId);
                setOpen(false);
              }}
              style={{ paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6, backgroundColor: project.projectId === props.selected ? theme.colors.surface1 : "transparent" }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{project.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** The overview's Run Playbook form: choose a project, then the usual form for that project's playbooks. */
export function OverviewRunForm(props: {
  theme: Theme;
  projects: RunProject[];
  /** Playbooks to offer per project (already filtered to the runnable ones). */
  playbooksOf: Map<string, Playbook[]>;
  initial: string | null;
  compact: boolean;
  onClose(): void;
  onStarted(result: { workspaceId: string; managerAgentId: string; sameWorkspace: boolean }): void;
}) {
  const [selected, setSelected] = useState<string | null>(props.initial);
  const project = props.projects.find((candidate) => candidate.projectId === selected);
  const playbooks = (project && props.playbooksOf.get(project.projectId)) || [];
  const picker = <ProjectPicker theme={props.theme} projects={props.projects} selected={selected} onSelect={setSelected} />;
  if (project && playbooks.length > 0) {
    return <RunPlaybookForm key={project.projectId} theme={props.theme} playbooks={playbooks} workspaceId={project.workspaceId} compact={props.compact} lead={picker} onClose={props.onClose} onStarted={props.onStarted} />;
  }
  // No project chosen yet: only the selector, no Start.
  return (
    <Modal title="Run Playbook" open onOpenChange={(open) => !open && props.onClose()}>
      <Modal.Content>
        {picker}
        <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 12 }}>Choose the project to start a playbook in.</Text>
      </Modal.Content>
    </Modal>
  );
}
