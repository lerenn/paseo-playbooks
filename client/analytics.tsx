import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { rowId, sortRows, tokensOf, type AgentRow, type Analytics, type DailySeries, type QuotaRate, type UsageRow } from "../shared/analytics";
import { analyticsStateRpc } from "../shared/contracts";
import type { Usage } from "../shared/types";
import { axisTicks, compactNumber, isDarkColor, labelIndexes, niceAxis, seriesColor, shortDate } from "./analytics-chart";
import { messages } from "./i18n";
import type { Theme } from "./theme";
import { semanticColor } from "./semantic-colors";

const RANGES = [
  { key: "range.day", days: 1 },
  { key: "range.days7", days: 7 },
  { key: "range.days30", days: 30 },
  { key: "range.all", days: undefined },
] as const;

export { compactNumber };

function localTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

const PLOT_HEIGHT = 120;
const AXIS_WIDTH = 34;

/** A muted gear before the name of the plugin's own manager rows; none for a role or step an author named alike. */
function ManagerMark(props: { theme: Theme; row: { manager?: boolean }; size?: number }) {
  const { t } = useTranslation(messages);
  if (!props.row.manager) return null;
  return (
    <View accessible accessibilityLabel={t("analytics.managerMark")}>
      <Icon name="Settings" size={props.size ?? 12} color={props.theme.colors.foregroundMuted} />
    </View>
  );
}

/** The colour each group of a breakdown has in its chart, so the table rows can wear the same one. */
function colorsOf(theme: Theme, chart: DailySeries | undefined): Map<string, string> {
  const dark = isDarkColor(theme.colors.surface1);
  const map = new Map<string, string>();
  chart?.series.forEach((row, index) => map.set(rowId(row), row.other ? theme.colors.foregroundMuted : seriesColor(index, dark)));
  return map;
}

