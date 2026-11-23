import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { Icon, Markdown, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { addFanoutItemRpc, decideGateRpc, nudgeStepRpc, restartRunRpc, retryStepRpc, scriptOutputRpc, stepDetailRpc } from "../shared/contracts";
import { askChoices, askTransitionOf, choicesOfGate, destinationOf, gateText, linkify, waitsForHuman } from "../shared/gates";
import { withDetail } from "../shared/lean";
import { runningFor } from "../shared/elapsed";
import { useNow } from "./now";
import { conditionText } from "../shared/labels";
import { attemptTimeoutMs, isPaused, isStepLive, restartBlocker, type Gate, type GateChoice, type Playbook, type Run, type RunSummary } from "../shared/types";
import { SCRIPT_OUTPUT_POLL_MS, checkHeading, formatSeconds, lastLines, scriptActivity } from "./script-output";
import { STEP_KINDS, stepTitle, stepTitleOf, type Theme } from "./theme";
import { semanticColor } from "./semantic-colors";
import { messages } from "./i18n";
import { detailEn } from "./i18n-detail";
import { graphEn } from "./i18n-graph";
import type { Tr } from "./tr";

/** A raw status as words: a known run, gate or step status is translated, anything else (a playbook's own outcome) is shown as stored. */
export function statusText(t: Tr, status: string): string {
  if (status in detailEn.status) return t(`detail.status.${status}`);
  if (status in graphEn.state) return t(`graph.state.${status}`);
  return status.replace("_", " ");
}

export function Button(props: { theme: Theme; label: string; onPress(): void; kind?: "primary" | "danger" | "plain"; disabled?: boolean; accessibilityLabel?: string }) {
  const { theme, kind = "plain" } = props;
  const background = kind === "primary" ? theme.colors.accent : kind === "danger" ? theme.colors.statusDanger : theme.colors.surface2;
  const foreground = kind === "plain" ? theme.colors.foreground : theme.colors.accentForeground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: background, opacity: props.disabled ? 0.5 : 1 }}
    >
      <Text style={{ color: foreground, fontSize: 13, fontWeight: "600" }}>{props.label}</Text>
    </Pressable>
  );
}


