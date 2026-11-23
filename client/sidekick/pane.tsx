import { openExternalUrl, useRpc, useTranslation } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanResponder, Pressable, Text, View } from "react-native";
import { createSidekickFilesRpc, listSidekicksRpc, openSidekickRpc, restartSidekickRpc, type SidekickProject } from "../../shared/contracts";
import { GETTING_STARTED_URL } from "../panel";
import { Button } from "../sheet";
import { messages } from "../i18n";
import type { Theme } from "../theme";
import { semanticColor } from "../semantic-colors";
import { SidekickChat } from "./column";
import { statusLine, visibleTabs } from "./tabs";
import { clampColumnWidth } from "./width";
import { resolveSelected, sidekickUi, useSidekickUi } from "./ui-state";

/** How often the tabs refresh which projects have runs or a Sidekick. */
const POLL_MS = 15_000;

/** A workspace of the host, as the Playbooks screen lists them. */
export interface PaneWorkspace {
  id: string;
  projectId: string;
  projectLabel: string;
}

interface Props {
  theme: Theme;
  workspaces: PaneWorkspace[];
  openAgent?: ((agentId: string) => void) | undefined;
  onClose: () => void;
}

/**
 * The Sidekick column of the Playbooks screen: one tab per project that has active runs or a Sidekick,
 * a "+" tab to add another project, and under them that project's chat, or the tutorial when it has no
 * Sidekick files yet.
 */
