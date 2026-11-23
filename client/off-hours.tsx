import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { describeDays, describeRanges, weeklyClosedRows } from "../shared/closed-hours";
import { quotaLimitationRpc } from "../shared/contracts";
import type { QuotaLimitation } from "../shared/quota-limitation";
import { messages } from "./i18n";
import { barSegments, dayKind, HOUR_TICKS, offHoursRows, rowState, whenLabel, type OffHoursRow, type OffHoursSchedule } from "./off-hours-rows";
import { semanticColor } from "./semantic-colors";
import type { Theme } from "./theme";

/** How often the open tab reads the state again. */
const POLL_MS = 30_000;

/** The Off hours tab (ADR 2026-11-23-off-hours-tab): one collapsed row per project, like the Quota tab, read-only. It reads the quota reading, which carries each project's resolved schedule. */
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
  const rows = data ? offHoursRows(data) : [];
  return (
    <View style={{ gap: 14 }}>
      {error ? <Text style={{ color: semanticColor(theme, "failed") }}>{error}</Text> : null}
      {!data && !error ? <Text style={{ color: muted }}>{t("offHours.loading")}</Text> : null}
      {data && rows.length === 0 ? <Text style={{ color: muted, fontSize: 12 }}>{t("offHours.noProjects")}</Text> : null}
      {data && rows.length > 0 ? (
        <View style={{ gap: 6, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, padding: 12 }}>
          {rows.map((row, index) => (
            <ProjectRowView key={row.projectId} theme={theme} row={row} nowIso={data.now} first={index === 0} />
          ))}
        </View>
      ) : null}
      {data && rows.some((row) => row.schedules.length > 0) ? <Text style={{ color: muted, fontSize: 11 }}>{t("offHours.readOnly")}</Text> : null}
    </View>
  );
}

