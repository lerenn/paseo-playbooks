import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { describeClosedSlots } from "../shared/closed-hours";
import { quotaLimitationRpc } from "../shared/contracts";
import type { QuotaLimitation } from "../shared/quota-limitation";
import { messages } from "./i18n";
import { BurnRatesView } from "./burn-rates";
import { formatWait, projectRows, unavailableProviders, type ProjectRow, type ProviderRow, type SlotRow, type Tone } from "./quota-rows";
import { overAllowanceColor, semanticColor } from "./semantic-colors";
import { DETAIL_MAX_WIDTH, SPACE, TEXT } from "./spacing";
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

const whenAt = (iso: string | null, locale: string) => (iso ? new Date(iso).toLocaleString(locale) : "");

/** The Burn rate limiting tab: per provider its usage windows and the pacing's numbers, the held runs and the exhausted marks. */
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
      {unavailableProviders(data).map((item) => (
        <UsageDownLine key={item.provider} theme={theme} {...item} />
      ))}
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

/** Green, violet (over the allowance: everything is on hold, no error) and grey are fixed hues (`semantic-colors`), the same in every theme; the text beside a bar carries the numbers too. */
const toneColor = (theme: Theme, tone: Tone) => (tone === "over" ? semanticColor(theme, "paused") : tone === "warn" ? semanticColor(theme, "waiting") : tone === "ok" ? semanticColor(theme, "done") : theme.colors.foregroundMuted);

/** The provider-level line of an unavailable usage reading: violet, not an error (the plugin keeps trying and holds runs by itself). Shown once per provider. */
function UsageDownLine(props: { theme: Theme; provider: string; since: string | null; reason: string | null; lastReadAt: string | null }) {
  const { theme, provider, since, reason, lastReadAt } = props;
  const { t, locale } = useTranslation(messages);
  const time = (iso: string) => new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const parts = [`${provider}: ${since ? t("quota.usageDown", { when: time(since) }) : t("quota.state.unavailable")}${reason ? t("quota.usageReason", { reason }) : ""}`, lastReadAt ? t("quota.usageLastRead", { when: time(lastReadAt) }) : null].filter((part): part is string => part !== null);
  return <Text style={{ color: semanticColor(theme, "paused"), fontSize: 12 }}>{parts.join(" · ")}</Text>;
}