export function SidekickPane(props: Props) {
  const { theme } = props;
  const { t } = useTranslation(messages);
  const ui = useSidekickUi();
  const width = ui.width;
  const startWidth = useRef(width);
  // A handle on the left edge: dragging left widens the column.
  const resizer = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          startWidth.current = sidekickUi.get().width;
        },
        onPanResponderMove: (_event, gesture) => {
          sidekickUi.setWidth(clampColumnWidth(startWidth.current - gesture.dx));
        },
      }),
    [],
  );
  const list = useRpc(listSidekicksRpc);
  const open = useRpc(openSidekickRpc);
  const restart = useRpc(restartSidekickRpc);
  const toast = useToast();
  const [projects, setProjects] = useState<SidekickProject[]>([]);
  const added = ui.added;
  const selected = ui.selectedProjectId;
  const setSelected = sidekickUi.select;
  const [adding, setAdding] = useState(false);
  const [opening, setOpening] = useState<{ projectId: string; error: string | null } | null>(null);
  /** The agent of each project this pane has opened (a tab's chat), ahead of the next list. */
  const [agents, setAgents] = useState<Record<string, string>>({});

  // One representative workspace per project.
  const byProject = useMemo(() => {
    const map = new Map<string, PaneWorkspace>();
    for (const workspace of props.workspaces) if (!map.has(workspace.projectId)) map.set(workspace.projectId, workspace);
    return [...map.values()];
  }, [props.workspaces]);
  const input = useMemo(() => ({ workspaces: byProject.map((workspace) => ({ projectId: workspace.projectId, workspaceId: workspace.id })) }), [byProject]);

  const refresh = useCallback(async () => {
    if (input.workspaces.length === 0) return;
    try {
      setProjects((await list(input)).projects);
    } catch (error) {
      console.error("[playbooks] sidekick list failed", error);
    }
  }, [list, input]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    void refreshRef.current();
    const timer = setInterval(() => void refreshRef.current(), POLL_MS);
    return () => clearInterval(timer);
  }, [input]);

  const tabs = visibleTabs(projects, added);
  const current = projects.find((project) => project.projectId === selected) ?? null;
  // Select the first tab once the list is there; a tab that disappeared falls back to the first.
  useEffect(() => {
    if (adding) return;
    if (projects.length === 0) return;
    const next = resolveSelected(selected, tabs.map((tab) => tab.projectId));
    if (next !== selected) setSelected(next);
  }, [tabs, selected, adding, projects.length]);

  // A configured project's tab opens (creates or reuses) its Sidekick agent.
  const agentId = current ? (agents[current.projectId] ?? current.agentId) : null;
  useEffect(() => {
    if (!current || !current.configured || current.errors.length > 0 || agentId) return;
    let live = true;
    setOpening({ projectId: current.projectId, error: null });
    open({ workspaceId: current.workspaceId })
      .then((result) => {
        if (!live) return;
        setAgents((all) => ({ ...all, [result.projectId]: result.agentId }));
        setOpening(null);
        void refreshRef.current();
      })
      .catch((error: unknown) => live && setOpening({ projectId: current.projectId, error: error instanceof Error ? error.message : t("sidekick.openFailed") }));
    return () => {
      live = false;
    };
  }, [current?.projectId, current?.configured, current?.errors.length, agentId, open]);

  const status = current ? statusLine(t, current) : null;
  const others = projects.filter((project) => !tabs.some((tab) => tab.projectId === project.projectId));
  const muted = theme.colors.foregroundMuted;
  return (
    <View style={{ width, borderLeftWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface0 }}>
      <View
        accessibilityRole="adjustable"
        accessibilityLabel={t("sidekick.resize")}
        {...resizer.panHandlers}
        style={[{ position: "absolute", left: -3, top: 0, bottom: 0, width: 6, zIndex: 10 }, { cursor: "col-resize" } as object]}
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 12, paddingBottom: 8 }}>
        <Icon name="Bot" size={16} color={theme.colors.foreground} />
        <Text style={{ color: theme.colors.foreground, fontWeight: "700", flex: 1 }}>{t("sidekick.name")}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t("sidekick.close")} hitSlop={8} onPress={props.onClose}>
          <Icon name="X" size={16} color={muted} />
        </Pressable>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, borderBottomWidth: 1, borderColor: theme.colors.border }} contentContainerStyle={{ paddingHorizontal: 8, gap: 4, alignItems: "center" }}>
        {tabs.map((tab) => (
          <TabButton
            key={tab.projectId}
            theme={theme}
            label={tab.label}
            active={!adding && tab.projectId === selected}
            dot={tab.activeRuns > 0}
            onPress={() => {
              setAdding(false);
              setSelected(tab.projectId);
            }}
          />
        ))}
        <TabButton theme={theme} label="+" accessibilityLabel={t("sidekick.addTab")} active={adding} onPress={() => setAdding(!adding)} />
      </ScrollView>

      {!adding && current && status ? (
        <Text accessibilityLabel={t("sidekick.status", { label: current.label, status })} style={{ color: current.needYou > 0 ? semanticColor(theme, "waiting") : muted, fontSize: 12, paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1, borderColor: theme.colors.border }}>
          {status}
        </Text>
      ) : null}

      {adding ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 8 }}>
          <Text style={{ color: muted, fontSize: 12 }}>{others.length > 0 ? t("sidekick.addIntro") : t("sidekick.allAdded")}</Text>
          {others.map((project) => (
            <Pressable
              key={project.projectId}
              accessibilityRole="button"
              onPress={() => {
                sidekickUi.addProject(project.projectId);
                setSelected(project.projectId);
                setAdding(false);
              }}
              style={{ borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, padding: 10, flexDirection: "row", alignItems: "center", gap: 8 }}
            >
              <Text style={{ color: theme.colors.foreground, flex: 1 }} numberOfLines={1}>{project.label}</Text>
              {!project.configured ? <Text style={{ color: muted, fontSize: 11 }}>{t("sidekick.notSetUp")}</Text> : null}
            </Pressable>
          ))}
        </ScrollView>
      ) : !current ? (
        <View style={{ padding: 16 }}>
          <Text style={{ color: muted, fontSize: 13 }}>
            {projects.length === 0 ? t("sidekick.loading") : t("sidekick.noProjects")}
          </Text>
        </View>
      ) : !current.configured ? (
        <SetUp theme={theme} project={current} onCreated={() => refresh()} />
      ) : current.errors.length > 0 ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 8 }}>
          <Text style={{ color: semanticColor(theme, "failed"), fontWeight: "600" }}>{t("sidekick.filesErrors", { label: current.label })}</Text>
          {current.errors.map((error) => (
            <Text key={error} selectable style={{ color: muted, fontSize: 12 }}>{error}</Text>
          ))}
        </ScrollView>
      ) : (
        <SidekickChat
          key={agentId ?? current.projectId}
          theme={theme}
          agentId={agentId}
          projectId={current.projectId}
          compacting={current.compacting}
          status={{ loading: opening?.projectId === current.projectId && !opening.error, error: opening?.projectId === current.projectId ? opening.error : null }}
          onRestart={async () => {
            try {
              const result = await restart({ workspaceId: current.workspaceId });
              setAgents((all) => ({ ...all, [result.projectId]: result.agentId }));
              toast.show(t("sidekick.restarted"), { variant: "success" });
              void refreshRef.current();
            } catch (error) {
              toast.error(error instanceof Error ? error.message : t("sidekick.restartFailed"));
            }
          }}
          onOpenTab={agentId && props.openAgent ? () => props.openAgent!(agentId) : undefined}
        />
      )}
    </View>
  );
}