function ProjectRowView(props: { theme: Theme; row: OffHoursRow; nowIso: string; first: boolean }) {
  const { theme, row, nowIso, first } = props;
  const { t, locale } = useTranslation(messages);
  const [open, setOpen] = useState(false);
  const muted = theme.colors.foregroundMuted;
  const state = rowState(row);
  const closed = state?.now?.closed === true;
  let summary = t("offHours.sum.none");
  if (state?.now) {
    const at = state.now.changeAt ? whenLabel(state.now.changeAt, nowIso, state.timezone, locale) : null;
    summary = closed ? (at ? t("offHours.sum.closedOpens", { when: at }) : t("offHours.sum.closed")) : at ? t("offHours.sum.openCloses", { when: at }) : t("offHours.sum.open");
  } else if (state) summary = t("offHours.sum.configured");
  if (row.schedules.length > 1) summary = `${summary} · ${t("offHours.sum.more", { count: row.schedules.length - 1 })}`;
  const dot = closed ? semanticColor(theme, "paused") : muted;
  return (
    <View style={{ ...(first ? {} : { borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8 }) }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
          <Text style={{ flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{row.label}</Text>
          <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={muted} />
        </View>
        <Text style={{ color: closed ? semanticColor(theme, "paused") : state ? theme.colors.foreground : muted, fontSize: 12 }}>{summary}</Text>
      </Pressable>
      {open ? (
        <View style={{ gap: 12, paddingTop: 8 }}>
          {row.schedules.length === 0 ? (
            <View style={{ gap: 4 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{t("offHours.empty")}</Text>
              <Text style={{ color: muted, fontSize: 12 }}>{t("offHours.emptyHint")}</Text>
            </View>
          ) : null}
          {row.schedules.map((schedule) => (
            <ScheduleView key={schedule.key} theme={theme} schedule={schedule} nowIso={nowIso} showRepos={row.schedules.length > 1} />
          ))}
          {row.schedules.length > 0 ? (
            <View style={{ gap: 3 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>{t("offHours.effectsTitle")}</Text>
              <Text style={{ color: muted, fontSize: 12 }}>{t("offHours.effectQuota")}</Text>
              <Text style={{ color: muted, fontSize: 12 }}>{t("offHours.effectWarden")}</Text>
              <Text style={{ color: muted, fontSize: 12 }}>{t("offHours.effectOutside")}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function ScheduleView(props: { theme: Theme; schedule: OffHoursSchedule; nowIso: string; showRepos: boolean }) {
  const { theme, schedule, nowIso, showRepos } = props;
  const { t, locale } = useTranslation(messages);
  const muted = theme.colors.foregroundMuted;
  const dayLabel = (day: number) => new Date(Date.UTC(2024, 0, 7 + day)).toLocaleDateString(locale, { weekday: "short", timeZone: "UTC" });
  const state = schedule.now;
  const at = state?.changeAt ? whenLabel(state.changeAt, nowIso, schedule.timezone, locale) : null;
  return (
    <View style={{ gap: 8 }}>
      {showRepos ? <Text style={{ color: muted, fontSize: 11 }}>{t("offHours.repos", { repos: schedule.repos.join(", ") })}</Text> : null}
      {state ? (
        <View style={{ gap: 2 }}>
          <Text style={{ color: state.closed ? semanticColor(theme, "paused") : theme.colors.foreground, fontSize: 15, fontWeight: "700" }}>{state.closed ? t("offHours.closedNow") : t("offHours.openNow")}</Text>
          <Text style={{ color: muted, fontSize: 12 }}>
            {at ? (state.closed ? t("offHours.opensAt", { when: at, timezone: schedule.timezone }) : t("offHours.closesAt", { when: at, timezone: schedule.timezone })) : state.closed ? t("offHours.alwaysClosed") : t("offHours.noChange")}
          </Text>
        </View>
      ) : null}
      <View style={{ gap: 3 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>{t("offHours.schedule", { timezone: schedule.timezone })}</Text>
        {weeklyClosedRows(schedule.slots).map((row) => (
          <Text key={`${row.days.join(",")}|${describeRanges(row.ranges)}`} style={{ color: muted, fontSize: 12 }}>
            {`${describeDays(row.days, dayLabel)}: ${row.allDay ? t("offHours.allDay") : describeRanges(row.ranges)}`}
          </Text>
        ))}
      </View>
      {schedule.week ? <Planner theme={theme} week={schedule.week} timezone={schedule.timezone} /> : null}
    </View>
  );
}

/**
 * The weekly planner: one 24 h bar per day (Monday first), open neutral, closed violet, ticks at 0/6/12/18/24, today highlighted and a
 * marker at the current time of the schedule's timezone. The bars are rows that fill the width, so they fit a narrow screen as is. A
 * daylight-saving day is drawn on the clock (see ADR); its note says how long it really is.
 */
function Planner(props: { theme: Theme; week: NonNullable<OffHoursSchedule["week"]>; timezone: string }) {
  const { theme, week, timezone } = props;
  const { t, locale } = useTranslation(messages);
  const muted = theme.colors.foregroundMuted;
  const dayName = (day: number, style: "short" | "long") => new Date(Date.UTC(2024, 0, 7 + day)).toLocaleDateString(locale, { weekday: style, timeZone: "UTC" });
  const labelWidth = 34;
  return (
    <View accessibilityLabel={t("offHours.plannerLabel", { timezone })} style={{ gap: 4 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>{t("offHours.planner", { timezone })}</Text>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <View style={{ width: labelWidth }} />
        <View style={{ flex: 1, height: 12 }}>
          {HOUR_TICKS.map((hour) => (
            <Text key={hour} style={{ position: "absolute", left: `${(hour / 24) * 100}%`, width: 24, marginLeft: hour === 24 ? -24 : hour === 0 ? 0 : -12, textAlign: hour === 24 ? "right" : hour === 0 ? "left" : "center", color: muted, fontSize: 9 }}>{String(hour)}</Text>
          ))}
        </View>
      </View>
      {week.days.map((day) => {
        const isToday = day.day === week.today;
        const kind = dayKind(day.ranges);
        const name = dayName(day.day, "long");
        const alt = kind === "closedAll" ? t("offHours.alt.closedAll", { day: name }) : kind === "openAll" ? t("offHours.alt.openAll", { day: name }) : t("offHours.alt.closedRanges", { day: name, ranges: day.ranges.map((range) => describeRanges([range])).join(t("offHours.alt.and")) });
        return (
          <View key={day.day} style={{ gap: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={{ width: labelWidth, color: isToday ? theme.colors.foreground : muted, fontSize: 11, fontWeight: isToday ? "700" : "400" }}>{dayName(day.day, "short")}</Text>
              <View accessible accessibilityRole="image" accessibilityLabel={isToday ? `${alt} ${t("offHours.alt.today")}` : alt} style={{ flex: 1, height: 14, borderRadius: 3, overflow: "hidden", backgroundColor: theme.colors.surface2, borderWidth: isToday ? 1 : 0, borderColor: theme.colors.foreground }}>
                {barSegments(day.ranges).map((segment, index) => (
                  <View key={index} style={{ position: "absolute", top: 0, bottom: 0, left: `${segment.left}%`, width: `${segment.width}%`, backgroundColor: semanticColor(theme, "paused") }} />
                ))}
                {HOUR_TICKS.filter((hour) => hour > 0 && hour < 24).map((hour) => (
                  <View key={hour} style={{ position: "absolute", top: 0, bottom: 0, left: `${(hour / 24) * 100}%`, width: 1, backgroundColor: theme.colors.surface1, opacity: 0.6 }} />
                ))}
                {isToday ? <View style={{ position: "absolute", top: 0, bottom: 0, left: `${Math.min(99.5, (week.nowMin / 1440) * 100)}%`, width: 2, backgroundColor: theme.colors.foreground }} /> : null}
              </View>
            </View>
            {day.lengthMin !== 1440 ? <Text style={{ marginLeft: labelWidth + 6, color: muted, fontSize: 10 }}>{t("offHours.dstDay", { hours: day.lengthMin / 60 })}</Text> : null}
          </View>
        );
      })}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, marginLeft: labelWidth + 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: semanticColor(theme, "paused") }} />
          <Text style={{ color: muted, fontSize: 10 }}>{t("offHours.legendClosed")}</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <View style={{ width: 2, height: 10, backgroundColor: theme.colors.foreground }} />
          <Text style={{ color: muted, fontSize: 10 }}>{t("offHours.legendNow")}</Text>
        </View>
      </View>
    </View>
  );
}