/** Tokens per day of one breakdown: stacked bars, one colour per group (the biggest ones; the rest are "Other"). Tap a day for exact values, a legend entry to isolate a group. */
function DailyChart(props: { theme: Theme; chart: DailySeries; colors: Map<string, string> }) {
  const { theme, chart, colors } = props;
  const { t, locale } = useTranslation(messages);
  const [picked, setPicked] = useState<number | null>(null);
  const [isolated, setIsolated] = useState<string | null>(null);
  const muted = theme.colors.foregroundMuted;
  const surface = theme.colors.surface1;
  const visible = chart.series.filter((row) => isolated === null || rowId(row) === isolated);
  const totals = chart.days.map((_, i) => visible.reduce((sum, row) => sum + row.tokens[i]!, 0));
  const peak = Math.max(...totals, 0);
  if (chart.series.length === 0) return null;
  if (peak === 0 && isolated === null) {
    return <Text style={{ color: muted, fontSize: 12, padding: 12 }}>{t("analytics.chart.empty")}</Text>;
  }
  const top = niceAxis(peak).top;
  const ticks = axisTicks(peak);
  const count = chart.days.length;
  const pick = picked !== null && picked < count ? picked : null;
  const many = count > 45;
  const tipOnRight = pick !== null && pick < count / 2;
  return (
    <View style={{ gap: 8, padding: 12 }}>
      <View style={{ height: PLOT_HEIGHT, flexDirection: "row" }}>
        <View style={{ width: AXIS_WIDTH }}>
          {ticks.map((tick) => (
            <Text key={tick} style={{ position: "absolute", right: 6, bottom: (tick / top) * (PLOT_HEIGHT - 8) - 6, color: muted, fontSize: 10 }}>
              {compactNumber(tick, locale)}
            </Text>
          ))}
        </View>
        <View style={{ flex: 1 }}>
          {ticks.map((tick) => (
            <View
              key={tick}
              style={{ position: "absolute", left: 0, right: 0, bottom: (tick / top) * (PLOT_HEIGHT - 8), height: 1, backgroundColor: theme.colors.border, opacity: tick === 0 ? 1 : 0.5 }}
            />
          ))}
          <View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, flexDirection: "row", alignItems: "flex-end" }}>
            {chart.days.map((day, i) => {
              const barHeight = totals[i]! > 0 ? Math.max(3, Math.round((totals[i]! / top) * (PLOT_HEIGHT - 8))) : 0;
              const lastSeries = visible.reduce((found, row, index) => (row.tokens[i]! > 0 ? index : found), -1);
              return (
                <Pressable
                  key={day}
                  accessibilityRole="button"
                  accessibilityLabel={t("analytics.chart.dayTokens", { day, tokens: totals[i]!.toLocaleString(locale) })}
                  onPress={() => setPicked(pick === i ? null : i)}
                  style={{ flex: 1, height: PLOT_HEIGHT, justifyContent: "flex-end", alignItems: "center", paddingHorizontal: many ? 0.5 : 2 }}
                >
                  <View
                    style={{
                      width: "100%",
                      maxWidth: 28,
                      height: barHeight || 2,
                      justifyContent: "flex-end",
                      opacity: pick === null || pick === i ? 1 : 0.4,
                      borderTopLeftRadius: many ? 1 : 3,
                      borderTopRightRadius: many ? 1 : 3,
                      overflow: "hidden",
                      backgroundColor: barHeight ? undefined : theme.colors.border,
                      flexDirection: "column-reverse",
                    }}
                  >
                    {visible.map((row, index) =>
                      row.tokens[i]! > 0 ? (
                        <View
                          key={row.key}
                          style={{ flex: row.tokens[i]!, backgroundColor: colors.get(rowId(row)), borderTopWidth: index > 0 && index <= lastSeries ? 1 : 0, borderTopColor: surface }}
                        />
                      ) : null,
                    )}
                  </View>
                </Pressable>
              );
            })}
          </View>
          {pick !== null ? (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                top: 0,
                ...(tipOnRight ? { right: 0 } : { left: 0 }),
                maxWidth: "70%",
                gap: 1,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface2,
                paddingHorizontal: 8,
                paddingVertical: 5,
              }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "600" }}>
                {t("analytics.chart.tipTitle", { day: shortDate(chart.days[pick]!, locale), tokens: totals[pick]!.toLocaleString(locale) })}
              </Text>
              {visible
                .filter((row) => row.tokens[pick]! > 0)
                .map((row) => (
                  <View key={rowId(row)} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                    <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.get(rowId(row)) }} />
                    <ManagerMark theme={theme} row={row} size={10} />
                    <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.foreground, fontSize: 10 }}>
                      {`${row.key}: ${row.tokens[pick]!.toLocaleString(locale)}`}
                    </Text>
                  </View>
                ))}
              {totals[pick] === 0 ? <Text style={{ color: muted, fontSize: 10 }}>{t("analytics.chart.noUsageThatDay")}</Text> : null}
            </View>
          ) : null}
        </View>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginLeft: AXIS_WIDTH }}>
        {labelIndexes(count).map((i) => (
          <Text key={i} style={{ color: muted, fontSize: 10 }}>
            {shortDate(chart.days[i]!, locale)}
          </Text>
        ))}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 6, rowGap: 4 }}>
        {chart.series.map((row) => {
          const on = isolated === null || isolated === rowId(row);
          return (
            <Pressable
              key={rowId(row)}
              accessibilityRole="button"
              accessibilityState={{ selected: isolated === rowId(row) }}
              accessibilityLabel={isolated === rowId(row) ? t("analytics.chart.showAll", { name: row.key }) : t("analytics.chart.only", { name: row.key })}
              onPress={() => setIsolated(isolated === rowId(row) ? null : rowId(row))}
              style={{ flexDirection: "row", alignItems: "center", gap: 5, maxWidth: "100%", borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2, opacity: on ? 1 : 0.45, backgroundColor: isolated === rowId(row) ? theme.colors.surface2 : "transparent" }}
            >
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.get(rowId(row)) }} />
              <ManagerMark theme={theme} row={row} size={11} />
              <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.foreground, fontSize: 11 }}>
                {row.key}
              </Text>
              <Text style={{ color: muted, fontSize: 11 }}>{compactNumber(row.total, locale)}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** The Analytics tab of the Playbooks screen: where the tokens went, by playbook, step, role and model. */
