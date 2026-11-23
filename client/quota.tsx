import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { quotaLimitationRpc } from "../shared/contracts";
import type { QuotaLimitation, QuotaProject, QuotaProvider, QuotaWindow } from "../shared/quota-limitation";
import { messages } from "./i18n";
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
export function QuotaView(props: { theme: Theme; workspaces: ReadonlyArray<{ projectId: string; workspaceId: string }> }) {
  const { theme, workspaces } = props;
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
  }, [load]);

  const muted = theme.colors.foregroundMuted;
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "flex-end", gap: 8 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={t("quota.refresh")} hitSlop={8} onPress={load} style={{ borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, padding: 7 }}>
          <Icon name="RefreshCw" size={16} color={muted} />
        </Pressable>
      </View>
      {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
      {!data && !error ? <Text style={{ color: muted }}>{t("quota.loading")}</Text> : null}
      {data ? <Body theme={theme} data={data} /> : null}
    </View>
  );
}

function Body(props: { theme: Theme; data: QuotaLimitation }) {
  const { theme, data } = props;
  const { t } = useTranslation(messages);
  const muted = theme.colors.foregroundMuted;
  return (
    <View style={{ gap: 14 }}>
      <Card theme={theme}>
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "700" }}>{t("quota.projects")}</Text>
        {data.projects.length === 0 ? <Text style={{ color: muted, fontSize: 12 }}>{t("quota.noProjects")}</Text> : null}
        {data.projects.map((project) => (
          <ProjectLimits key={project.projectId} theme={theme} project={project} />
        ))}
        <Text style={{ color: muted, fontSize: 12 }}>{t("quota.counts", { steps: data.stepsRunning, runs: data.runsActive })}</Text>
        {data.limitHeld.length > 0 ? (
          <Section theme={theme} title={t("quota.limitHeld")}>
            {data.limitHeld.map((run) => (
              <Text key={run.runId} style={{ color: theme.colors.foreground, fontSize: 12 }}>{`${run.title} · ${kindLabel(t, run.kind)}: ${run.reason}`}</Text>
            ))}
          </Section>
        ) : null}
      </Card>
      {data.providers.length === 0 ? <Text style={{ color: muted }}>{t("quota.noProviders")}</Text> : null}
      {data.providers.map((provider) => (
        <Provider key={provider.provider} theme={theme} provider={provider} />
      ))}
    </View>
  );
}

