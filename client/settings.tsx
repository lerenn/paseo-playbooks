import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text } from "react-native";
import { capSettings } from "../shared/settings";

/** Edits the daemon-side cap: allowed agent modes per provider. */
export function CapSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(capSettings);
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [newProvider, setNewProvider] = useState("");
  if (settings.status === "loading") return <Text style={{ color: theme.colors.foregroundMuted }}>Loading…</Text>;
  if (settings.status === "error") return <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>;
  const saved = settings.status === "ready" ? settings.values.allowedModes : {};
  const current = draft ?? Object.fromEntries(Object.entries(saved).map(([provider, modes]) => [provider, modes.join(", ")]));
  const save = async () => {
    const allowedModes = Object.fromEntries(
      Object.entries(current)
        .filter(([provider]) => provider.trim())
        .map(([provider, text]) => [provider.trim(), text.split(",").map((mode) => mode.trim()).filter(Boolean)]),
    );
    if (await settings.save({ allowedModes }, settings.status === "ready" || settings.status === "invalid" ? settings.revision : "")) setDraft(null);
  };
  return (
    <SettingsSection title="Allowed agent modes">
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, marginBottom: 8 }}>
        Playbooks come from the workspace, so any branch can ship one. A playbook whose manager or steps ask for a mode not
        listed here fails validation. Leaving a mode unset in a playbook (the provider's default) is always allowed.
      </Text>
      <SettingsCard>
        {Object.entries(current).map(([provider, modes]) => (
          <SettingsInput
            key={provider}
            label={provider}
            hint="Comma-separated modes, e.g. default, acceptEdits, bypassPermissions"
            initialValue={modes}
            onChangeText={(text) => setDraft({ ...current, [provider]: text })}
          />
        ))}
        <SettingsInput label="Add provider" placeholder="e.g. codex" initialValue="" onChangeText={setNewProvider} />
        <SettingsAction
          label="Add"
          actionLabel="Add provider"
          disabled={!newProvider.trim() || newProvider.trim() in current}
          onPress={() => setDraft({ ...current, [newProvider.trim()]: "" })}
        />
        <SettingsRow label={settings.saveError ?? (draft ? "Unsaved changes" : "Saved")} />
        <SettingsAction label="Save" actionLabel={settings.saving ? "Saving…" : "Save"} disabled={!draft || settings.saving} onPress={() => void save()} />
      </SettingsCard>
    </SettingsSection>
  );
}
