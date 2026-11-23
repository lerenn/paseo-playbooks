import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { quotaLimitationRpc } from "../shared/contracts";
import type { QuotaLimitation } from "../shared/quota-limitation";
import { messages } from "./i18n";
import { PriorityRunLine } from "./quota-priority-line";
import { projectRows, type ProjectRow, type ProviderRow, type SlotRow, type Tone } from "./quota-rows";
import { semanticColor } from "./semantic-colors";
import type { Theme } from "./theme";

/** How often the open tab reads the figures again (the server's own readings are younger than this or refreshed meanwhile). */
const POLL_MS = 30_000;

/** The label of a hold kind; an unknown kind shows as it is. */
function kindLabel(t: (key: "quota.kind.quota" | "quota.kind.headroom" | "quota.kind.pace" | "quota.kind.steps" | "quota.kind.playbooks") => string, kind: string): string {
  switch (kind) {
    case "quota": return t("quota.kind.quota");
    case "headroom": return t("quota.kind.headroom");
    case "pace": return t("quota.kind.pace");
    case "steps": return t("quota.kind.steps");
    case "playbooks": return t("quota.kind.playbooks");
    default: return kind;
  }
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "");

/** The Quota limitation tab: per provider its usage windows and the pacing's numbers, the held runs and the exhausted marks. */
export function QuotaView(props: { theme: Theme; workspaces: ReadonlyArray<{ projectId: string; workspaceId: string }>; refreshSignal: number }) {
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
  return (
    <View style={{ gap: 14 }}>
      {error ? <Text style={{ color: semanticColor(theme, "failed") }}>{error}</Text> : null}
      {!data && !error ? <Text style={{ color: muted }}>{t("quota.loading")}</Text> : null}
      {data ? <Body theme={theme} data={data} onChanged={load} /> : null}
    </View>
  );
}

function Body(props: { theme: Theme; data: QuotaLimitation; onChanged: () => void }) {
  const { theme, data, onChanged } = props;
  const { t } = useTranslation(messages);
  const muted = theme.colors.foregroundMuted;
  const rows = projectRows(data);
  return (
    <View style={{ gap: 10 }}>
      <Text style={{ color: muted, fontSize: 12 }}>{t("quota.counts", { steps: data.stepsRunning, runs: data.runsActive })}</Text>
      {data.limitHeld.length > 0 ? (
        <Card theme={theme}>
          <Section theme={theme} title={t("quota.limitHeld")} first>
            {data.limitHeld.map((run) => (
              <Text key={run.runId} style={{ color: theme.colors.foreground, fontSize: 12 }}>{`${run.title} · ${kindLabel(t, run.kind)}: ${run.reason}`}</Text>
            ))}
          </Section>
        </Card>
      ) : null}
      {rows.length === 0 ? <Text style={{ color: muted, fontSize: 12 }}>{t("quota.noProjects")}</Text> : null}
      <Card theme={theme}>
        {rows.map((row, index) => (
          <ProjectRowView key={row.projectId} theme={theme} row={row} first={index === 0} onChanged={onChanged} />
        ))}
      </Card>
    </View>
  );
}

/** Green, red and grey are fixed hues (`semantic-colors`), the same in every theme; the text beside a bar carries the numbers too. */
const toneColor = (theme: Theme, tone: Tone) => (tone === "over" ? semanticColor(theme, "failed") : tone === "warn" ? semanticColor(theme, "waiting") : tone === "ok" ? semanticColor(theme, "done") : theme.colors.foregroundMuted);