function ProjectRowView(props: { theme: Theme; row: ProjectRow; first: boolean; onChanged: () => void }) {
  const { theme, row, first, onChanged } = props;
  const { t } = useTranslation(messages);
  const [open, setOpen] = useState(false);
  const muted = theme.colors.foregroundMuted;
  const caps = row.stepsLimit === null && row.runsLimit === null ? t("quota.noCaps") : [row.stepsLimit === null ? null : t("quota.stepsCap", { limit: row.stepsLimit }), row.runsLimit === null ? null : t("quota.runsCap", { limit: row.runsLimit })].filter(Boolean).join(" · ");
  const parts: Array<{ text: string; over: boolean }> = [
    { text: row.pacing ? t("quota.pacingShort", { percent: row.percents.join("/") }) : t("quota.pacingOffShort"), over: false },
    ...row.summary.map((item) => ({ over: item.status === "over", text: item.status === "over" ? (Math.round(item.over) > 0 ? t("quota.sum.overBy", { provider: item.provider, value: Math.round(item.over) }) : t("quota.sum.over", { provider: item.provider })) : item.status === "unavailable" ? t("quota.sum.unavailable", { provider: item.provider }) : item.status === "unreported" ? t("quota.sum.unreported", { provider: item.provider }) : item.free === null ? item.provider : t("quota.sum.free", { provider: item.provider, value: Math.round(item.free) }) })),
    ...(row.throttled ? [{ text: t("quota.throttledShort"), over: false }] : []),
  ];
  const [folds, setFolds] = useState<ReadonlySet<string>>(new Set());
  const toggleFold = (key: string) => setFolds((before) => { const next = new Set(before); if (!next.delete(key)) next.add(key); return next; });
  return (
    <View style={{ ...(first ? {} : { borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: SPACE.block + 2, marginTop: 2 }) }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: toneColor(theme, row.tone) }} />
          <Text style={{ flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{row.label}</Text>
          <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={muted} />
        </View>
        <Text style={{ color: row.pacing ? theme.colors.foreground : muted, ...TEXT.body }}>
          {parts.map((part, index) => (
            <Text key={index} style={part.over ? { color: semanticColor(theme, "paused") } : undefined}>{`${index > 0 ? " · " : ""}${part.text}`}</Text>
          ))}
        </Text>
        <Text style={{ color: muted, ...TEXT.small }}>{caps}</Text>
      </Pressable>
      {open ? (
        <View style={{ gap: SPACE.provider, paddingTop: SPACE.provider, marginTop: SPACE.block, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
          {row.sets.map((set) => (
            <View key={set.limits.repos.join(",")} style={{ gap: SPACE.provider }}>
              {row.sets.length > 1 ? <Text style={{ color: muted, ...TEXT.small }}>{`${t("quota.repos", { repos: set.limits.repos.join(", ") })} · ${set.limits.pacing ? t("quota.pacingOnAt", { percent: set.limits.usablePercent }) : t("quota.pacingOff")}`}</Text> : null}
              <ClosedHoursView theme={theme} set={set} />
              {set.providers.length === 0 ? <Text style={{ color: muted, fontSize: 12 }}>{t("quota.noProviders")}</Text> : null}
              {set.providers.map((provider) => (
                <ProviderView key={provider.provider} theme={theme} provider={provider} folds={folds} toggleFold={toggleFold} foldKey={set.limits.repos.join(",")} />
              ))}
            </View>
          ))}
          <BurnRatesView theme={theme} items={row.burnRates} onChanged={onChanged} />
        </View>
      ) : null}
    </View>
  );
}

/** The closed hours of a set of limits (ADR 2026-11-23-quota-closed-hours), and whether what is allowed so far is frozen now. */
function ClosedHoursView(props: { theme: Theme; set: ProjectRow["sets"][number] }) {
  const { theme, set } = props;
  const { t, locale } = useTranslation(messages);
  const closed = set.limits.pacing ? set.limits.closedHours : null;
  if (!closed) return null;
  const slots = set.providers.flatMap((provider) => provider.slots);
  const dayLabel = (day: number) => new Date(Date.UTC(2024, 0, 7 + day)).toLocaleDateString(locale, { weekday: "short", timeZone: "UTC" });
  return (
    <View style={{ gap: 4, maxWidth: DETAIL_MAX_WIDTH }}>
      <Text style={{ color: theme.colors.foregroundMuted, ...TEXT.small }}>{t("quota.closedHours", { slots: describeClosedSlots(closed.slots, dayLabel), timezone: closed.timezone })}</Text>
      {slots.some((slot) => slot.frozen) ? <Text style={{ color: semanticColor(theme, "paused"), ...TEXT.small }}>{t("quota.closedFrozen")}</Text> : null}
      {slots.some((slot) => slot.closedIgnored) ? <Text style={{ color: theme.colors.foregroundMuted, ...TEXT.small }}>{t("quota.closedIgnored")}</Text> : null}
    </View>
  );
}

function ProviderView(props: { theme: Theme; provider: ProviderRow; folds: ReadonlySet<string>; toggleFold: (key: string) => void; foldKey: string }) {
  const { theme, provider, folds, toggleFold, foldKey } = props;
  const { t, locale } = useTranslation(messages);
  const muted = theme.colors.foregroundMuted;
  const flag = provider.status === "unavailable" ? t("quota.state.unavailable") : provider.status === "unreported" ? t("quota.state.unreported") : provider.state === "override" ? t("quota.state.override") : null;
  return (
    <View style={{ gap: SPACE.window, borderLeftWidth: 2, borderLeftColor: theme.colors.border, paddingLeft: SPACE.block + 2, maxWidth: DETAIL_MAX_WIDTH + 14 }}>
      <View style={{ gap: 4 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" }}>{provider.provider}</Text>
        {flag ? <Text style={{ color: provider.status === "unavailable" ? semanticColor(theme, "paused") : muted, ...TEXT.body }}>{flag}</Text> : null}
        {provider.readAt ? <Text style={{ color: muted, ...TEXT.small }}>{t("quota.readAt", { when: whenAt(provider.readAt, locale) })}</Text> : null}
        {provider.overrideUntil ? <Text style={{ color: muted, ...TEXT.small }}>{t("quota.overrideUntil", { when: whenAt(provider.overrideUntil, locale) })}</Text> : null}
      </View>
      {provider.slots.length === 0 ? <Text style={{ color: muted, ...TEXT.body }}>{t("quota.noReading")}</Text> : null}
      {provider.slots.length > 0 ? (
        <View style={{ gap: SPACE.window }}>
          {provider.slots.map((slot) => (
            <SlotView key={slot.id} theme={theme} slot={slot} unavailable={provider.unavailable} />
          ))}
        </View>
      ) : null}
      {provider.unavailable && provider.slots.some((slot) => slot.paced) ? <Text style={{ color: semanticColor(theme, "paused"), ...TEXT.body }}>{t("quota.throttleUnknown")}</Text> : <ThrottleView theme={theme} provider={provider} />}
      {provider.reservations.length > 0 ? (
        <Lines theme={theme} title={t("quota.reservations", { count: provider.reservations.length })} open={folds.has(`${foldKey}/${provider.provider}/reservations`)} onToggle={() => toggleFold(`${foldKey}/${provider.provider}/reservations`)}>
          {provider.reservations.map((run) => (
            <View key={run.runId} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
              <Text style={{ color: theme.colors.foreground, ...TEXT.body }}>{`${run.title}${Object.keys(run.remaining).length > 0 ? ` · ${Object.entries(run.remaining).map(([name, value]) => (run.basis?.[name] ? t("quota.remainingBasis", { window: name, value, duration: formatWait(run.basis[name]!.ms), rate: run.basis[name]!.burnRate }) : t("quota.remaining", { window: name, value }))).join(", ")}` : ""}`}</Text>
              {run.exempt ? <Text style={{ color: theme.colors.accent, fontSize: 10, fontWeight: "600", borderRadius: 4, borderWidth: 1, borderColor: theme.colors.accent, paddingHorizontal: 4 }}>{t("quota.tagExempt")}</Text> : null}
              {run.hold === null ? null : <Text style={{ color: semanticColor(theme, "paused"), fontSize: 10, fontWeight: "600", borderRadius: 4, borderWidth: 1, borderColor: semanticColor(theme, "paused"), paddingHorizontal: 4 }}>{t(run.hold === "paused" ? "quota.tagPaused" : "quota.tagHeld")}</Text>}
            </View>
          ))}
        </Lines>
      ) : null}
      {provider.exhausted.length > 0 ? (
        <Lines theme={theme} title={t("quota.exhausted", { count: provider.exhausted.length })} open={folds.has(`${foldKey}/${provider.provider}/exhausted`)} onToggle={() => toggleFold(`${foldKey}/${provider.provider}/exhausted`)}>
          {provider.exhausted.map((mark) => (
            <Text key={`${mark.runId}/${mark.target}`} style={{ color: theme.colors.foreground, ...TEXT.body }}>{`${mark.target} · ${mark.title} · ${t("quota.until", { when: whenAt(mark.until, locale) })}`}</Text>
          ))}
        </Lines>
      ) : null}
    </View>
  );
}

/** The (i) button next to the throttle line: the formula shows as a tooltip on hover or keyboard focus, and a tap toggles it (same pattern as the pre-release notice). */
function ThrottleInfo(props: { theme: Theme }) {
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
        accessibilityLabel={t("quota.throttleInfoLabel")}
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
        <View style={{ position: "absolute", top: 20, left: 0, width: 260, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface2 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>{t("quota.throttleCaption")}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** The throttle line (violet, as on hold), its counts and an (i) button that shows the formula. Shown when the provider has a window with an allowed-so-far figure or something held or paused. */
function ThrottleView(props: { theme: Theme; provider: ProviderRow }) {
  const { theme, provider } = props;
  const { t, locale } = useTranslation(messages);
  const { throttle } = provider;
  const paced = provider.slots.some((slot) => slot.paced);
  if (!paced && throttle.held + throttle.paused === 0) return null;
  const muted = theme.colors.foregroundMuted;
  const violet = semanticColor(theme, "paused");
  const counts = [
    t("quota.heldCount", { count: throttle.held }),
    t("quota.pausedCount", { count: throttle.paused }),
    throttle.longestWaitMs === null ? null : t("quota.longestWait", { value: formatWait(throttle.longestWaitMs) }),
    throttle.nextRetryAt === null ? null : t("quota.nextRetry", { when: new Date(throttle.nextRetryAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) }),
  ].filter((part): part is string => part !== null);
  return (
    <View style={{ gap: SPACE.tight }}>
      {paced ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={{ color: theme.colors.foreground, ...TEXT.body }}>{throttle.percent === null ? t("quota.throttleNone") : t("quota.throttle", { value: throttle.percent })}</Text>
            <ThrottleInfo theme={theme} />
          </View>
          <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
            {throttle.percent ? <View style={{ position: "absolute", left: 0, width: `${throttle.percent}%`, height: 6, backgroundColor: violet }} /> : null}
          </View>
        </>
      ) : null}
      <Text style={{ color: throttle.held + throttle.paused > 0 ? violet : muted, ...TEXT.small }}>{counts.join(" · ")}</Text>
    </View>
  );
}

/** A usage window: name, a bar and the numbers. Paced: grey usage up to what is allowed so far, violet above it, green for what is still free, a tick at the allowed-so-far mark. Not paced: usage only. */
function SlotView(props: { theme: Theme; slot: SlotRow; unavailable: boolean }) {
  const { theme, slot, unavailable } = props;
  const { t, locale } = useTranslation(messages);
  const muted = theme.colors.foregroundMuted;
  const { bar } = slot;
  const facts = unavailable
    ? [slot.used === null ? null : t("quota.used", { value: slot.used }), slot.paced ? t("quota.headroomUnknown") : null].filter((fact): fact is string => fact !== null)
    : [
    slot.used === null ? null : t("quota.used", { value: slot.used }),
    slot.reserved > 0 ? t("quota.reserved", { value: slot.reserved }) : null,
    slot.paced ? (slot.over > 0 ? t("quota.overBy", { value: slot.over }) : t("quota.free", { value: slot.free ?? 0 })) : t("quota.notPaced"),
    slot.paced && slot.ceiling !== null ? t("quota.ceiling", { value: slot.ceiling }) : null,
  ].filter((fact): fact is string => fact !== null);
  const pct = (value: number) => `${value}%` as const;
  return (
    <View style={{ gap: SPACE.tight, ...(unavailable ? { opacity: 0.6 } : {}) }}>
      <Text style={{ color: theme.colors.foreground, ...TEXT.body, fontWeight: "600" }}>
        {slot.name}
        {slot.modelScoped ? ` · ${t("quota.modelWindow")}` : ""}
      </Text>
      <View style={{ height: 8, borderRadius: 4, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
        <View style={{ position: "absolute", left: 0, width: pct(bar.grey), height: 8, backgroundColor: theme.colors.foregroundMuted }} />
        {!unavailable && bar.green > 0 ? <View style={{ position: "absolute", left: pct(bar.greenFrom), width: pct(bar.green), height: 8, backgroundColor: semanticColor(theme, "done") }} /> : null}
        {!unavailable && bar.red > 0 ? <View style={{ position: "absolute", left: pct(bar.redFrom), width: pct(bar.red), height: 8, backgroundColor: overAllowanceColor(theme) }} /> : null}
        {!unavailable && bar.tick !== null ? <View style={{ position: "absolute", left: pct(Math.min(bar.tick, 99)), width: 2, height: 8, backgroundColor: theme.colors.foreground }} /> : null}
      </View>
      <View style={{ gap: 2 }}>
        <Text style={{ color: slot.over > 0 && !unavailable ? semanticColor(theme, "paused") : muted, ...TEXT.body }}>{facts.join(" · ")}</Text>
        {slot.resetsAt ? <Text style={{ color: muted, ...TEXT.small }}>{t("quota.resets", { when: whenAt(slot.resetsAt, locale) })}</Text> : null}
        {slot.stale ? <Text style={{ color: muted, ...TEXT.small }}>{t("quota.stale")}</Text> : null}
      </View>
    </View>
  );
}

/** A collapsible group of plain lines inside a provider: a chevron header with the title and count, closed until tapped. */
function Lines(props: { theme: Theme; title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  const muted = props.theme.colors.foregroundMuted;
  return (
    <View style={{ gap: SPACE.tight }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: props.open }} onPress={props.onToggle} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name={props.open ? "ChevronDown" : "ChevronRight"} size={14} color={muted} />
        <Text style={{ flex: 1, minWidth: 0, color: muted, ...TEXT.body }}>{props.title}</Text>
      </Pressable>
      {props.open ? props.children : null}
    </View>
  );
}

function Card(props: { theme: Theme; children: React.ReactNode }) {
  const { theme } = props;
  return <View style={{ gap: SPACE.block, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, padding: 16 }}>{props.children}</View>;
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
