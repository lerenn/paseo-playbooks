import { useTranslation } from "@getpaseo/plugin/client";
import { Icon, TextInput } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { messages } from "./i18n";
import { commitDraft, stepDraft, typeDraft, type PriorityDraft } from "./run-priority";
import type { Theme } from "./theme";

/** The number stepper of a quota priority: "-", the field, "+" (and `children` after them). Shared by the Runs view popover and the Run Playbook form; the draft logic is `run-priority.ts`'s. */
export function PriorityStepper(props: { theme: Theme; draft: PriorityDraft; onChange: (update: (draft: PriorityDraft) => PriorityDraft) => void; busy?: boolean; onSubmit?: () => void; children?: ReactNode }) {
  const { theme, draft, onChange, busy = false } = props;
  const { t } = useTranslation(messages);
  const small = { minWidth: 32, minHeight: 32, alignItems: "center", justifyContent: "center", borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, opacity: busy ? 0.5 : 1 } as const;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={t("runs.priorityLower")} disabled={busy} onPress={() => onChange((d) => stepDraft(d, -1))} style={small}>
        <Icon name="Minus" size={14} color={theme.colors.foreground} />
      </Pressable>
      <TextInput
        accessibilityLabel={t("runs.priorityInput")}
        value={draft.text}
        onChangeText={(text) => onChange((d) => typeDraft(d, text))}
        onBlur={() => onChange((d) => commitDraft(d))}
        {...(props.onSubmit ? { onSubmitEditing: props.onSubmit } : {})}
        keyboardType="numbers-and-punctuation"
        style={{ width: 64, minHeight: 32, textAlign: "center", color: theme.colors.foreground, fontSize: 13, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, backgroundColor: theme.colors.surface1 }}
      />
      <Pressable accessibilityRole="button" accessibilityLabel={t("runs.priorityRaise")} disabled={busy} onPress={() => onChange((d) => stepDraft(d, 1))} style={small}>
        <Icon name="Plus" size={14} color={theme.colors.foreground} />
      </Pressable>
      {props.children}
    </View>
  );
}
