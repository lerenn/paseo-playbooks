import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { describeDays, describeRanges, weeklyClosedRows } from "../shared/closed-hours";
import { quotaLimitationRpc } from "../shared/contracts";
import type { QuotaLimitation } from "../shared/quota-limitation";
import { messages } from "./i18n";
import { offHoursGroups, type OffHoursGroup } from "./off-hours-rows";
import { semanticColor } from "./semantic-colors";
import type { Theme } from "./theme";

/** How often the open tab reads the state again. */
const POLL_MS = 30_000;

/** The Off hours tab (ADR 2026-11-23-off-hours-tab): read-only view of the configured `closed_hours` and what a closed slot does. Reads the quota reading, which carries the resolved schedule. */
export function OffHoursView(props: { theme: Theme; workspaces: ReadonlyArray<{ projectId: string; workspaceId: string }>; refreshSignal: number }) {
  const { theme, workspaces, refreshSignal } = props;
  const { t } = useTranslation(messages);
  const fetchQuota = useRpc(quotaLimitationRpc);
  const [data, setData] = useState<QuotaLimitation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchQuota({ workspaces: [...workspaces] })
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces]);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load, refreshSignal]);

  const muted = theme.colors.foregroundMuted;
  const groups = data ? offHoursGroups(data) : [];
  return (
    <View style={{ gap: 14 }}>
      {error ? <Text style={{ color: semanticColor(theme, "failed") }}>{error}</Text> : null}
      {!data && !error ? <Text style={{ color: muted }}>{t("offHours.loading")}</Text> : null}
      {data && groups.length === 0 ? (
        <View style={{ gap: 4 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{t("offHours.empty")}</Text>
          <Text style={{ color: muted, fontSize: 12 }}>{t("offHours.emptyHint")}</Text>
        </View>
      ) : null}
      {groups.map((group) => (
        <GroupCard key={group.key} theme={theme} group={group} several={groups.length > 1} />
      ))}
      {groups.length > 0 ? (
        <View style={{ gap: 4 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{t("offHours.effectsTitle")}</Text>
          <Text style={{ color: muted, fontSize: 12 }}>{t("offHours.effectQuota")}</Text>
          <Text style={{ color: muted, fontSize: 12 }}>{t("offHours.effectWarden")}</Text>
          <Text style={{ color: muted, fontSize: 12 }}>{t("offHours.effectOutside")}</Text>
          <Text style={{ color: muted, fontSize: 11 }}>{t("offHours.readOnly")}</Text>
        </View>
      ) : null}
    </View>
  );
}

function GroupCard(props: { theme: Theme; group: OffHoursGroup; several: boolean }) {
  const { theme, group, several } = props;
  const { t, locale } = useTranslation(messages);
  const muted = theme.colors.foregroundMuted;
  const dayLabel = (day: number) => new Date(Date.UTC(2024, 0, 7 + day)).toLocaleDateString(locale, { weekday: "short", timeZone: "UTC" });
  const when = (iso: string) => new Date(iso).toLocaleString(locale, { timeZone: group.timezone, weekday: "short", hour: "2-digit", minute: "2-digit" });
  const state = group.now;
  // A closed slot uses the violet "paused" tone; open stays neutral. Never red.
  const stateColor = state?.closed ? semanticColor(theme, "paused") : theme.colors.foreground;
  return (
    <View style={{ gap: 8, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, padding: 12 }}>
      {several ? <Text style={{ color: muted, fontSize: 12 }}>{t("offHours.projects", { projects: group.projects.join(", ") })}</Text> : null}
      {state ? (
        <View style={{ gap: 2 }}>
          <Text style={{ color: stateColor, fontSize: 15, fontWeight: "700" }}>{state.closed ? t("offHours.closedNow") : t("offHours.openNow")}</Text>
          <Text style={{ color: muted, fontSize: 12 }}>
            {state.changeAt === null
              ? state.closed
                ? t("offHours.alwaysClosed")
                : t("offHours.noChange")
              : state.closed
                ? t("offHours.opensAt", { when: when(state.changeAt), timezone: group.timezone })
                : t("offHours.closesAt", { when: when(state.changeAt), timezone: group.timezone })}
          </Text>
        </View>
      ) : null}
      <View style={{ gap: 3 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{t("offHours.schedule", { timezone: group.timezone })}</Text>
        {weeklyClosedRows(group.slots).map((row) => (
          <Text key={`${row.days.join(",")}|${describeRanges(row.ranges)}`} style={{ color: muted, fontSize: 12 }}>
            {`${describeDays(row.days, dayLabel)}: ${row.allDay ? t("offHours.allDay") : describeRanges(row.ranges)}`}
          </Text>
        ))}
      </View>
    </View>
  );
}
