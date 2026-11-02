import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { startRun } from "../shared/contracts";
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
  onClose(): void;
  onStarted(workspaceId: string): void;
  compact: boolean;
}) {
  const { theme, playbook } = props;
  const start = useRpc(startRun);
  const toast = useToast();
  const [values, setValues] = useState(() => initialValues(playbook));
  const [busy, setBusy] = useState(false);
  const [duplicate, setDuplicate] = useState<string | null>(null);
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
      const result = await start({ workspaceId: props.workspaceId, playbook: playbook.id, inputs, force });
      if (result.status === "duplicate") {
        setDuplicate(result.message);
        return;
      }
      toast.show(`Started ${result.runId}`, { variant: "success" });
      props.onStarted(result.workspaceId);
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
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          Start creates a worktree on a new branch from this workspace, then a Playbook Manager agent there.
        </Text>
        {Object.keys(playbook.inputs).length > 0 ? (
          <View style={{ borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, overflow: "hidden" }}>
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
                }}
              >
                <View style={{ width: compact ? undefined : 140, gap: 4 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flexShrink: 1 }}>
                      {name}
                      {def.required ? <Text style={{ color: theme.colors.statusDanger }}> *</Text> : null}
                    </Text>
                    {def.description ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${info.has(name) ? "Hide" : "Show"} description of ${name}`}
                        hitSlop={8}
                        onPress={() => toggleInfo(name)}
                      >
                        <Icon name="Info" size={13} color={info.has(name) ? theme.colors.accent : theme.colors.foregroundMuted} />
                      </Pressable>
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
                  {def.description && info.has(name) ? (
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{def.description}</Text>
                  ) : null}
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
          <Button theme={theme} kind="primary" label={busy ? "Starting…" : "Start"} disabled={busy} onPress={() => void submit(false)} />
        )}
      </Modal.Content>
    </Modal>
  );
}