/** A collapsible section of the step sheet, closed by default. */
export function Section(props: { theme: Theme; title: string; children: ReactNode; defaultOpen?: boolean }) {
  const { theme } = props;
  const { t } = useTranslation(messages);
  const [open, setOpen] = useState(props.defaultOpen === true);
  return (
    <View style={{ borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, overflow: "hidden" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={t(open ? "detail.sheet.collapseSection" : "detail.sheet.expandSection", { title: props.title })}
        onPress={() => setOpen((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: theme.colors.surface2 }}
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={theme.colors.foregroundMuted} />
        <Text style={{ flex: 1, color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600", textTransform: "uppercase" }}>{props.title}</Text>
      </Pressable>
      {open ? <View style={{ gap: 4, paddingHorizontal: 10, paddingVertical: 8 }}>{props.children}</View> : null}
    </View>
  );
}

function Line(props: { theme: Theme; children: ReactNode; muted?: boolean }) {
  return (
    <Text selectable style={{ color: props.muted ? props.theme.colors.foregroundMuted : props.theme.colors.foreground, fontSize: 13 }}>
      {props.children}
    </Text>
  );
}

/** Button colours of a gate choice, from the Paseo theme: buttons follow the theme. */
function choiceColors(theme: Theme, color: NonNullable<GateChoice["color"]>): { background: string; foreground: string } {
  switch (color) {
    case "primary":
      return { background: theme.colors.accent, foreground: theme.colors.accentForeground };
    case "danger":
      return { background: theme.colors.statusDanger, foreground: theme.colors.accentForeground };
    case "success":
      return { background: theme.colors.statusSuccess, foreground: theme.colors.accentForeground };
    case "warning":
      return { background: theme.colors.statusWarning, foreground: theme.colors.accentForeground };
    default:
      return { background: theme.colors.surface2, foreground: theme.colors.foreground };
  }
}

/** Where a choice leads, for its button (shown after an arrow): "End", "End Release" (inside a block), "Write", "Fail run". */
function destinationLabel(t: Tr, run: Pick<RunSummary, "playbook">, gate: Gate, choiceId: string): string {
  const d = (key: string, options?: Record<string, string>) => t(`detail.sheet.dest.${key}`, options);
  const step = run.playbook.steps.find((candidate) => candidate.id === gate.stepId);
  let outcome = choiceId;
  if (gate.kind === "permission") return choiceId === "allow" ? d("agentGoesOn") : d("agentOtherWay");
  if (gate.kind === "manager_question") return d("managerGoesOn");
  if (gate.kind === "admission") return choiceId === "admit" ? d("joinsBatch") : choiceId === "withdraw" ? d("leavesPipeline") : d("checksAgain");
  if (gate.kind === "ask") {
    const ask = askTransitionOf(gate, step);
    const choice = ask ? askChoices(ask).find((candidate) => candidate.id === choiceId) : undefined;
    // A choice with `outcome` leads where that outcome does; the others go back to a step.
    if (choice?.outcome === undefined) return stepTitleOf(run.playbook, choice?.target ?? gate.gotoTarget ?? "");
    outcome = choice.outcome;
  }
  if (gate.kind === "loop_limit") return choiceId === "approved" ? stepTitleOf(run.playbook, gate.gotoTarget ?? "") : d("failRun");
  if (!step) return "";
  const destination = destinationOf(run.playbook, step, outcome);
  if (destination.kind === "end") return d("end");
  if (destination.kind === "end_block") return d("endBlock", { title: run.playbook.blocks[destination.targets[0]!]?.title ?? destination.targets[0]! });
  if (destination.kind === "fail") return d("failRun");
  return destination.targets.map((target) => stepTitleOf(run.playbook, target)).join(", ");
}

/** A pending gate: its summary, collapsed details, and one full-width button per choice. Choices that take a comment open a text box with Send. */
export function GateActions(props: { theme: Theme; run: Pick<RunSummary, "id" | "playbook">; gate: Gate; hostLabel: string; onDecided?: () => void }) {
  const { theme, run, gate } = props;
  const { t } = useTranslation(messages);
  const decide = useRpc(decideGateRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const text = gateText(gate);
  const step = run.playbook.steps.find((candidate) => candidate.id === gate.stepId);
  const choices = choicesOfGate(gate, step);
  const submit = async (choice: GateChoice, withComment: string) => {
    setBusy(true);
    try {
      const result = await decide({ runId: run.id, gateId: gate.id, decision: choice.id, comment: withComment, hostLabel: props.hostLabel });
      toast.show(result.alreadyDecided ? t("detail.sheet.alreadyDecided", { decision: result.decision }) : t("detail.sheet.sentChoice", { label: choice.label }), { variant: "success" });
      setOpen(null);
      setComment("");
      props.onDecided?.();
      await queryClient.invalidateQueries({ queryKey: ["playbooks"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 6 }}>
      <Markdown>{linkify(text.summary)}</Markdown>
      {text.details ? (
        <Section theme={theme} title={t("detail.sheet.details")}>
          <Markdown>{linkify(text.details)}</Markdown>
        </Section>
      ) : null}
      {choices.map((choice, index) => {
        const destination = destinationLabel(t, run, gate, choice.id);
        const expanded = open === choice.id;
        const tone = choice.color ?? (index === 0 ? "primary" : "neutral");
        const { background, foreground } = choiceColors(theme, tone);
        /** Outline, side bar and focus colour of an open choice: its own colour (neutral has no strong one). */
        const ring = tone === "neutral" ? theme.colors.foregroundMuted : background;
        return (
          <View key={choice.id} style={{ gap: 6 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={destination ? t(choice.comment !== "none" ? "detail.sheet.choiceGoesComment" : "detail.sheet.choiceGoes", { label: choice.label, destination }) : choice.comment !== "none" ? t("detail.sheet.choiceComment", { label: choice.label }) : choice.label}
              accessibilityState={{ disabled: busy, expanded: choice.comment !== "none" ? expanded : undefined }}
              disabled={busy}
              onPress={() => {
                if (choice.comment === "none") void submit(choice, "");
                else {
                  setOpen(expanded ? null : choice.id);
                  setComment("");
                }
              }}
              style={{
                width: "100%",
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                borderRadius: 8,
                paddingHorizontal: 12,
                paddingVertical: 9,
                backgroundColor: background,
                borderWidth: 1,
                borderColor: expanded ? ring : "transparent",
                opacity: busy ? 0.6 : 1,
              }}
            >
              <Text style={{ flex: 1, color: foreground, fontSize: 13, fontWeight: "600" }}>{choice.label}</Text>
              <Text style={{ color: foreground, opacity: 0.75, fontSize: 12 }}>{destination ? `→ ${destination}` : ""}</Text>
              {choice.comment !== "none" ? <Icon name={expanded ? "ChevronUp" : "MessageSquare"} size={13} color={foreground} /> : null}
            </Pressable>
            {expanded ? (
              <View style={{ gap: 6, paddingLeft: 8, borderLeftWidth: 2, borderLeftColor: ring }}>
                <TextInput
                  accessibilityLabel={t("detail.sheet.commentFor", { label: choice.label })}
                  placeholder={t(choice.comment === "required" ? "detail.sheet.commentRequired" : "detail.sheet.commentOptional")}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  value={comment}
                  onChangeText={setComment}
                  multiline
                  autoFocus
                  style={{ minHeight: 64, borderRadius: 8, borderWidth: 1, borderColor: ring, padding: 8, color: theme.colors.foreground, backgroundColor: theme.colors.surface2 }}
                />
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("detail.sheet.sendChoice", { label: choice.label })}
                    accessibilityState={{ disabled: busy || (choice.comment === "required" && !comment.trim()) }}
                    disabled={busy || (choice.comment === "required" && !comment.trim())}
                    onPress={() => void submit(choice, comment)}
                    style={{
                      borderRadius: 8,
                      paddingHorizontal: 12,
                      paddingVertical: 7,
                      backgroundColor: background,
                      opacity: busy || (choice.comment === "required" && !comment.trim()) ? 0.5 : 1,
                    }}
                  >
                    <Text style={{ color: foreground, fontSize: 13, fontWeight: "600" }}>{busy ? t("detail.sheet.sending") : t("detail.sheet.send")}</Text>
                  </Pressable>
                  <Button theme={theme} label={t("common.cancel")} onPress={() => setOpen(null)} />
                </View>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/** "Restart from here" on a finished run: the step and what follows run again, with the same manager (or a new one if it was archived). */
function RestartRun(props: { theme: Theme; run: Run; stepId: string; hostLabel: string; onDone(): void }) {
  const { theme, run, stepId } = props;
  const { t } = useTranslation(messages);
  const restart = useRpc(restartRunRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const ran = Object.entries(run.after).filter(([, task]) => task.status === "completed" || task.status === "failed").map(([id]) => id);
  return (
    <View style={{ gap: 8 }}>
      <Line theme={theme} muted>
        {t("detail.sheet.restart.reopens", { status: statusText(t, run.status), step: stepTitleOf(run.playbook, stepId) })}
      </Line>
      {ran.length > 0 ? (
        <Line theme={theme}>
          {t("detail.sheet.restart.afterRan", { list: ran.join(", ") })}
        </Line>
      ) : null}
      <TextInput
        accessibilityLabel={t("detail.sheet.restart.noteLabel")}
        placeholder={t("detail.sheet.restart.notePlaceholder")}
        placeholderTextColor={theme.colors.foregroundMuted}
        value={comment}
        onChangeText={setComment}
        multiline
        style={{ minHeight: 36, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, padding: 8, color: theme.colors.foreground, backgroundColor: theme.colors.surface2 }}
      />
      <View style={{ flexDirection: "row" }}>
        <Button
          theme={theme}
          kind="primary"
          label={busy ? t("detail.sheet.restart.restarting") : t("detail.sheet.restart.button")}
          disabled={busy}
          onPress={() => {
            setBusy(true);
            void restart({ runId: run.id, stepId, hostLabel: props.hostLabel, ...(comment.trim() ? { comment } : {}) })
              .then(async () => {
                await queryClient.invalidateQueries({ queryKey: ["playbooks"] });
                toast.show(t("detail.sheet.restart.done"), { variant: "success" });
                props.onDone();
              })
              .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
              .finally(() => setBusy(false));
          }}
        />
      </View>
    </View>
  );
}

/** A script step's live output: running now or waiting for the next check, the running check's tail, and the last checks. */
function ScriptLive(props: { theme: Theme; run: Run; stepId: string; latest: Run["steps"][string]["attempts"][number] | undefined }) {
  const { theme, run, stepId, latest } = props;
  const { t, locale } = useTranslation(messages);
  const fetchOutput = useRpc(scriptOutputRpc);
  const stepRunning = run.steps[stepId]?.status === "running";
  const query = useQuery({
    queryKey: ["playbooks", "script-output", run.id, stepId, latest?.n ?? 0],
    queryFn: () => fetchOutput({ runId: run.id, stepId }),
    enabled: latest !== undefined,
    refetchInterval: stepRunning ? SCRIPT_OUTPUT_POLL_MS : false,
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!stepRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [stepRunning]);
  if (!latest) return null;
  const output = query.data;
  const activity = scriptActivity(output, latest.nextCheckAt, stepRunning, now, t);
  const checks = output?.checks ?? [];
  const tail = output?.running ? output.tail : "";
  // Nothing in memory (the daemon restarted, or the attempt ended): the last check's tail the run recorded.
  const fallback = checks.length === 0 && !tail ? latest.lastMessage : null;
  const color = activity.kind === "running" ? semanticColor(theme, "done") : theme.colors.foregroundMuted;
  return (
    <View style={{ gap: 6 }}>
      {activity.kind !== "idle" ? (
        <Text accessibilityRole="text" accessibilityLabel={t("detail.sheet.scriptActivity", { text: activity.text })} style={{ color, fontSize: 13, fontWeight: "600" }}>
          {activity.kind === "running" ? "● " : "○ "}
          {activity.text}
        </Text>
      ) : null}
      {activity.kind === "running" ? (
        <Section theme={theme} title={t("detail.sheet.liveOutput")} defaultOpen>
          <Line theme={theme} muted>
            {tail ? lastLines(tail, 40) : t("detail.sheet.noOutputYet")}
          </Line>
        </Section>
      ) : null}
      {[...checks].reverse().map((check) => (
        <Section key={check.n} theme={theme} title={checkHeading(check, t, locale)} defaultOpen={check === checks.at(-1) && activity.kind !== "running"}>
          <Line theme={theme} muted>
            {check.tail ? lastLines(check.tail, 40) : t("detail.sheet.noOutput")}
          </Line>
        </Section>
      ))}
      {fallback ? (
        <Section theme={theme} title={latest.report ? t("detail.sheet.output") : t("detail.sheet.outputLast")} defaultOpen>
          <Line theme={theme} muted>
            {fallback}
          </Line>
        </Section>
      ) : null}
    </View>
  );
}

export function StepSheet(props: {
  theme: Theme;
  playbook: Playbook;
  run: Run | null;
  stepId: string;
  hostLabel: string;
  onClose(): void;
  onOpenAgent(agentId: string): void;
}) {
  const { theme, playbook, run, stepId } = props;
  const { t, locale } = useTranslation(messages);
  const kindName = (kind: keyof typeof STEP_KINDS) => t(`graph.kind.${kind}`);
  // The list is lean (ADR 2026-11-13-lean-list-runs): what it lacks (attempt prompts and reports, the step's prompt, the role's instructions) comes with the sheet. Until then the sheet shows what the list has.
  const fetchDetail = useRpc(stepDetailRpc);
  const detail = useQuery({
    queryKey: ["playbooks", "step-detail", run?.id, stepId, run?.seq],
    queryFn: () => fetchDetail({ runId: run!.id, stepId }),
    enabled: !!run,
    placeholderData: keepPreviousData,
  }).data;
  const leanStep = playbook.steps.find((candidate) => candidate.id === stepId)!;
  const step = detail?.step ? { ...leanStep, prompt: detail.step.prompt } : leanStep;
  const leanRole = step.role ? playbook.roles[step.role] : undefined;
  const role = leanRole && detail?.role ? { ...leanRole, instructions: detail.role.instructions } : leanRole;
  const leanState = run?.steps[stepId];
  const state = leanState ? withDetail(leanState, detail?.state) : leanState;
  const now = useNow();
  const attempts = state?.attempts ?? [];
  const latest = attempts.at(-1);
  const pendingGate = run?.gates.find((gate) => gate.stepId === stepId && gate.status === "pending");
  const decidedGates = run?.gates.filter((gate) => gate.stepId === stepId && gate.status !== "pending") ?? [];
  const nudge = useRpc(nudgeStepRpc);
  const retry = useRpc(retryStepRpc);
  const addItem = useRpc(addFanoutItemRpc);
  const [newItem, setNewItem] = useState("");
  const toast = useToast();
  const [message, setMessage] = useState("");
  const active = run !== null && isStepLive(run, stepId);
  // A script step has no agent to talk to.
  const canNudge = active && step.kind !== "script" && step.kind !== "handoff" && step.kind !== "fanout" && (state?.status === "running" || state?.status === "reported");
  const canRestart = run !== null && restartBlocker(run, stepId) === null;
  // Retry goes through the manager, which a paused run does not wake (a run with no manager has none to ask: restart it from the step).
  const canRetry = active && !isPaused(run) && run.playbook.managerMode !== "none" && state?.status === "reported" && (latest?.report?.outcome === "failure" || latest?.report === null);

  // The latest attempt's timeout (a templated one resolved at its start), else the step's.
  const timeoutMs = latest ? attemptTimeoutMs(step, latest) : step.timeout ? undefined : step.timeoutMs;
  const timeoutText = timeoutMs ? ` · ${t("detail.sheet.timeoutMin", { minutes: Math.round(timeoutMs / 60000) })}` : step.timeout ? ` · ${t("detail.sheet.timeoutValue", { value: step.timeout })}` : "";
  const retriesText = step.retries ? ` · ${t("detail.sheet.retries", { count: step.retries })}` : "";

  return (
    <Modal title={`${stepTitle(step)}${role ? ` · ${role.title}` : step.kind === "agent" ? "" : ` · ${kindName(step.kind)}`}`} open onOpenChange={(open) => !open && props.onClose()}>
      <Modal.Content>
        <View accessible accessibilityLabel={t("detail.sheet.kindStep", { kind: kindName(step.kind) })} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon name={STEP_KINDS[step.kind].icon} size={14} color={theme.colors.foregroundMuted} />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{kindName(step.kind)}</Text>
        </View>
        {step.description ? (
          <Text selectable accessibilityLabel={t("detail.sheet.aboutStep", { description: step.description })} style={{ color: theme.colors.foreground, fontSize: 13 }}>
            {step.description}
          </Text>
        ) : null}
        {state ? <Line theme={theme}>{t("detail.sheet.status", { status: statusText(t, state.status) })}{latest ? ` · ${t("detail.sheet.attempt", { n: latest.n })}` : ""}{latest?.waiting && state.status === "running" ? ` · ${t("detail.sheet.waitingTokens", { when: new Date(latest.waiting.until).toLocaleString(locale) })}` : ""}{state.status === "running" && !pendingGate ? ` · ${t("detail.sheet.runningFor", { elapsed: runningFor(latest?.startedAt, now) ?? "—" })}` : ""}</Line> : null}
        {step.kind === "agent" ? (
          <Section theme={theme} title={kindName("agent")}>
            <Line theme={theme} muted>
              {[step.agent.provider, step.agent.model, step.agent.mode, step.agent.thinking].filter(Boolean).join(" · ") || t("detail.sheet.managerProvider")}
              {timeoutText}
              {retriesText}
            </Line>
          </Section>
        ) : null}
        {step.kind === "script" ? (
          <Section theme={theme} title={kindName("script")}>
            <Line theme={theme} muted>
              {step.script}
              {step.pollMs ? ` · ${t("detail.sheet.everyUntilDone", { interval: formatSeconds(step.pollMs / 1000, t) })}` : ` · ${t("detail.sheet.runsOnce")}`}
              {timeoutText}
              {retriesText}
            </Line>
            {latest ? (
              <Line theme={theme} muted>
                {t("detail.sheet.checks", { count: latest.checks })}{latest.nextCheckAt && state?.status === "running" ? ` · ${t("detail.sheet.nextAt", { when: new Date(latest.nextCheckAt).toLocaleTimeString(locale) })}` : ""}
              </Line>
            ) : null}
          </Section>
        ) : null}
        {step.kind === "handoff" ? (
          <Section theme={theme} title={kindName("handoff")}>
            <Line theme={theme} muted>
              {t("detail.sheet.handoffGives", { playbook: step.handoff ?? "" })}
              {timeoutText}
              {retriesText}
            </Line>
            {latest?.job ? (
              <Line theme={theme} muted>
                {t("detail.sheet.handoffDone", { playbook: step.handoff ?? "", job: latest.job.jobId, run: latest.job.runId })}
              </Line>
            ) : null}
            {latest?.lastMessage && !latest.report ? <Line theme={theme}>{latest.lastMessage}</Line> : null}
          </Section>
        ) : null}
        {step.kind === "fanout" && step.fanout ? (
          <Section theme={theme} title={kindName("fanout")}>
            <Line theme={theme} muted>
              {t("detail.sheet.fanout.summary", { playbook: step.fanout.playbook, max: step.fanout.maxActive })}
              {` · ${t(step.fanout.cancelChildren ? "detail.sheet.fanout.canceledWith" : "detail.sheet.fanout.keptRunning")}`}
              {step.fanout.pool ? ` · ${t("detail.sheet.fanout.pool", { playbook: step.fanout.pool.playbook, max: step.fanout.pool.maxRefills })}` : ""}
              {timeoutText}
            </Line>
            {state?.fanout?.pool ? (
              <>
                <Line theme={theme}>
                  {t("detail.sheet.fanout.poolLine", { refills: state.fanout.pool.refills, count: state.fanout.pool.added, state: state.fanout.pool.status === "stopped" ? t("detail.sheet.fanout.stopped", { reason: state.fanout.pool.stopReason ?? "" }) : t("detail.sheet.fanout.open") })}
                </Line>
                {state.fanout.pool.passes.map((pass) => (
                  <Line key={pass.n} theme={theme} muted>
                    {t("detail.sheet.fanout.pass", { n: pass.n, status: statusText(t, pass.status) })}
                    {pass.runId ? ` · ${pass.runId}` : ""} · {t("detail.sheet.fanout.given", { count: pass.keys.length })}
                    {pass.status === "completed" ? ` · ${pass.added.length ? t("detail.sheet.fanout.added", { list: pass.added.join(", ") }) : t("detail.sheet.fanout.addedNothing")}${pass.skipped ? ` (${t("detail.sheet.fanout.skipped", { count: pass.skipped })})` : ""}` : ""}
                    {pass.error ? ` · ${pass.error}` : ""}
                  </Line>
                ))}
              </>
            ) : null}
            {state?.fanout ? (
              <>
                <Line theme={theme}>
                  {t("detail.sheet.fanout.passN", { n: state.fanout.loop + 1, done: state.fanout.children.filter((child) => ["completed", "failed", "canceled", "not_started"].includes(child.status)).length, total: state.fanout.children.length })}
                  {state.fanoutPast.length ? ` · ${t("detail.sheet.fanout.earlier", { count: state.fanoutPast.length })}` : ""}
                </Line>
                {state.fanout.children.map((child) => (
                  <Line key={child.key} theme={theme} muted>
                    {child.key} · {statusText(t, child.status)}
                    {child.runId ? ` · ${child.runId}` : ""}
                    {child.error ? ` · ${child.error}` : ""}
                    {child.previous.length ? ` · ${t("detail.sheet.fanout.restarted", { count: child.previous.length, list: child.previous.map((entry) => `${entry.runId} ${statusText(t, entry.status)}`).join(", ") })}` : ""}
                  </Line>
                ))}
              </>
            ) : null}
            {active && state?.status === "running" && state.fanout ? (
              <>
                <TextInput
                  accessibilityLabel={t("detail.sheet.fanout.itemLabel")}
                  placeholder={step.fanout.key ? t("detail.sheet.fanout.itemKeyPlaceholder") : t("detail.sheet.fanout.itemPlaceholder")}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  value={newItem}
                  onChangeText={setNewItem}
                  style={{ minHeight: 36, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, padding: 8, color: theme.colors.foreground, backgroundColor: theme.colors.surface2 }}
                />
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Button
                    theme={theme}
                    label={t("detail.sheet.fanout.addItem")}
                    disabled={!newItem.trim()}
                    onPress={() => {
                      const text = newItem.trim();
                      let item: string | Record<string, string | number | boolean> = text;
                      if (text.startsWith("{")) {
                        try {
                          item = JSON.parse(text) as Record<string, string | number | boolean>;
                        } catch {
                          toast.error(t("detail.sheet.fanout.badJson"));
                          return;
                        }
                      }
                      void addItem({ runId: run!.id, stepId, item })
                        .then((added) => {
                          setNewItem("");
                          toast.show(t("detail.sheet.fanout.itemAdded", { key: added.key }), { variant: "success" });
                        })
                        .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
                    }}
                  />
                </View>
              </>
            ) : null}
          </Section>
        ) : null}
        {step.when?.length ? (
          <Section theme={theme} title={t("detail.sheet.runsOnlyWhen")}>
            {step.when.map((when) => (
              <Line key={when.input} theme={theme} muted>
                {conditionText(when)}
              </Line>
            ))}
          </Section>
        ) : null}
        {state?.status === "skipped" ? (
          <Line theme={theme} muted>
            {t("detail.sheet.skipped", { detail: run?.history.findLast((event) => event.type === "step_skipped" && event.stepId === stepId)?.detail ?? t("detail.sheet.notReached") })}
          </Line>
        ) : null}
        {step.branch ? (
          <Section theme={theme} title={t("detail.sheet.branchTitle")}>
            {step.branch.cases.map((candidate) => (
              <Line key={candidate.name} theme={theme} muted={state?.branch !== candidate.name}>
                {state?.branch === candidate.name ? "▶ " : ""}
                {candidate.name}: {candidate.when ? t("detail.sheet.ifConditions", { conditions: candidate.when.map(conditionText).join(t("detail.sheet.and")) }) : t("detail.sheet.else")}
              </Line>
            ))}
          </Section>
        ) : null}
        {Object.keys(step.inputs).length > 0 ? (
          <Section theme={theme} title={t("detail.sheet.inputs")}>
            {Object.entries(step.inputs).map(([name, wiring]) => {
              const received = latest?.inputs[name];
              return (
                <Line key={name} theme={theme}>
                  {name} ← {wiring.label}
                  {wiring.auto ? ` ${t("detail.sheet.auto")}` : ""}
                  {received ? `: ${received.value.length > 300 ? `${received.value.slice(0, 300)}…` : received.value}` : ""}
                </Line>
              );
            })}
          </Section>
        ) : null}
        {latest?.brief ? (
          <Section theme={theme} title={t("detail.sheet.brief")}>
            <Line theme={theme}>{latest.brief}</Line>
          </Section>
        ) : null}
        {latest?.report ? (
          <Section theme={theme} title={t("detail.sheet.report", { outcome: latest.report.outcome })}>
            <Line theme={theme}>{latest.report.summary}</Line>
            {Object.entries(latest.report.outputs).map(([name, value]) => (
              <Line key={name} theme={theme} muted>
                {name}: {String(value)}
              </Line>
            ))}
          </Section>
        ) : null}
        {step.kind === "script" && run ? (
          <ScriptLive theme={theme} run={run} stepId={stepId} latest={latest} />
        ) : step.kind !== "handoff" && !latest?.report && latest?.lastMessage ? (
          <Section theme={theme} title={t("detail.sheet.endedNoReport")}>
            <Line theme={theme}>{latest.lastMessage}</Line>
          </Section>
        ) : null}
        {pendingGate && run ? (
          <Section theme={theme} title={t("detail.sheet.decision")}>
            {!waitsForHuman(pendingGate) ? (
              <Line theme={theme} muted>
                {t("detail.sheet.advisor", { role: pendingGate.decider.role ?? "" })}
              </Line>
            ) : pendingGate.chatAgentId ? (
              <Line theme={theme} muted>
                {t("detail.sheet.alsoAsked")}
              </Line>
            ) : pendingGate.decider?.by === "manager" && pendingGate.escalated === null ? (
              <Line theme={theme} muted>
                {t("detail.sheet.managerMay")}
              </Line>
            ) : null}
            {waitsForHuman(pendingGate) ? <GateActions theme={theme} run={run} gate={pendingGate} hostLabel={props.hostLabel} /> : null}
          </Section>
        ) : step.kind === "gate" && step.gate ? (
          <Section theme={theme} title={t("detail.sheet.gate")}>
            <Line theme={theme}>{step.gate}</Line>
          </Section>
        ) : null}
        {decidedGates.map((gate) => (
          <Line key={gate.id} theme={theme} muted>
            {gate.decidedVia === "role"
              ? t("detail.sheet.byRole", { status: gate.status, who: gate.decidedBy ?? "?" })
              : gate.decidedVia === "manager"
                ? t("detail.sheet.byManager", { status: gate.status })
                : gate.decidedBy
                  ? t("detail.sheet.viaBy", { status: gate.status, via: gate.decidedVia ?? "?", who: gate.decidedBy })
                  : t("detail.sheet.via", { status: gate.status, via: gate.decidedVia ?? "?" })}
            {gate.comment ? `: ${gate.comment}` : ""}
          </Line>
        ))}
        {attempts.length > 0 ? (
          <Section theme={theme} title={t("detail.sheet.attempts")}>
            {step.kind === "script" || step.kind === "handoff"
              ? attempts.map((attempt) => (
                  <Line key={attempt.n} theme={theme} muted>
                    {t("detail.sheet.attemptOutcome", { n: attempt.n, outcome: attempt.outcome ?? attempt.report?.outcome ?? attempt.turnEnd ?? t("graph.state.running") })}
                    {step.kind === "script" ? ` · ${t("detail.sheet.checks", { count: attempt.checks })}` : attempt.job ? ` · ${t("detail.sheet.jobId", { job: attempt.job.jobId })}` : ""}
                  </Line>
                ))
              : attempts.map((attempt) => (
                  <Pressable
                    key={attempt.n}
                    accessibilityRole="button"
                    accessibilityLabel={t("detail.sheet.openConversationLabel", { n: attempt.n })}
                    onPress={() => props.onOpenAgent(attempt.agentId)}
                  >
                    <Text style={{ color: theme.colors.accent, fontSize: 13 }}>
                      {t("detail.sheet.attemptOutcome", { n: attempt.n, outcome: attempt.outcome ?? attempt.report?.outcome ?? attempt.turnEnd ?? t("graph.state.running") })} · {t("detail.sheet.openConversation")}
                    </Text>
                  </Pressable>
                ))}
          </Section>
        ) : null}
        {canNudge ? (
          <Section theme={theme} title={t("detail.sheet.nudge")}>
            <TextInput
              accessibilityLabel={t("detail.sheet.nudgeLabel")}
              placeholder={t("detail.sheet.nudgePlaceholder")}
              placeholderTextColor={theme.colors.foregroundMuted}
              value={message}
              onChangeText={setMessage}
              multiline
              style={{ minHeight: 36, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, padding: 8, color: theme.colors.foreground, backgroundColor: theme.colors.surface2 }}
            />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button
                theme={theme}
                label={t("detail.sheet.send")}
                disabled={!message.trim()}
                onPress={() =>
                  void nudge({ runId: run!.id, stepId, message })
                    .then(() => {
                      setMessage("");
                      toast.show(t("detail.sheet.nudgeSent"), { variant: "success" });
                    })
                    .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
                }
              />
              {canRetry ? (
                <Button
                  theme={theme}
                  label={t("detail.sheet.askRetry")}
                  onPress={() =>
                    void retry({ runId: run!.id, stepId })
                      .then(() => toast.show(t("detail.sheet.askedManager"), { variant: "success" }))
                      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
                  }
                />
              ) : null}
            </View>
          </Section>
        ) : null}
        {canRestart ? (
          <Section theme={theme} title={t("detail.sheet.restart.button")}>
            <RestartRun theme={theme} run={run!} stepId={stepId} hostLabel={props.hostLabel} onDone={props.onClose} />
          </Section>
        ) : null}
        {role?.instructions ? (
          <Section theme={theme} title={t(role.readonly ? "detail.sheet.roleInstructionsRo" : "detail.sheet.roleInstructions")}>
            <Markdown>{role.instructions}</Markdown>
          </Section>
        ) : null}
        {step.prompt ? (
          <Section theme={theme} title={t("detail.sheet.promptTemplate")}>
            <Line theme={theme} muted>
              {step.prompt}
            </Line>
          </Section>
        ) : null}
      </Modal.Content>
    </Modal>
  );
}
