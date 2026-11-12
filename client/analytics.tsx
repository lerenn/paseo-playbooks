import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { tokensOf, type AgentRow, type Analytics, type UsageRow } from "../shared/analytics";
import { analyticsStateRpc } from "../shared/contracts";
import type { Usage } from "../shared/types";
import type { Theme } from "./theme";

const RANGES: Array<{ label: string; days: number | undefined }> = [
  { label: "Last day", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "All time", days: undefined },
];

export function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(value));
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
    fetchAnalytics(days === undefined ? {} : { days })
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
          <Table theme={theme} title="By playbook" rows={data.byPlaybook} />
          <Table theme={theme} title="By step" rows={data.byStep} showWaste />
          <Table theme={theme} title="By role" rows={data.byRole} showWaste />
          <Table theme={theme} title="By model" rows={data.byModel} showWaste />
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

function Table(props: { theme: Theme; title: string; rows: UsageRow[]; showWaste?: boolean }) {
  const { theme, rows } = props;
  if (rows.length === 0) return null;
  const top = Math.max(...rows.map((row) => tokensOf(row.usage)), 1);
  return (
    <View style={{ gap: 8 }}>
      <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "700" }}>
        {props.title}
      </Text>
      <View style={{ borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, overflow: "hidden" }}>
        {rows.map((row, index) => (
          <View key={row.key} style={{ gap: 4, padding: 10, borderTopWidth: index === 0 ? 0 : 1, borderTopColor: theme.colors.border }}>
            <View style={{ flexDirection: "row", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
              <Text style={{ flex: 1, minWidth: 140, color: theme.colors.foreground, fontSize: 13 }}>{row.key}</Text>
              <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{compactNumber(tokensOf(row.usage))}</Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                {props.showWaste ? `${row.attempts} attempts` : `${row.runs} runs`}
                {props.showWaste && row.wastedAttempts > 0 ? ` · ${row.wastedAttempts} wasted (${compactNumber(row.wastedTokens)})` : ""}
                {row.usage.contextPeak > 0 ? ` · ctx ${compactNumber(row.usage.contextPeak)}` : ""}
              </Text>
            </View>
            <View style={{ height: 4, borderRadius: 2, backgroundColor: theme.colors.surface2 }}>
              <View style={{ height: 4, borderRadius: 2, width: `${Math.max(2, Math.round((tokensOf(row.usage) / top) * 100))}%`, backgroundColor: theme.colors.accent }} />
            </View>
            {row.detail ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{row.detail}</Text> : null}
          </View>
        ))}
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
