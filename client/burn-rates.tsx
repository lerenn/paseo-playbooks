import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { resetBurnRateRpc } from "../shared/contracts";
import type { QuotaBurnRate } from "../shared/quota-limitation";
import { messages } from "./i18n";
import { BURN_OPEN_BY_DEFAULT, burnTable, type BurnColumn, type BurnTableRow } from "./burn-rows";
import { formatWait } from "./quota-rows";
import { semanticColor } from "./semantic-colors";
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

/** Column widths: the table keeps them and scrolls sideways on a narrow screen instead of clipping. */
const WIDTH = { name: 210, rate: 150, attempts: 80, confidence: 90, reset: 90, step: 210, duration: 150 } as const;

function Cell(props: { width: number; right?: boolean; children: React.ReactNode }) {
  return <View style={{ width: props.width, paddingHorizontal: 8, justifyContent: "center", alignItems: props.right ? "flex-end" : "flex-start" }}>{props.children}</View>;
}

function HeaderRow(props: { theme: Theme; cells: Array<{ label: string; width: number; right?: boolean }> }) {
  const { theme, cells } = props;
  return (
    <View style={{ flexDirection: "row", paddingVertical: 6, backgroundColor: theme.colors.surface2, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
      {cells.map((cell) => (
        <Cell key={cell.label} width={cell.width} right={cell.right}>
          <Text accessibilityRole="header" numberOfLines={1} style={{ color: theme.colors.foregroundMuted, ...TEXT.small, fontWeight: "600" }}>{cell.label}</Text>
        </Cell>
      ))}
    </View>
  );
}

function PlaybookRow(props: { theme: Theme; row: BurnTableRow; columns: BurnColumn[]; onChanged: () => void }) {
  const { theme, row, columns, onChanged } = props;
  const { t, locale } = useTranslation(messages);
  const reset = useRpc(resetBurnRateRpc);
  const [steps, setSteps] = useState(false);
  const muted = theme.colors.foregroundMuted;
  const number = (value: number) => (Math.round(value * 100) / 100).toLocaleString(locale);
  const confidence = row.confidence === "low" ? t("quota.burn.confLow") : row.confidence === "medium" ? t("quota.burn.confMedium") : t("quota.burn.confHigh");
  const confidenceColor = row.confidence === "low" ? semanticColor(theme, "waiting") : row.confidence === "high" ? semanticColor(theme, "done") : theme.colors.foreground;
  const dataWidth = columns.length * WIDTH.rate + WIDTH.attempts + WIDTH.confidence;
  const expandable = row.steps.length > 0;
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border }}>
      <View style={{ flexDirection: "row", paddingVertical: 6, alignItems: "center" }}>
        <Cell width={WIDTH.name}>
          <Pressable accessibilityRole="button" accessibilityLabel={t("quota.burn.stepsToggle", { count: row.steps.length })} accessibilityState={{ expanded: steps, disabled: !expandable }} disabled={!expandable} onPress={() => setSteps(!steps)} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            {expandable ? <Icon name={steps ? "ChevronDown" : "ChevronRight"} size={12} color={muted} /> : <View style={{ width: 12 }} />}
            <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.foreground, ...TEXT.body }}>{row.title}</Text>
          </Pressable>
        </Cell>
        {row.noHistory ? (
          <Cell width={dataWidth}>
            <Text style={{ color: muted, ...TEXT.small }}>{t("quota.burn.noHistory")}</Text>
          </Cell>
        ) : (
          <>
            {row.cells.map((cell, index) => (
              <Cell key={columns[index]!.key} width={WIDTH.rate}>
                <Text style={{ color: cell && cell.burnRate !== null ? theme.colors.foreground : muted, ...TEXT.small }}>{cell && cell.burnRate !== null ? t("quota.burn.rate", { value: number(cell.burnRate) }) : "-"}</Text>
              </Cell>
            ))}
            <Cell width={WIDTH.attempts}>
              <Text style={{ color: theme.colors.foreground, ...TEXT.small }}>{row.attempts}</Text>
            </Cell>
            <Cell width={WIDTH.confidence}>
              <Text style={{ color: confidenceColor, ...TEXT.small }}>{confidence}</Text>
            </Cell>
          </>
        )}
        <Cell width={WIDTH.reset} right>
          <ResetControl theme={theme} question={t("quota.burn.confirmPlaybook", { name: row.title })} onConfirm={async () => void (await reset({ playbook: row.playbook }), onChanged())} />
        </Cell>
      </View>
      {steps ? (
        <View style={{ marginLeft: 24, marginBottom: 8, borderLeftWidth: 2, borderLeftColor: theme.colors.border }}>
          <HeaderRow theme={theme} cells={[{ label: t("quota.burn.colStep"), width: WIDTH.step }, { label: t("quota.burn.colDuration"), width: WIDTH.duration }, { label: t("quota.burn.reset"), width: WIDTH.reset + 60, right: true }]} />
          {row.steps.map((step) => (
            <View key={step.id} style={{ flexDirection: "row", paddingVertical: 5, alignItems: "center", borderTopWidth: 1, borderTopColor: theme.colors.border }}>
              <Cell width={WIDTH.step}>
                <Text style={{ color: theme.colors.foreground, ...TEXT.small }}>{step.id}</Text>
              </Cell>
              <Cell width={WIDTH.duration}>
                <Text style={{ color: muted, ...TEXT.small }}>{step.durationMs === null ? t("quota.burn.noDuration") : t("quota.burn.usually", { value: formatWait(step.durationMs) })}</Text>
              </Cell>
              <Cell width={WIDTH.reset + 60} right>
                <ResetControl theme={theme} question={t("quota.burn.confirmStep", { name: step.id })} hint={t("quota.burn.stepsCaption")} onConfirm={async () => void (await reset({ playbook: row.playbook, step: step.id }), onChanged())} />
              </Cell>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** The burn rate learned per playbook of a project as a table, with the Reset controls (a playbook, or one step's duration). Folded until opened. */
export function BurnRatesView(props: { theme: Theme; items: QuotaBurnRate[]; onChanged: () => void }) {
  const { theme, items, onChanged } = props;
  const { t } = useTranslation(messages);
  const reset = useRpc(resetBurnRateRpc);
  const [open, setOpen] = useState(BURN_OPEN_BY_DEFAULT);
  if (items.length === 0) return null;
  const table = burnTable(items);
  const muted = theme.colors.foregroundMuted;
  return (
    <View style={{ gap: SPACE.block }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={muted} />
          <Text style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" }}>{t("quota.burn.title")}</Text>
        </Pressable>
        <BurnInfo theme={theme} />
        <ResetControl theme={theme} label={t("quota.burn.resetAll")} question={t("quota.burn.confirmAll")} onConfirm={async () => void (await reset({ all: true }), onChanged())} />
      </View>
      {open ? (
        <>
          <Text style={{ color: muted, ...TEXT.small }}>{t("quota.burn.allCaption")}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator>
            <View style={{ borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, overflow: "hidden" }}>
              <HeaderRow
                theme={theme}
                cells={[
                  { label: t("quota.burn.colPlaybook"), width: WIDTH.name },
                  ...table.columns.map((column) => ({ label: `${column.provider} ${column.period}`, width: WIDTH.rate })),
                  { label: t("quota.burn.colAttempts"), width: WIDTH.attempts },
                  { label: t("quota.burn.colConfidence"), width: WIDTH.confidence },
                  { label: t("quota.burn.reset"), width: WIDTH.reset, right: true },
                ]}
              />
              {table.rows.map((row) => (
                <PlaybookRow key={row.playbook} theme={theme} row={row} columns={table.columns} onChanged={onChanged} />
              ))}
            </View>
          </ScrollView>
        </>
      ) : null}
    </View>
  );
}
