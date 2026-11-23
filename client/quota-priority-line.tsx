import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { Icon, TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { setRunPriorityRpc } from "../shared/contracts";
import type { QuotaRunRef } from "../shared/quota-limitation";
import { messages } from "./i18n";
import { hasPriority, inheritRequest, parsePriority, resetRequest, setRequest, stepped, type PriorityRequest } from "./quota-priority";
import { semanticColor } from "./semantic-colors";
import type { Theme } from "./theme";

type RunRef = QuotaRunRef;

/**
 * A run of a project that paces, as a line: its title and detail, then its quota priority with a stepper, a field, "Reset" to the
 * playbook's priority and, for a run with children, "Apply to children". A manual override is marked and shown in the waiting colour.
 * The server is asked at once and the tab reads the figures again (`onChanged`); the pace plan reacts to it there.
 */
export function PriorityRunLine(props: { theme: Theme; run: RunRef; detail: string; tag?: string | null; canEdit: boolean; onChanged: () => void }) {
  const { theme, run, detail, tag, canEdit, onChanged } = props;
  const { t } = useTranslation(messages);
  const send = useRpc(setRunPriorityRpc);
  const muted = theme.colors.foregroundMuted;
  const [draft, setDraft] = useState(String(run.priority ?? 0));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The figure sent by the server wins once it changes (another edit, a refresh).
  useEffect(() => setDraft(String(run.priority ?? 0)), [run.priority]);
  const manual = run.override !== null && run.override !== undefined;

  const apply = (request: PriorityRequest) => {
    setBusy(true);
    setError(null);
    send(request)
      .then(onChanged)
      .catch((failure: unknown) => setError(t("quota.priorityFailed", { error: failure instanceof Error ? failure.message : String(failure) })))
      .finally(() => setBusy(false));
  };
  const commit = (value: number | null) => {
    if (value === null) return setDraft(String(run.priority ?? 0));
    if (value !== run.priority) apply(setRequest(run, value, run.inheritChildren ?? false));
  };
  const current = parsePriority(draft) ?? run.priority ?? 0;
  const button = { minWidth: 32, minHeight: 32, alignItems: "center", justifyContent: "center", borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface2, opacity: busy ? 0.5 : 1 } as const;
  const priorityColor = manual ? semanticColor(theme, "waiting") : muted;

  return (
    <View style={{ gap: 3 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{detail}</Text>
        {tag ? <Text style={{ color: semanticColor(theme, "waiting"), fontSize: 10, fontWeight: "600", borderRadius: 4, borderWidth: 1, borderColor: semanticColor(theme, "waiting"), paddingHorizontal: 4 }}>{tag}</Text> : null}
      </View>
      {hasPriority(run) ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <Text style={{ color: priorityColor, fontSize: 12 }}>{`${t("quota.priority", { value: run.priority ?? 0 })}${manual ? ` · ${t("quota.priorityManual", { value: run.defaultPriority ?? 0 })}` : ""}`}</Text>
          {canEdit ? (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Pressable accessibilityRole="button" accessibilityLabel={t("quota.priorityLower")} disabled={busy} onPress={() => apply(setRequest(run, stepped(current, -1), run.inheritChildren ?? false))} style={button}>
                  <Icon name="Minus" size={14} color={theme.colors.foreground} />
                </Pressable>
                <TextInput
                  accessibilityLabel={t("quota.priorityInput", { run: run.title })}
                  value={draft}
                  onChangeText={setDraft}
                  onSubmitEditing={() => commit(parsePriority(draft))}
                  onBlur={() => commit(parsePriority(draft))}
                  keyboardType="numbers-and-punctuation"
                  style={{ width: 56, minHeight: 32, textAlign: "center", color: theme.colors.foreground, fontSize: 13, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, backgroundColor: theme.colors.surface1 }}
                />
                <Pressable accessibilityRole="button" accessibilityLabel={t("quota.priorityRaise")} disabled={busy} onPress={() => apply(setRequest(run, stepped(current, 1), run.inheritChildren ?? false))} style={button}>
                  <Icon name="Plus" size={14} color={theme.colors.foreground} />
                </Pressable>
              </View>
              {manual ? (
                <Pressable accessibilityRole="button" accessibilityLabel={t("quota.priorityResetHint")} disabled={busy} onPress={() => apply(resetRequest(run, run.inheritChildren ?? false))} style={{ ...button, paddingHorizontal: 8 }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{t("quota.priorityReset")}</Text>
                </Pressable>
              ) : null}
              {run.hasChildren ? (
                <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: run.inheritChildren ?? false, disabled: busy }} disabled={busy} onPress={() => apply(inheritRequest(run, !(run.inheritChildren ?? false)))} style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 32 }}>
                  <Icon name={run.inheritChildren ? "SquareCheck" : "Square"} size={16} color={run.inheritChildren ? theme.colors.accent : muted} />
                  <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{t("quota.applyToChildren")}</Text>
                </Pressable>
              ) : null}
            </>
          ) : null}
        </View>
      ) : null}
      {error ? <Text style={{ color: semanticColor(theme, "failed"), fontSize: 11 }}>{error}</Text> : null}
    </View>
  );
}