function ProjectRowView(props: { theme: Theme; row: ProjectRow; first: boolean; onChanged: () => void }) {
  const { theme, row, first, onChanged } = props;
  const { t } = useTranslation(messages);
  const [open, setOpen] = useState(false);
  const muted = theme.colors.foregroundMuted;
  const caps = row.stepsLimit === null && row.runsLimit === null ? t("quota.noCaps") : [row.stepsLimit === null ? null : t("quota.stepsCap", { limit: row.stepsLimit }), row.runsLimit === null ? null : t("quota.runsCap", { limit: row.runsLimit })].filter(Boolean).join(" · ");
  const line = [
    row.pacing ? t("quota.pacingShort", { percent: row.percents.join("/") }) : t("quota.pacingOffShort"),
    ...row.summary.map((item) => (item.status === "over" ? t("quota.sum.over", { provider: item.provider }) : item.status === "unavailable" ? t("quota.sum.unavailable", { provider: item.provider }) : item.status === "unreported" ? t("quota.sum.unreported", { provider: item.provider }) : item.free === null ? item.provider : t("quota.sum.free", { provider: item.provider, value: Math.round(item.free) }))),
  ].join(" · ");
  return (
    <View style={{ ...(first ? {} : { borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8 }) }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: toneColor(theme, row.tone) }} />
          <Text style={{ flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{row.label}</Text>
          <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={muted} />
        </View>
        <Text style={{ color: row.pacing ? theme.colors.foreground : muted, fontSize: 12 }}>{line}</Text>
        <Text style={{ color: muted, fontSize: 11 }}>{caps}</Text>
      </Pressable>
      {open ? (
        <View style={{ gap: 8, paddingTop: 8 }}>
          {row.sets.map((set) => (
            <View key={set.limits.repos.join(",")} style={{ gap: 8 }}>
              {row.sets.length > 1 ? <Text style={{ color: muted, fontSize: 11 }}>{`${t("quota.repos", { repos: set.limits.repos.join(", ") })} · ${set.limits.pacing ? t("quota.pacingOnAt", { percent: set.limits.usablePercent }) : t("quota.pacingOff")}`}</Text> : null}
              {set.providers.length === 0 ? <Text style={{ color: muted, fontSize: 12 }}>{t("quota.noProviders")}</Text> : null}
              {set.providers.map((provider) => (
                <ProviderView key={provider.provider} theme={theme} provider={provider} canEdit={set.limits.pacing} onChanged={onChanged} />
              ))}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ProviderView(props: { theme: Theme; provider: ProviderRow; canEdit: boolean; onChanged: () => void }) {
  const { theme, provider, canEdit, onChanged } = props;
  const heldIds = new Set(provider.held.map((run) => run.runId));
  const { t } = useTranslation(messages);
  const muted = theme.colors.foregroundMuted;
  const flag = provider.status === "unavailable" ? t("quota.state.unavailable") : provider.status === "unreported" ? t("quota.state.unreported") : provider.state === "override" ? t("quota.state.override") : null;
  return (
    <View style={{ gap: 3, borderLeftWidth: 2, borderLeftColor: theme.colors.border, paddingLeft: 8 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>{provider.provider}</Text>
      {flag ? <Text style={{ color: provider.status === "unavailable" ? semanticColor(theme, "failed") : muted, fontSize: 12 }}>{flag}</Text> : null}
      {provider.readAt ? <Text style={{ color: muted, fontSize: 11 }}>{t("quota.readAt", { when: when(provider.readAt) })}</Text> : null}
      {provider.overrideUntil ? <Text style={{ color: muted, fontSize: 11 }}>{t("quota.overrideUntil", { when: when(provider.overrideUntil) })}</Text> : null}
      {provider.slots.length === 0 ? <Text style={{ color: muted, fontSize: 12 }}>{t("quota.noReading")}</Text> : null}
      {provider.slots.map((slot) => (
        <SlotView key={slot.id} theme={theme} slot={slot} />
      ))}
      {provider.reservations.length > 0 ? (
        <Lines theme={theme} title={t("quota.reservations")}>
          {provider.reservations.map((run) => (
            <PriorityRunLine key={run.runId} theme={theme} run={run} canEdit={canEdit && !heldIds.has(run.runId)} onChanged={onChanged} detail={`${run.title} · ${Object.entries(run.remaining).map(([name, value]) => t("quota.remaining", { window: name, value })).join(", ")}`} />
          ))}
        </Lines>
      ) : null}
      {provider.held.length > 0 ? (
        <Lines theme={theme} title={t("quota.held")}>
          {provider.held.map((run) => (
            <PriorityRunLine key={run.runId} theme={theme} run={run} canEdit={canEdit} onChanged={onChanged} detail={`${run.title} · ${kindLabel(t, run.kind)}: ${run.reason}${run.retryAt ? ` (${t("quota.retry", { when: when(run.retryAt) })})` : ""}`} />
          ))}
        </Lines>
      ) : null}
      {provider.exhausted.length > 0 ? (
        <Lines theme={theme} title={t("quota.exhausted")}>
          {provider.exhausted.map((mark) => (
            <Text key={`${mark.runId}/${mark.target}`} style={{ color: theme.colors.foreground, fontSize: 12 }}>{`${mark.target} · ${mark.title} · ${t("quota.until", { when: when(mark.until) })}`}</Text>
          ))}
        </Lines>
      ) : null}
    </View>
  );
}

/** A usage window: name, a bar and the numbers. Paced: grey usage up to the pace ceiling, red above it, green for what is still free, a tick at the ceiling. Not paced: usage only. */
function SlotView(props: { theme: Theme; slot: SlotRow }) {
  const { theme, slot } = props;
  const { t } = useTranslation(messages);
  const muted = theme.colors.foregroundMuted;
  const { bar } = slot;
  const facts = [
    slot.used === null ? null : t("quota.used", { value: slot.used }),
    slot.reserved > 0 ? t("quota.reserved", { value: slot.reserved }) : null,
    slot.paced ? (slot.over > 0 ? t("quota.overBy", { value: slot.over }) : t("quota.free", { value: slot.free ?? 0 })) : t("quota.notPaced"),
    slot.paced && slot.ceiling !== null ? t("quota.ceiling", { value: slot.ceiling }) : null,
  ].filter((fact): fact is string => fact !== null);
  const pct = (value: number) => `${value}%` as const;
  return (
    <View style={{ gap: 3, paddingTop: 4 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
        {slot.name}
        {slot.modelScoped ? ` · ${t("quota.modelWindow")}` : ""}
      </Text>
      <View style={{ height: 8, borderRadius: 4, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
        <View style={{ position: "absolute", left: 0, width: pct(bar.grey), height: 8, backgroundColor: theme.colors.foregroundMuted }} />
        {bar.green > 0 ? <View style={{ position: "absolute", left: pct(bar.greenFrom), width: pct(bar.green), height: 8, backgroundColor: semanticColor(theme, "done") }} /> : null}
        {bar.red > 0 ? <View style={{ position: "absolute", left: pct(bar.redFrom), width: pct(bar.red), height: 8, backgroundColor: semanticColor(theme, "failed") }} /> : null}
        {bar.tick !== null ? <View style={{ position: "absolute", left: pct(Math.min(bar.tick, 99)), width: 2, height: 8, backgroundColor: theme.colors.foreground }} /> : null}
      </View>
      <Text style={{ color: slot.over > 0 ? semanticColor(theme, "failed") : muted, fontSize: 12 }}>{facts.join(" · ")}</Text>
      {slot.resetsAt ? <Text style={{ color: muted, fontSize: 11 }}>{t("quota.resets", { when: when(slot.resetsAt) })}</Text> : null}
      {slot.stale ? <Text style={{ color: muted, fontSize: 11 }}>{t("quota.stale")}</Text> : null}
    </View>
  );
}

/** A titled group of plain lines inside a provider. */
function Lines(props: { theme: Theme; title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 2, paddingTop: 4 }}>
      <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 12 }}>{props.title}</Text>
      {props.children}
    </View>
  );
}

function Card(props: { theme: Theme; children: React.ReactNode }) {
  const { theme } = props;
  return <View style={{ gap: 6, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, padding: 12 }}>{props.children}</View>;
}

function Section(props: { theme: Theme; title: string; first?: boolean; children: React.ReactNode }) {
  const { theme } = props;
  return (
    <View style={{ gap: 3, ...(props.first ? {} : { borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8 }) }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{props.title}</Text>
      {props.children}
    </View>
  );
}