export function AnalyticsView(props: { theme: Theme }) {
  const { theme } = props;
  const { t } = useTranslation(messages);
  const fetchAnalytics = useRpc(analyticsStateRpc);
  const [days, setDays] = useState<number | undefined>(30);
  const [sort, setSort] = useState<SortBy>("tokens");
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    fetchAnalytics({ ...(days === undefined ? {} : { days }), timeZone: localTimeZone() })
      .then((result) => live && setData(result))
      .catch((failure: unknown) => live && setError(failure instanceof Error ? failure.message : String(failure)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const muted = theme.colors.foregroundMuted;
  return (
    <View style={{ gap: 18 }}>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {RANGES.map((range) => (
          <Pill key={range.key} theme={theme} label={t(`analytics.${range.key}`)} selected={days === range.days} onPress={() => setDays(range.days)} />
        ))}
        <View style={{ width: 8 }} />
        <Pill theme={theme} label={t("analytics.sort.tokens")} selected={sort === "tokens"} onPress={() => setSort("tokens")} />
        <Pill theme={theme} label={t("analytics.sort.lost")} selected={sort === "lost"} onPress={() => setSort("lost")} />
      </View>
      {error ? <Text style={{ color: semanticColor(theme, "failed") }}>{error}</Text> : null}
      {!data && !error ? <Text style={{ color: muted }}>{t("analytics.loading")}</Text> : null}
      {data ? (
        <>
          <Summary theme={theme} data={data} />
          {data.total.turns === 0 ? (
            <Text style={{ color: muted, fontSize: 13 }}>
              {t("analytics.empty")}
            </Text>
          ) : null}
          <Breakdown theme={theme} title={t("analytics.section.byPlaybook")} rows={data.byPlaybook} chart={data.daily?.byPlaybook} sort={sort} />
          <QuotaRates theme={theme} rates={data.quotaRates} />
          <Breakdown theme={theme} title={t("analytics.section.byStep")} rows={data.byStep} chart={data.daily?.byStep} showWaste sort={sort} />
          <Breakdown theme={theme} title={t("analytics.section.byRole")} rows={data.byRole} chart={data.daily?.byRole} showWaste sort={sort} />
          <Breakdown theme={theme} title={t("analytics.section.byModel")} rows={data.byModel} chart={data.daily?.byModel} showWaste sort={sort} />
          <TopAgents theme={theme} rows={data.topAgents} />
        </>
      ) : null}
    </View>
  );
}

function Pill(props: { theme: Theme; label: string; selected: boolean; onPress(): void }) {
  const { theme, selected } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={props.onPress}
      style={{
        borderRadius: 14,
        borderWidth: 1,
        borderColor: selected ? theme.colors.foregroundMuted : theme.colors.border,
        backgroundColor: selected ? theme.colors.surface2 : theme.colors.surface1,
        paddingHorizontal: 11,
        paddingVertical: 5,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{props.label}</Text>
    </Pressable>
  );
}

function Stat(props: { theme: Theme; label: string; value: string; hint?: string }) {
  const { theme } = props;
  return (
    <View style={{ minWidth: 120, gap: 2, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, padding: 12 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{props.label}</Text>
      <Text style={{ color: theme.colors.foreground, fontSize: 18, fontWeight: "700" }}>{props.value}</Text>
      {props.hint ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{props.hint}</Text> : null}
    </View>
  );
}

function Summary(props: { theme: Theme; data: Analytics }) {
  const { theme, data } = props;
  const { t, locale } = useTranslation(messages);
  const total: Usage = data.total;
  const overhead = tokensOf(data.overhead.manager) + tokensOf(data.overhead.deciders);
  const share = tokensOf(total) > 0 ? Math.round((overhead / tokensOf(total)) * 100) : 0;
  const steps = data.byStep.filter((row) => !row.manager);
  const repeats = steps.reduce((sum, row) => sum + row.repeatAttempts, 0);
  const lost = steps.reduce((sum, row) => sum + row.lostTokens, 0);
  const stalled = steps.reduce((sum, row) => sum + row.stalledAttempts, 0);
  const cacheBase = total.inputTokens + total.cachedInputTokens;
  const n = (value: number) => compactNumber(value, locale);
  const runsHint = [
    data.runsWithoutUsage ? t("analytics.summary.withoutUsage", { count: data.runsWithoutUsage }) : "",
    data.runsWithInvalidManagerUsage ? t("analytics.summary.invalidManager", { count: data.runsWithInvalidManagerUsage }) : "",
  ].filter(Boolean).join(" · ");
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
      <Stat theme={theme} label={t("analytics.summary.runs")} value={data.runs.toLocaleString(locale)} hint={runsHint || undefined} />
      <Stat theme={theme} label={t("analytics.summary.tokens")} value={n(tokensOf(total))} hint={t("analytics.summary.tokensHint", { input: n(total.inputTokens), output: n(total.outputTokens), cached: n(total.cachedInputTokens) })} />
      <Stat theme={theme} label={t("analytics.summary.repeats")} value={n(repeats)} hint={t("analytics.summary.repeatsHint")} />
      <Stat theme={theme} label={t("analytics.summary.lost")} value={n(lost)} hint={`${t("analytics.summary.lostHint")}${stalled > 0 ? ` · ${t("analytics.summary.stalledPasses", { count: stalled })}` : ""}`} />
      <Stat theme={theme} label={t("analytics.summary.cache")} value={cacheBase > 0 ? `${Math.round((total.cachedInputTokens / cacheBase) * 100)}%` : "–"} />
      <Stat theme={theme} label={t("analytics.summary.overhead")} value={`${share}%`} hint={t("analytics.summary.overheadHint")} />
    </View>
  );
}

type SortBy = "tokens" | "lost";

type PassesKey =
  | "analytics.passes.feedback"
  | "analytics.passes.polls"
  | "analytics.passes.retries"
  | "analytics.passes.interrupted"
  | "analytics.passes.total"
  | "analytics.passes.withParts"
  | "analytics.passes.lost"
  | "analytics.passes.stalled"
  | "analytics.listSeparator";
type TFn = (key: PassesKey, params: Record<string, string | number>) => string;

/** "12 passes (5 feedback, 3 polls, 2 retries, 1 interrupted) · lost 4.2k (35%) · 3 stalled", leaving out what is zero. */
function passesText(t: TFn, locale: string, row: UsageRow): string {
  const parts = [
    row.feedbackAttempts ? t("analytics.passes.feedback", { count: row.feedbackAttempts }) : "",
    row.pollAttempts ? t("analytics.passes.polls", { count: row.pollAttempts }) : "",
    row.retryAttempts ? t("analytics.passes.retries", { count: row.retryAttempts }) : "",
    row.interruptedAttempts ? t("analytics.passes.interrupted", { count: row.interruptedAttempts }) : "",
  ].filter(Boolean);
  const passes = t("analytics.passes.total", { count: row.attempts });
  let text = parts.length > 0 ? t("analytics.passes.withParts", { passes, parts: parts.join(t("analytics.listSeparator", {})) }) : passes;
  if (row.lostAttempts > 0) text += ` · ${t("analytics.passes.lost", { tokens: compactNumber(row.lostTokens, locale), percent: Math.round(row.lostShare * 100) })}`;
  if (row.stalledAttempts > 0) text += ` · ${t("analytics.passes.stalled", { count: row.stalledAttempts })}`;
  return text;
}

/** One breakdown: its title, the per-day chart, then the table rows, all in one card with separators. */
function Breakdown(props: { theme: Theme; title: string; rows: UsageRow[]; chart: DailySeries | undefined; showWaste?: boolean; sort: SortBy }) {
  const { theme, chart } = props;
  const { t, locale } = useTranslation(messages);
  const rows = props.showWaste ? sortRows(props.rows, props.sort) : props.rows;
  if (rows.length === 0) return null;
  const colors = colorsOf(theme, chart);
  const top = Math.max(...rows.map((row) => tokensOf(row.usage)), 1);
  return (
    <View style={{ gap: 8 }}>
      <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "700" }}>
        {props.title}
      </Text>
      <View style={{ borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, overflow: "hidden" }}>
        {chart ? <DailyChart theme={theme} chart={chart} colors={colors} /> : null}
        {rows.map((row, index) => {
          const color = colors.get(rowId(row)) ?? theme.colors.foregroundMuted;
          return (
            <View key={rowId(row)} style={{ gap: 4, padding: 10, borderTopWidth: index === 0 && !chart ? 0 : 1, borderTopColor: theme.colors.border }}>
              <View style={{ flexDirection: "row", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <View style={{ flex: 1, minWidth: 140, flexDirection: "row", alignItems: "center", gap: 6 }}>
                  {chart ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} /> : null}
                  <ManagerMark theme={theme} row={row} />
                  <Text style={{ flexShrink: 1, color: theme.colors.foreground, fontSize: 13 }}>{row.key}</Text>
                </View>
                <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{compactNumber(tokensOf(row.usage), locale)}</Text>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                  {props.showWaste ? passesText((key, params) => t(key, params as never), locale, row) : t("analytics.row.runs", { count: row.runs })}
                  {row.usage.contextPeak > 0 ? ` · ${t("analytics.row.ctx", { value: compactNumber(row.usage.contextPeak, locale) })}` : ""}
                </Text>
              </View>
              <View style={{ height: 4, borderRadius: 2, backgroundColor: theme.colors.surface2 }}>
                <View style={{ height: 4, borderRadius: 2, width: `${Math.max(2, Math.round((tokensOf(row.usage) / top) * 100))}%`, backgroundColor: chart ? color : theme.colors.accent }} />
              </View>
              {row.detail ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{row.detail}</Text> : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** The agents that spent the most, whatever they are: managers, step agents, any other agent. */
function TopAgents(props: { theme: Theme; rows: AgentRow[] }) {
  const { theme, rows } = props;
  const { t, locale } = useTranslation(messages);
  if (rows.length === 0) return null;
  return (
    <View style={{ gap: 8 }}>
      <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "700" }}>
        {t("analytics.section.topAgents")}
      </Text>
      <View style={{ borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, overflow: "hidden" }}>
        {rows.map((row, index) => (
          <View key={row.agentId} style={{ gap: 2, padding: 10, borderTopWidth: index === 0 ? 0 : 1, borderTopColor: theme.colors.border }}>
            <View style={{ flexDirection: "row", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
              <Text style={{ flex: 1, minWidth: 140, color: theme.colors.foreground, fontSize: 13 }}>{row.title || row.agentId}</Text>
              <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{compactNumber(tokensOf(row.usage), locale)}</Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                {t("analytics.agent.usage", { turns: t("analytics.agent.turns", { count: row.usage.turns }), input: compactNumber(row.usage.inputTokens, locale), cached: compactNumber(row.usage.cachedInputTokens, locale), output: compactNumber(row.usage.outputTokens, locale), context: compactNumber(row.usage.contextPeak, locale) })}
              </Text>
            </View>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {[row.kind, row.role ? t("analytics.agent.role", { role: row.role }) : null, row.model, row.agentId.slice(0, 8)].filter(Boolean).join(" · ")}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** The (i) button of the quota cost section: its caption shows on hover or focus, and a tap toggles it (the pattern of the throttle line in the quota tab). */
function QuotaInfo(props: { theme: Theme }) {
  const { theme } = props;
  const { t } = useTranslation(messages);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pressed, setPressed] = useState(false);
  const shown = hover || focus || pressed;
  return (
    <View style={{ position: "relative", zIndex: 50 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("analytics.quota.infoLabel")}
        hitSlop={8}
        onHoverIn={() => setHover(true)}
        onHoverOut={() => setHover(false)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        onPress={() => setPressed(!pressed)}
      >
        <Icon name="Info" size={13} color={shown ? theme.colors.accent : theme.colors.foregroundMuted} />
      </Pressable>
      {shown ? (
        <View style={{ position: "absolute", top: 20, left: 0, width: 280, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface2 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>{t("analytics.quota.caption")}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** What each playbook costs in quota: points per active agent hour and per run, one line per provider and quota period. Neutral colours (accent for the rate, muted for the rest). */
function QuotaRates(props: { theme: Theme; rates: QuotaRate[] }) {
  const { theme, rates } = props;
  const { t, locale } = useTranslation(messages);
  if (rates.length === 0) return null;
  const byPlaybook = new Map<string, QuotaRate[]>();
  for (const rate of rates) byPlaybook.set(rate.playbook, [...(byPlaybook.get(rate.playbook) ?? []), rate]);
  const points = (value: number) => (Math.round(value * 10) / 10).toLocaleString(locale);
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "700" }}>
          {t("analytics.quota.title")}
        </Text>
        <QuotaInfo theme={theme} />
      </View>
      <View style={{ borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
        {[...byPlaybook].map(([playbook, lines], index) => (
          <View key={playbook} style={{ gap: 3, padding: 10, borderTopWidth: index === 0 ? 0 : 1, borderTopColor: theme.colors.border }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{playbook}</Text>
            {lines.map((rate) => (
              <View key={`${rate.provider}/${rate.window}`} style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, alignItems: "baseline" }}>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{`${rate.provider} · ${rate.window}`}</Text>
                <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>{rate.burnRate === null ? t("analytics.quota.noHour") : t("analytics.quota.burnRate", { value: points(rate.burnRate) })}</Text>
                {rate.quotaPerRun === null ? null : <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{t("analytics.quota.perRun", { value: points(rate.quotaPerRun) })}</Text>}
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                  {[t("analytics.quota.samples", { count: Math.round(rate.steps) }), rate.lowConfidence ? t("analytics.quota.low") : null].filter(Boolean).join(" · ")}
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}