function TabButton(props: { theme: Theme; label: string; active: boolean; dot?: boolean; accessibilityLabel?: string; onPress: () => void }) {
  const { theme } = props;
  const { t } = useTranslation(messages);
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={props.accessibilityLabel ?? (props.dot ? t("sidekick.tabActive", { label: props.label }) : props.label)}
      {...({ title: props.dot ? t("sidekick.tabActiveTitle") : undefined } as object)}
      accessibilityState={{ selected: props.active }}
      onPress={props.onPress}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: 2, borderColor: props.active ? theme.colors.accent : "transparent" }}
    >
      <Text style={{ color: props.active ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 13, fontWeight: props.active ? "700" : "500" }} numberOfLines={1}>
        {props.label}
      </Text>
      {props.dot ? <View accessibilityLabel={t("sidekick.tabActiveTitle")} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: semanticColor(theme, "running") }} /> : null}
    </Pressable>
  );
}

/** A project without Sidekick files: what a Sidekick is and the button that writes the starter files. */
function SetUp(props: { theme: Theme; project: SidekickProject; onCreated: () => void }) {
  const { theme, project } = props;
  const { t } = useTranslation(messages);
  const toast = useToast();
  const create = useRpc(createSidekickFilesRpc);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const guide = () => void openExternalUrl(GETTING_STARTED_URL).catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
  const write = async () => {
    setBusy(true);
    try {
      const { files } = await create({ workspaceId: project.workspaceId });
      toast.show(t("sidekick.setup.created", { count: files.length, files: files.join(t("sidekick.setup.and")) }), { variant: "success" });
      props.onCreated();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, gap: 12, alignItems: "center" }}>
      <Icon name="Bot" size={32} color={theme.colors.foregroundMuted} />
      <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600", textAlign: "center" }}>{t("sidekick.setup.none", { label: project.label })}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, textAlign: "center" }}>
        {t("sidekick.setup.about")}
      </Text>
      {confirming ? (
        <>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, textAlign: "center" }}>
            {t("sidekick.setup.confirm")}
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button theme={theme} kind="primary" label={busy ? t("sidekick.setup.creating") : t("sidekick.setup.createFiles")} disabled={busy} onPress={() => void write()} />
            <Button theme={theme} label={t("sidekick.setup.cancel")} disabled={busy} onPress={() => setConfirming(false)} />
          </View>
        </>
      ) : (
        <>
          <Button theme={theme} kind="primary" label={t("sidekick.setup.createSidekickFiles")} onPress={() => setConfirming(true)} />
          <Button theme={theme} label={t("sidekick.setup.readGuide")} onPress={guide} accessibilityLabel={t("sidekick.setup.readGuideLabel")} />
        </>
      )}
    </ScrollView>
  );
}
