import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { resetBurnRateRpc } from "../shared/contracts";
import type { QuotaBurnRate } from "../shared/quota-limitation";
import { messages } from "./i18n";
import { formatWait } from "./quota-rows";
import { DETAIL_MAX_WIDTH, SPACE, TEXT } from "./spacing";
import type { Theme } from "./theme";

/** The (i) button of the burn rate rows: the formula shows on hover or focus, and a tap toggles it (the pattern of the throttle line). */
function BurnInfo(props: { theme: Theme }) {
  const { theme } = props;
  const { t } = useTranslation(messages);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pressed, setPressed] = useState(false);
  const shown = hover || focus || pressed;
  return (
    <View style={{ position: "relative", zIndex: 40 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={t("quota.burn.infoLabel")} hitSlop={8} onHoverIn={() => setHover(true)} onHoverOut={() => setHover(false)} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} onPress={() => setPressed(!pressed)}>
        <Icon name="Info" size={13} color={shown ? theme.colors.accent : theme.colors.foregroundMuted} />
      </Pressable>
      {shown ? (
        <View style={{ position: "absolute", top: 20, left: 0, width: 280, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface2 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>{t("quota.burn.caption")}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** A "Reset" link that asks again inline before erasing: the question, then Erase and Cancel. Neutral and accent colours, never red. */
function ResetControl(props: { theme: Theme; question: string; hint?: string; label?: string; onConfirm: () => Promise<void> }) {
  const { theme, question, hint, label, onConfirm } = props;
  const { t } = useTranslation(messages);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const muted = theme.colors.foregroundMuted;
  if (!asking) {
    return (
      <Pressable accessibilityRole="button" hitSlop={6} onPress={() => setAsking(true)}>
        <Text style={{ color: theme.colors.accent, fontSize: 12 }}>{label ?? t("quota.burn.reset")}</Text>
      </Pressable>
    );
  }
  return (
    <View style={{ gap: 4, maxWidth: DETAIL_MAX_WIDTH }}>
      <Text style={{ color: theme.colors.foreground, ...TEXT.small }}>{question}</Text>
      {hint ? <Text style={{ color: muted, ...TEXT.small }}>{hint}</Text> : null}
      <View style={{ flexDirection: "row", gap: 14 }}>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => {
            setBusy(true);
            onConfirm()
              .then(() => setAsking(false))
              .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
              .finally(() => setBusy(false));
          }}
        >
          <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>{t("quota.burn.erase")}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => setAsking(false)}>
          <Text style={{ color: muted, fontSize: 12 }}>{t("quota.burn.cancel")}</Text>
        </Pressable>
      </View>
      {error ? <Text style={{ color: muted, ...TEXT.small }}>{t("quota.burn.failed", { error })}</Text> : null}
    </View>
  );
}

function PlaybookBurn(props: { theme: Theme; item: QuotaBurnRate; onChanged: () => void }) {
  const { theme, item, onChanged } = props;
  const { t, locale } = useTranslation(messages);
  const reset = useRpc(resetBurnRateRpc);
  const [steps, setSteps] = useState(false);
  const muted = theme.colors.foregroundMuted;
  const when = (iso: string) => new Date(iso).toLocaleDateString(locale);
  const number = (value: number) => (Math.round(value * 100) / 100).toLocaleString(locale);
  return (
    <View style={{ gap: 3 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: 10 }}>
        <Text style={{ color: theme.colors.foreground, ...TEXT.body }}>{item.title}</Text>
        {item.resetAt ? <Text style={{ color: muted, ...TEXT.small }}>{t("quota.burn.resetAt", { when: when(item.resetAt) })}</Text> : null}
        <ResetControl theme={theme} question={t("quota.burn.confirmPlaybook", { name: item.title })} onConfirm={async () => void (await reset({ playbook: item.playbook }), onChanged())} />
      </View>
      {item.rates.length === 0 ? <Text style={{ color: muted, ...TEXT.small }}>{t("quota.burn.none")}</Text> : null}
      {item.rates.map((rate) => (
        <Text key={`${rate.provider}/${rate.window}`} style={{ color: muted, ...TEXT.small }}>
          <Text style={{ color: rate.burnRate === null ? muted : theme.colors.accent, fontWeight: "600" }}>{rate.burnRate === null ? t("quota.burn.noRate", { provider: rate.provider, period: rate.window }) : t("quota.burn.rate", { provider: rate.provider, period: rate.window, value: number(rate.burnRate) })}</Text>
          {` · ${[t("quota.burn.attempts", { count: rate.steps }), rate.lowConfidence ? t("quota.burn.low") : null].filter(Boolean).join(" · ")}`}
        </Text>
      ))}
      {item.steps.length > 0 ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: steps }} onPress={() => setSteps(!steps)} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Icon name={steps ? "ChevronDown" : "ChevronRight"} size={12} color={muted} />
          <Text style={{ color: muted, ...TEXT.small }}>{t("quota.burn.stepsToggle", { count: item.steps.length })}</Text>
        </Pressable>
      ) : null}
      {steps
        ? item.steps.map((step) => (
            <View key={step.id} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: 10, paddingLeft: 16 }}>
              <Text style={{ color: theme.colors.foreground, ...TEXT.small }}>{step.id}</Text>
              <Text style={{ color: muted, ...TEXT.small }}>{step.durationMs === null ? t("quota.burn.noDuration") : t("quota.burn.usually", { value: formatWait(step.durationMs) })}</Text>
              {step.resetAt ? <Text style={{ color: muted, ...TEXT.small }}>{t("quota.burn.resetAt", { when: when(step.resetAt) })}</Text> : null}
              <ResetControl theme={theme} question={t("quota.burn.confirmStep", { name: step.id })} hint={t("quota.burn.stepsCaption")} onConfirm={async () => void (await reset({ playbook: item.playbook, step: step.id }), onChanged())} />
            </View>
          ))
        : null}
    </View>
  );
}

/** The burn rate learned per playbook of a project, with the Reset controls (a playbook, or one step's duration). Collapsed with the rest of the project's detail. */
export function BurnRatesView(props: { theme: Theme; items: QuotaBurnRate[]; onChanged: () => void }) {
  const { theme, items, onChanged } = props;
  const { t } = useTranslation(messages);
  const reset = useRpc(resetBurnRateRpc);
  if (items.length === 0) return null;
  return (
    <View style={{ gap: SPACE.provider }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" }}>{t("quota.burn.title")}</Text>
        <BurnInfo theme={theme} />
        <ResetControl theme={theme} label={t("quota.burn.resetAll")} question={t("quota.burn.confirmAll")} onConfirm={async () => void (await reset({ all: true }), onChanged())} />
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, ...TEXT.small }}>{t("quota.burn.allCaption")}</Text>
      {items.map((item) => (
        <PlaybookBurn key={item.playbook} theme={theme} item={item} onChanged={onChanged} />
      ))}
    </View>
  );
}
