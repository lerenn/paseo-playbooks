import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { Icon, TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { setRunPriorityRpc, setRunQuotaExemptRpc } from "../shared/contracts";
import type { RunPriorityView } from "../shared/types";
import { messages } from "./i18n";
import { applyDraft, childrenChecked, commitDraft, draftFor, exemptRequest, inheritRequest, pressExempt, type ExemptStage, isManual, resetRequest, stepDraft, typeDraft, type PriorityRequest } from "./run-priority";
import type { Theme } from "./theme";
import { semanticColor } from "./semantic-colors";

/** The small tag a run exempt from quota limiting wears in a Runs view row, where its priority control would be (ADR 2026-11-23-quota-exempt-runs). */
export function RunExemptTag(props: { theme: Theme }) {
  const { theme } = props;
  const { t } = useTranslation(messages);
  return (
    <Text accessibilityHint={t("runs.exemptHint")} style={{ color: theme.colors.accent, fontSize: 10, fontWeight: "600", borderRadius: 4, borderWidth: 1, borderColor: theme.colors.accent, paddingHorizontal: 4 }}>
      {t("runs.exempt")}
    </Text>
  );
}

/**
 * The priority of an active run in a Runs view row: an icon and the number (in the theme accent while it is a manual one), and
 * a menu below it with a stepper and field, "Apply", "Reset", the source of the number and, for a run with children, "Apply to children".
 * Stepping and typing only change the draft; "Apply" (or Enter) sends it, so a stray tap never reorders runs. "Reset" and the
 * checkbox send at once. The server is asked, then the overview is read again (`onChanged`).
 */
export function RunPriorityMenu(props: { theme: Theme; runId: string; view: RunPriorityView; onChanged: () => void }) {
  const { theme, runId, view, onChanged } = props;
  const { t } = useTranslation(messages);
  const send = useRpc(setRunPriorityRpc);
  const sendExempt = useRpc(setRunQuotaExemptRpc);
  const [stage, setStage] = useState<ExemptStage>("idle");
  // The "Apply to children" box as the user set it in this menu (undefined until touched): the exempt action carries it, as does the priority's.
  const [children, setChildren] = useState<boolean | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => draftFor(view));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The figure the server sends wins once it changes (another edit, a refresh).
  useEffect(() => setDraft(draftFor(view)), [view.priority]);
  // Each opening starts from the run's effective priority, whatever an earlier one left in the field.
  const toggle = () => {
    if (!open) setDraft(draftFor(view));
    setStage("idle");
    setChildren(undefined);
    setOpen(!open);
  };
  const manual = isManual(view);
  const muted = theme.colors.foregroundMuted;
  const tint = manual ? theme.colors.accent : muted;

  const apply = (request: PriorityRequest | null) => {
    if (!request) return;
    setBusy(true);
    setError(null);
    send(request)
      .then(onChanged)
      .catch((failure: unknown) => setError(t("runs.priorityFailed", { error: failure instanceof Error ? failure.message : String(failure) })))
      .finally(() => setBusy(false));
  };
  const pressExemptButton = () => {
    const next = pressExempt(view, stage);
    setStage(next.stage);
    if (!next.send) return;
    setBusy(true);
    setError(null);
    sendExempt(exemptRequest(runId, view, children))
      .then(onChanged)
      .catch((failure: unknown) => setError(t("runs.exemptFailed", { error: failure instanceof Error ? failure.message : String(failure) })))
      .finally(() => setBusy(false));
  };
  const checked = childrenChecked(view, children);
  const toggleChildren = () => {
    setChildren(!checked);
    // An exempt run has no priority to pass on: the box is only read by the exempt button. Otherwise it applies the priority at once, as before.
    if (!view.exempt) apply(inheritRequest(runId, view, !checked));
  };
  const pending = applyDraft(runId, view, draft);
  const small = { minWidth: 32, minHeight: 32, alignItems: "center", justifyContent: "center", borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, opacity: busy ? 0.5 : 1 } as const;

  return (
    <View style={open ? { zIndex: 100 } : undefined}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={view.exempt ? `${runId.replace(/^run_/, "")}: ${t("runs.exemptHint")}` : t("runs.priorityLabel", { run: runId.replace(/^run_/, ""), value: view.priority, source: manual ? t("runs.sourceManual") : t("runs.sourceDefault") })}
        accessibilityState={{ expanded: open }}
        hitSlop={6}
        onPress={toggle}
        style={{ flexDirection: "row", alignItems: "center", gap: 3 }}
      >
        {view.exempt ? (
          <Text style={{ color: theme.colors.accent, fontSize: 10, fontWeight: "600", borderRadius: 4, borderWidth: 1, borderColor: theme.colors.accent, paddingHorizontal: 4 }}>{t("runs.exempt")}</Text>
        ) : (
          <>
            <Icon name="ListOrdered" size={15} color={tint} />
            <Text style={{ color: tint, fontSize: 12, fontWeight: manual ? "600" : "400" }}>{view.priority}</Text>
          </>
        )}
      </Pressable>
      {open ? (
        <View accessibilityRole="menu" onStartShouldSetResponder={() => true} style={{ position: "absolute", top: 26, right: 0, zIndex: 100, minWidth: 240, gap: 8, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface2, elevation: 6 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>{t("runs.priorityTitle")}</Text>
          {view.exempt ? (
            <Text style={{ color: theme.colors.accent, fontSize: 11 }}>{t("runs.exemptState")}</Text>
          ) : (
            <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Pressable accessibilityRole="button" accessibilityLabel={t("runs.priorityLower")} disabled={busy} onPress={() => setDraft((d) => stepDraft(d, -1))} style={small}>
              <Icon name="Minus" size={14} color={theme.colors.foreground} />
            </Pressable>
            <TextInput
              accessibilityLabel={t("runs.priorityInput")}
              value={draft.text}
              onChangeText={(text) => setDraft((d) => typeDraft(d, text))}
              onBlur={() => setDraft((d) => commitDraft(d))}
              onSubmitEditing={() => apply(pending)}
              keyboardType="numbers-and-punctuation"
              style={{ width: 64, minHeight: 32, textAlign: "center", color: theme.colors.foreground, fontSize: 13, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, backgroundColor: theme.colors.surface1 }}
            />
            <Pressable accessibilityRole="button" accessibilityLabel={t("runs.priorityRaise")} disabled={busy} onPress={() => setDraft((d) => stepDraft(d, 1))} style={small}>
              <Icon name="Plus" size={14} color={theme.colors.foreground} />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || !pending }} disabled={busy || !pending} onPress={() => apply(pending)} style={{ ...small, paddingHorizontal: 10, opacity: busy || !pending ? 0.4 : 1, borderColor: theme.colors.accent }}>
              <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>{t("runs.priorityApply")}</Text>
            </Pressable>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ flex: 1, color: manual ? theme.colors.accent : muted, fontSize: 11 }}>{manual ? t("runs.sourceManualNote", { value: view.defaultPriority }) : t("runs.sourceDefaultNote")}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={t("runs.priorityResetHint", { value: view.defaultPriority })} disabled={busy || !manual} onPress={() => apply(resetRequest(runId, view))} style={{ ...small, paddingHorizontal: 8, opacity: busy || !manual ? 0.4 : 1 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{t("runs.priorityReset")}</Text>
            </Pressable>
          </View>
            </>
          )}
          {view.hasChildren ? (
            <Pressable accessibilityRole="checkbox" accessibilityState={{ checked, disabled: busy }} disabled={busy} onPress={toggleChildren} style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 32 }}>
              <Icon name={checked ? "SquareCheck" : "Square"} size={16} color={checked ? theme.colors.accent : muted} />
              <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{t("runs.applyToChildren")}</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={pressExemptButton}
            style={{ ...small, alignItems: "flex-start", paddingHorizontal: 10, paddingVertical: 6, borderColor: theme.colors.accent, backgroundColor: stage === "confirm" ? theme.colors.accent : theme.colors.surface1 }}
          >
            <Text style={{ color: stage === "confirm" ? theme.colors.surface1 : theme.colors.accent, fontSize: 12, fontWeight: "600" }}>{view.exempt ? t("runs.exemptBack") : stage === "confirm" ? t("runs.exemptConfirm") : t("runs.exemptNow")}</Text>
          </Pressable>
          {!view.exempt ? <Text style={{ color: muted, fontSize: 11 }}>{t("runs.exemptCaution")}</Text> : null}
          {error ? <Text style={{ color: semanticColor(theme, "failed"), fontSize: 11 }}>{error}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}
