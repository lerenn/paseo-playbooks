import { useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { listProjectProfilesRpc, setProfileRpc } from "../shared/contracts";
import type { ProfileInfo } from "../shared/types";
import type { Theme } from "./theme";

/** Turns a profile on or off for a whole project, then refreshes every view of it (the Profiles tab and each open Playbooks panel). */
export function useSetProjectProfile(): (projectId: string, profile: string, active: boolean) => Promise<void> {
  const setProfile = useRpc(setProfileRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  return async (projectId, profile, active) => {
    try {
      await setProfile({ projectId, profile, active });
    } catch (error) {
      toast.show((error as Error).message);
    }
    await queryClient.invalidateQueries({ queryKey: ["playbooks"] });
  };
}

const chipStyle = (theme: Theme) => ({ borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, paddingHorizontal: 8, paddingVertical: 2 }) as const;

/**
 * A project's profiles as a multi-select dropdown: the active ones are chips, `default` is always one, and the menu has a
 * checkbox per profile found in the project's main checkout. The same control is in the Profiles tab and in the panel's bar.
 */
export function ProfilePicker(props: { theme: Theme; label: string; profiles: ProfileInfo[]; onToggle(profile: string, active: boolean): void; zIndex?: number }) {
  const { theme, profiles } = props;
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const muted = theme.colors.foregroundMuted;
  const active = profiles.filter((profile) => profile.active);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap", zIndex: props.zIndex ?? 10 }}>
      <View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Profiles of ${props.label}`}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap", borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: open ? theme.colors.surface2 : theme.colors.surface1, paddingHorizontal: 8, paddingVertical: 4, minWidth: 180 }}
        >
          <View accessibilityLabel="Default repository, always active" style={[chipStyle(theme), { flexDirection: "row", alignItems: "center", gap: 4 }]}>
            <Icon name="Lock" size={10} color={muted} />
            <Text style={{ color: muted, fontSize: 11 }}>default</Text>
          </View>
          {active.map((profile) => (
            <View key={profile.id} style={chipStyle(theme)}>
              <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>{profile.id}</Text>
            </View>
          ))}
          <View style={{ flex: 1 }} />
          <Icon name={open ? "ChevronUp" : "ChevronDown"} size={12} color={muted} />
        </Pressable>
        {open ? (
          <View
            accessibilityRole="menu"
            style={{ position: "absolute", top: 34, left: 0, minWidth: 220, maxHeight: 260, padding: 4, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface2, elevation: 6 }}
          >
            <ScrollView>
              <View accessibilityRole="checkbox" accessibilityState={{ checked: true, disabled: true }} accessibilityLabel="Profile default, always active" style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 7 }}>
                <Icon name="SquareCheck" size={14} color={muted} />
                <Text style={{ color: muted, fontSize: 13 }}>default</Text>
                <Text style={{ color: muted, fontSize: 11 }}>always active</Text>
              </View>
              {profiles.length === 0 ? <Text style={{ color: muted, fontSize: 11, paddingHorizontal: 10, paddingVertical: 6 }}>No profiles in the project's main checkout</Text> : null}
              {profiles.map((profile) => (
                <Pressable
                  key={profile.id}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: profile.active }}
                  accessibilityLabel={`Profile ${profile.id}`}
                  onPress={() => props.onToggle(profile.id, !profile.active)}
                  onHoverIn={() => setHover(profile.id)}
                  onHoverOut={() => setHover((id) => (id === profile.id ? null : id))}
                  style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 6, backgroundColor: hover === profile.id ? theme.colors.surface1 : "transparent" }}
                >
                  <Icon name={profile.active ? "SquareCheck" : "Square"} size={14} color={profile.active ? theme.colors.accent : muted} />
                  <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{profile.id}</Text>
                  <Text style={{ color: muted, fontSize: 11 }}>{profile.playbooks} {profile.playbooks === 1 ? "playbook" : "playbooks"}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** The "Profiles" tab of the Playbooks screen: one row per project, each with its picker. */
export function ProfilesView(props: { theme: Theme; workspaces: Array<{ id: string; projectId: string }> }) {
  const { theme } = props;
  const list = useRpc(listProjectProfilesRpc);
  const setProfile = useSetProjectProfile();
  const input = useMemo(() => {
    const byProject = new Map<string, string>();
    for (const workspace of props.workspaces) if (!byProject.has(workspace.projectId)) byProject.set(workspace.projectId, workspace.id);
    return { workspaces: [...byProject].map(([projectId, workspaceId]) => ({ projectId, workspaceId })).sort((a, b) => a.projectId.localeCompare(b.projectId)) };
  }, [props.workspaces]);
  const query = useQuery({
    queryKey: ["playbooks", "project-profiles", input],
    queryFn: () => list(input),
    enabled: input.workspaces.length > 0,
    refetchInterval: 30_000,
  });
  const projects = [...(query.data?.projects ?? [])].sort((a, b) => a.label.localeCompare(b.label));
  return (
    <View style={{ gap: 10 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        A profile is an extra, opt-in set of playbooks kept in a project's main checkout. Turning one on applies to every workspace of the project.
      </Text>
      {query.error ? <Text style={{ color: theme.colors.statusDanger }}>{(query.error as Error).message}</Text> : null}
      {query.isLoading ? <Text style={{ color: theme.colors.foregroundMuted }}>Loading…</Text> : null}
      {projects.map((project, index) => (
        <View key={project.projectId} style={{ zIndex: projects.length - index, gap: 6, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", minWidth: 120 }}>{project.label}</Text>
            <ProfilePicker theme={theme} label={project.label} profiles={project.profiles} onToggle={(profile, active) => void setProfile(project.projectId, profile, active)} zIndex={projects.length - index} />
          </View>
          {project.diagnostics.map((note) => (
            <Text key={note} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {note}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}