function ProjectLimits(props: { theme: Theme; project: QuotaProject }) {
  const { theme, project } = props;
  const { t } = useTranslation(messages);
  const muted = theme.colors.foregroundMuted;
  return (
    <View style={{ gap: 3, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{project.label}</Text>
      {project.limits.map((limits) => (
        <View key={limits.repos.join(",")} style={{ gap: 2 }}>
          {project.limits.length > 1 ? <Text style={{ color: muted, fontSize: 11 }}>{t("quota.repos", { repos: limits.repos.join(", ") })}</Text> : null}
          <Text style={{ color: limits.pacing ? theme.colors.foreground : muted, fontSize: 12 }}>{limits.pacing ? t("quota.pacingOnAt", { percent: limits.usablePercent }) : t("quota.pacingOff")}</Text>
          <Text style={{ color: muted, fontSize: 12 }}>
            {[limits.stepsLimit === null ? t("quota.stepsNoCap") : t("quota.stepsCap", { limit: limits.stepsLimit }), limits.runsLimit === null ? t("quota.runsNoCap") : t("quota.runsCap", { limit: limits.runsLimit })].join(" · ")}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Provider(props: { theme: Theme; provider: QuotaProvider }) {
  const { theme, provider } = props;
  const { t } = useTranslation(messages);
  const muted = theme.colors.foregroundMuted;
  // Nothing is paced when no project has pacing on, whatever the reading says.
  const paced = provider.pacedBy.length > 0;
  const tone = !paced ? muted : provider.state === "ok" ? theme.colors.foreground : provider.state === "unavailable" ? theme.colors.statusDanger : muted;
  return (
    <Card theme={theme}>
      <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "700" }}>{provider.provider}</Text>
      <Text style={{ color: tone, fontSize: 12 }}>{paced ? `${t(`quota.state.${provider.state}`)} · ${t("quota.pacedBy", { projects: provider.pacedBy.join(", ") })}` : t("quota.noPacing")}</Text>
      {provider.readAt ? <Text style={{ color: muted, fontSize: 11 }}>{t("quota.readAt", { when: when(provider.readAt) })}</Text> : null}
      {provider.overrideUntil ? <Text style={{ color: muted, fontSize: 11 }}>{t("quota.overrideUntil", { when: when(provider.overrideUntil) })}</Text> : null}
      {provider.windows.length === 0 ? <Text style={{ color: muted, fontSize: 12 }}>{t("quota.noReading")}</Text> : null}
      {provider.windows.map((slot) => (
        <Slot key={slot.id} theme={theme} slot={slot} />
      ))}
      {provider.reservations.length > 0 ? (
        <Section theme={theme} title={t("quota.reservations")}>
          {provider.reservations.map((run) => (
            <Text key={run.runId} style={{ color: theme.colors.foreground, fontSize: 12 }}>
              {`${run.title} · ${Object.entries(run.remaining).map(([name, value]) => t("quota.remaining", { window: name, value })).join(", ")}`}
            </Text>
          ))}
        </Section>
      ) : null}
      {provider.held.length > 0 ? (
        <Section theme={theme} title={t("quota.held")}>
          {provider.held.map((run) => (
            <Text key={run.runId} style={{ color: theme.colors.foreground, fontSize: 12 }}>
              {`${run.title} · ${kindLabel(t, run.kind)}: ${run.reason}${run.retryAt ? ` (${t("quota.retry", { when: when(run.retryAt) })})` : ""}`}
            </Text>
          ))}
        </Section>
      ) : null}
      {provider.exhausted.length > 0 ? (
        <Section theme={theme} title={t("quota.exhausted")}>
          {provider.exhausted.map((mark) => (
            <Text key={`${mark.runId}/${mark.target}`} style={{ color: theme.colors.foreground, fontSize: 12 }}>{`${mark.target} · ${mark.title} · ${t("quota.until", { when: when(mark.until) })}`}</Text>
          ))}
        </Section>
      ) : null}
    </Card>
  );
}

function Slot(props: { theme: Theme; slot: QuotaWindow }) {
  const { theme, slot } = props;
  const { t } = useTranslation(messages);
  const muted = theme.colors.foregroundMuted;
  const full = Math.max(100, slot.used ?? 0);
  const bar = (value: number) => `${Math.min(100, Math.max(0, (value / full) * 100))}%` as const;
  const over = slot.paces.some((pace) => pace.headroom < 0);
  const facts = [slot.used === null ? null : t("quota.used", { value: slot.used }), slot.reserved > 0 ? t("quota.reserved", { value: slot.reserved }) : null, slot.paces.length === 0 ? t("quota.notPaced") : null].filter((fact): fact is string => fact !== null);
  return (
    <View style={{ gap: 4, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
        {slot.name}
        {slot.modelScoped ? ` · ${t("quota.modelWindow")}` : ""}
      </Text>
      {/* Usage bar: the fill is the usage, the tick the pace ceiling, the shade past `usable` the reserve. */}
      <View style={{ height: 8, borderRadius: 4, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
        {slot.used !== null ? <View style={{ width: bar(slot.used), height: 8, backgroundColor: over ? theme.colors.statusDanger : theme.colors.foregroundMuted }} /> : null}
        {slot.paces.map((pace) => (
          <View key={pace.usable} style={{ position: "absolute", left: bar(pace.ceiling), width: 2, height: 8, backgroundColor: theme.colors.foreground }} />
        ))}
      </View>
      <Text style={{ color: muted, fontSize: 12 }}>{facts.join(" · ")}</Text>
      {slot.paces.map((pace) => (
        <Text key={pace.usable} style={{ color: muted, fontSize: 12 }}>
          {`${t("quota.paceAt", { percent: pace.usable, projects: pace.projects.join(", ") })}: ${t("quota.ceiling", { value: pace.ceiling })} · ${t("quota.headroom", { value: pace.headroom })} · ${t("quota.free", { value: pace.free })}`}
        </Text>
      ))}
      {slot.resetsAt ? <Text style={{ color: muted, fontSize: 11 }}>{t("quota.resets", { when: when(slot.resetsAt) })}</Text> : null}
      {slot.stale ? <Text style={{ color: muted, fontSize: 11 }}>{t("quota.stale")}</Text> : null}
    </View>
  );
}

function Card(props: { theme: Theme; children: React.ReactNode }) {
  const { theme } = props;
  return <View style={{ gap: 6, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, padding: 12 }}>{props.children}</View>;
}

function Section(props: { theme: Theme; title: string; children: React.ReactNode }) {
  const { theme } = props;
  return (
    <View style={{ gap: 3, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{props.title}</Text>
      {props.children}
    </View>
  );
}
