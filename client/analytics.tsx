import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { rowId, tokensOf, type AgentRow, type Analytics, type DailySeries, type UsageRow } from "../shared/analytics";
import { analyticsStateRpc } from "../shared/contracts";
import type { Usage } from "../shared/types";
import { axisTicks, compactNumber, isDarkColor, labelIndexes, niceAxis, seriesColor, shortDate } from "./analytics-chart";
import type { Theme } from "./theme";

const RANGES: Array<{ label: string; days: number | undefined }> = [
  { label: "Last day", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "All time", days: undefined },
];

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
  const [picked, setPicked] = useState<number | null>(null);
  const [isolated, setIsolated] = useState<string | null>(null);
  const muted = theme.colors.foregroundMuted;
  const surface = theme.colors.surface1;
  const visible = chart.series.filter((row) => isolated === null || rowId(row) === isolated);
  const totals = chart.days.map((_, i) => visible.reduce((sum, row) => sum + row.tokens[i]!, 0));
  const peak = Math.max(...totals, 0);
  if (chart.series.length === 0) return null;
  if (peak === 0 && isolated === null) {
    return <Text style={{ color: muted, fontSize: 12, padding: 12 }}>No usage per day to chart in this range.</Text>;
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
              {compactNumber(tick)}
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
                  accessibilityLabel={`${day}: ${totals[i]!.toLocaleString()} tokens`}
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
                {shortDate(chart.days[pick]!)} · {totals[pick]!.toLocaleString()} tokens
              </Text>
              {visible
                .filter((row) => row.tokens[pick]! > 0)
                .map((row) => (
                  <View key={rowId(row)} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                    <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.get(rowId(row)) }} />
                    <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.foreground, fontSize: 10 }}>
                      {row.key}: {row.tokens[pick]!.toLocaleString()}
                    </Text>
                  </View>
                ))}
              {totals[pick] === 0 ? <Text style={{ color: muted, fontSize: 10 }}>No usage that day.</Text> : null}
            </View>
          ) : null}
        </View>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginLeft: AXIS_WIDTH }}>
        {labelIndexes(count).map((i) => (
          <Text key={i} style={{ color: muted, fontSize: 10 }}>
            {shortDate(chart.days[i]!)}
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
              accessibilityLabel={`${isolated === rowId(row) ? "Show all" : "Only"} ${row.key}`}
              onPress={() => setIsolated(isolated === rowId(row) ? null : rowId(row))}
              style={{ flexDirection: "row", alignItems: "center", gap: 5, maxWidth: "100%", borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2, opacity: on ? 1 : 0.45, backgroundColor: isolated === rowId(row) ? theme.colors.surface2 : "transparent" }}
            >
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.get(rowId(row)) }} />
              <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.foreground, fontSize: 11 }}>
                {row.key}
              </Text>
              <Text style={{ color: muted, fontSize: 11 }}>{compactNumber(row.total)}</Text>
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
  const fetchAnalytics = useRpc(analyticsStateRpc);
  const [days, setDays] = useState<number | undefined>(30);
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
          <Pill key={range.label} theme={theme} label={range.label} selected={days === range.days} onPress={() => setDays(range.days)} />
        ))}
      </View>
      {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
      {!data && !error ? <Text style={{ color: muted }}>Loading…</Text> : null}
      {data ? (
        <>
          <Summary theme={theme} data={data} />
          {data.total.turns === 0 ? (
            <Text style={{ color: muted, fontSize: 13 }}>
              No usage recorded in this range yet. It is recorded as agents finish turns, so runs from before this feature show nothing.
            </Text>
          ) : null}
          <Breakdown theme={theme} title="By playbook" rows={data.byPlaybook} chart={data.daily?.byPlaybook} />
          <Breakdown theme={theme} title="By step" rows={data.byStep} chart={data.daily?.byStep} showWaste />
          <Breakdown theme={theme} title="By role" rows={data.byRole} chart={data.daily?.byRole} showWaste />
          <Breakdown theme={theme} title="By model" rows={data.byModel} chart={data.daily?.byModel} showWaste />
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
  const total: Usage = data.total;
  const overhead = tokensOf(data.overhead.manager) + tokensOf(data.overhead.deciders);
  const share = tokensOf(total) > 0 ? Math.round((overhead / tokensOf(total)) * 100) : 0;
  const wasted = data.byStep.reduce((sum, row) => sum + row.wastedTokens, 0);
  const cacheBase = total.inputTokens + total.cachedInputTokens;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
      <Stat theme={theme} label="Runs" value={String(data.runs)} hint={[data.runsWithoutUsage ? `${data.runsWithoutUsage} without usage` : "", data.runsWithInvalidManagerUsage ? `manager usage of ${data.runsWithInvalidManagerUsage} older runs hidden (inflated)` : ""].filter(Boolean).join(" · ") || undefined} />
      <Stat theme={theme} label="Tokens (excl. cache)" value={compactNumber(tokensOf(total))} hint={`${compactNumber(total.inputTokens)} in · ${compactNumber(total.outputTokens)} out · ${compactNumber(total.cachedInputTokens)} cached`} />
      <Stat theme={theme} label="Wasted on retries" value={compactNumber(wasted)} hint="tokens of redone attempts" />
      <Stat theme={theme} label="Cache hits" value={cacheBase > 0 ? `${Math.round((total.cachedInputTokens / cacheBase) * 100)}%` : "–"} />
      <Stat theme={theme} label="Managers + deciders" value={`${share}%`} hint="of the tokens, outside the steps" />
    </View>
  );
}

/** One breakdown: its title, the per-day chart, then the table rows, all in one card with separators. */
function Breakdown(props: { theme: Theme; title: string; rows: UsageRow[]; chart: DailySeries | undefined; showWaste?: boolean }) {
  const { theme, rows, chart } = props;
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
                  <Text style={{ flexShrink: 1, color: theme.colors.foreground, fontSize: 13 }}>{row.key}</Text>
                </View>
                <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{compactNumber(tokensOf(row.usage))}</Text>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                  {props.showWaste ? `${row.attempts} attempts` : `${row.runs} runs`}
                  {props.showWaste && row.wastedAttempts > 0 ? ` · ${row.wastedAttempts} wasted (${compactNumber(row.wastedTokens)})` : ""}
                  {row.usage.contextPeak > 0 ? ` · ctx ${compactNumber(row.usage.contextPeak)}` : ""}
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
  if (rows.length === 0) return null;
  return (
    <View style={{ gap: 8 }}>
      <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "700" }}>
        Top agents
      </Text>
      <View style={{ borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, overflow: "hidden" }}>
        {rows.map((row, index) => (
          <View key={row.agentId} style={{ gap: 2, padding: 10, borderTopWidth: index === 0 ? 0 : 1, borderTopColor: theme.colors.border }}>
            <View style={{ flexDirection: "row", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
              <Text style={{ flex: 1, minWidth: 140, color: theme.colors.foreground, fontSize: 13 }}>{row.title || row.agentId}</Text>
              <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{compactNumber(tokensOf(row.usage))}</Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                {row.usage.turns} turns · {compactNumber(row.usage.inputTokens)} in · {compactNumber(row.usage.cachedInputTokens)} cached · {compactNumber(row.usage.outputTokens)} out · ctx {compactNumber(row.usage.contextPeak)}
              </Text>
            </View>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {[row.kind, row.role ? `role ${row.role}` : null, row.model, row.agentId.slice(0, 8)].filter(Boolean).join(" · ")}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
