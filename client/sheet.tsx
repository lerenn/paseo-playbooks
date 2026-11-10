import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Markdown, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { decideGateRpc, nudgeStepRpc, restartRunRpc, retryStepRpc } from "../shared/contracts";
import { askChoices, askTransitionOf, choicesOfGate, destinationOf, gateText, linkify } from "../shared/gates";
import { conditionText } from "../shared/labels";
import { attemptTimeoutMs, isPaused, isStepLive, restartBlocker, type Gate, type GateChoice, type Playbook, type Run, type RunSummary } from "../shared/types";
import { stepTitle, stepTitleOf, type Theme } from "./theme";

/** A poll interval as people say it: 30 s, 1 min, 2 h. */
function formatInterval(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${Math.round(ms / 1000)} s`;
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
export function Section(props: { theme: Theme; title: string; children: ReactNode }) {
  const { theme } = props;
  const [open, setOpen] = useState(false);
  return (
    <View style={{ borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, overflow: "hidden" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${open ? "Collapse" : "Expand"} ${props.title}`}
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

/** Button colours of a gate choice, from the Paseo theme. */
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

/** Where a choice leads, for its button: "→ End", "→ End Release" (inside a block), "→ Write", "→ Fail run". */
function destinationLabel(run: Pick<RunSummary, "playbook">, gate: Gate, choiceId: string): string {
  const step = run.playbook.steps.find((candidate) => candidate.id === gate.stepId);
  let outcome = choiceId;
  if (gate.kind === "ask") {
    const ask = askTransitionOf(gate, step);
    const choice = ask ? askChoices(ask).find((candidate) => candidate.id === choiceId) : undefined;
    // A choice with `outcome` leads where that outcome does; the others go back to a step.
    if (choice?.outcome === undefined) return `→ ${stepTitleOf(run.playbook, choice?.target ?? gate.gotoTarget ?? "")}`;
    outcome = choice.outcome;
  }
  if (gate.kind === "loop_limit") return choiceId === "approved" ? `→ ${stepTitleOf(run.playbook, gate.gotoTarget ?? "")}` : "→ Fail run";
  if (!step) return "";
  const destination = destinationOf(run.playbook, step, outcome);
  if (destination.kind === "end") return "→ End";
  if (destination.kind === "end_block") return `→ End ${run.playbook.blocks[destination.targets[0]!]?.title ?? destination.targets[0]}`;
  if (destination.kind === "fail") return "→ Fail run";
  return `→ ${destination.targets.map((target) => stepTitleOf(run.playbook, target)).join(", ")}`;
}

/** A pending gate: its summary, collapsed details, and one full-width button per choice. Choices that take a comment open a text box with Send. */
export function GateActions(props: { theme: Theme; run: Pick<RunSummary, "id" | "playbook">; gate: Gate; hostLabel: string; onDecided?: () => void }) {
  const { theme, run, gate } = props;
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
      toast.show(result.alreadyDecided ? `Already decided: ${result.decision}` : `${choice.label}: sent`, { variant: "success" });
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
        <Section theme={theme} title="Details">
          <Markdown>{linkify(text.details)}</Markdown>
        </Section>
      ) : null}
      {choices.map((choice, index) => {
        const destination = destinationLabel(run, gate, choice.id);
        const expanded = open === choice.id;
        const tone = choice.color ?? (index === 0 ? "primary" : "neutral");
        const { background, foreground } = choiceColors(theme, tone);
        /** Outline, side bar and focus colour of an open choice: its own colour (neutral has no strong one). */
        const ring = tone === "neutral" ? theme.colors.foregroundMuted : background;
        return (
          <View key={choice.id} style={{ gap: 6 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${choice.label}, ${destination.replace("→", "goes to")}${choice.comment !== "none" ? ", asks for a comment" : ""}`}
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
              <Text style={{ color: foreground, opacity: 0.75, fontSize: 12 }}>{destination}</Text>
              {choice.comment !== "none" ? <Icon name={expanded ? "ChevronUp" : "MessageSquare"} size={13} color={foreground} /> : null}
            </Pressable>
            {expanded ? (
              <View style={{ gap: 6, paddingLeft: 8, borderLeftWidth: 2, borderLeftColor: ring }}>
                <TextInput
                  accessibilityLabel={`Comment for ${choice.label}`}
                  placeholder={choice.comment === "required" ? "Comment (required)" : "Comment (optional)"}
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
                    accessibilityLabel={`Send ${choice.label}`}
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
                    <Text style={{ color: foreground, fontSize: 13, fontWeight: "600" }}>{busy ? "Sending…" : "Send"}</Text>
                  </Pressable>
                  <Button theme={theme} label="Cancel" onPress={() => setOpen(null)} />
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
  const restart = useRpc(restartRunRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const ran = Object.entries(run.after).filter(([, task]) => task.status === "completed" || task.status === "failed").map(([id]) => id);
  return (
    <View style={{ gap: 8 }}>
      <Line theme={theme} muted>
        Reopens this {run.status} run: "{stepTitleOf(run.playbook, stepId)}" and every step after it run again, with the same manager (a new one if it was archived). Completed steps before it keep their outputs.
      </Line>
      {ran.length > 0 ? (
        <Line theme={theme}>
          ⚠ After-tasks already ran ({ran.join(", ")}). They run again when the restarted run ends.
        </Line>
      ) : null}
      <TextInput
        accessibilityLabel="Note for the restarted step (optional)"
        placeholder="Note for the step (optional)"
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
          label={busy ? "Restarting…" : "Restart run from here"}
          disabled={busy}
          onPress={() => {
            setBusy(true);
            void restart({ runId: run.id, stepId, hostLabel: props.hostLabel, ...(comment.trim() ? { comment } : {}) })
              .then(async () => {
                await queryClient.invalidateQueries({ queryKey: ["playbooks"] });
                toast.show("Run restarted", { variant: "success" });
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
  const step = playbook.steps.find((candidate) => candidate.id === stepId)!;
  const role = step.role ? playbook.roles[step.role] : undefined;
  const state = run?.steps[stepId];
  const attempts = state?.attempts ?? [];
  const latest = attempts.at(-1);
  const pendingGate = run?.gates.find((gate) => gate.stepId === stepId && gate.status === "pending");
  const decidedGates = run?.gates.filter((gate) => gate.stepId === stepId && gate.status !== "pending") ?? [];
  const nudge = useRpc(nudgeStepRpc);
  const retry = useRpc(retryStepRpc);
  const toast = useToast();
  const [message, setMessage] = useState("");
  const active = run !== null && isStepLive(run, stepId);
  // A script step has no agent to talk to.
  const canNudge = active && step.kind !== "script" && step.kind !== "handoff" && (state?.status === "running" || state?.status === "reported");
  const canRestart = run !== null && restartBlocker(run, stepId) === null;
  // Retry goes through the manager, which a paused run does not wake.
  const canRetry = active && !isPaused(run) && state?.status === "reported" && (latest?.report?.outcome === "failure" || latest?.report === null);

  // The latest attempt's timeout (a templated one resolved at its start), else the step's.
  const timeoutMs = latest ? attemptTimeoutMs(step, latest) : step.timeout ? undefined : step.timeoutMs;
  const timeoutText = timeoutMs ? ` · timeout ${Math.round(timeoutMs / 60000)} min` : step.timeout ? ` · timeout ${step.timeout}` : "";

  return (
    <Modal title={`${stepTitle(step)}${role ? ` · ${role.title}` : step.kind === "gate" ? " · Gate" : step.kind === "script" ? " · Script" : step.kind === "handoff" ? " · Hand-off" : step.kind === "branch" ? " · Branch" : ""}`} open onOpenChange={(open) => !open && props.onClose()}>
      <Modal.Content>
        {state ? <Line theme={theme}>Status: {state.status}{latest ? ` · attempt ${latest.n}` : ""}{latest?.waiting && state.status === "running" ? ` · waiting for tokens until ${new Date(latest.waiting.until).toLocaleString()}` : ""}</Line> : null}
        {step.kind === "agent" ? (
          <Section theme={theme} title="Agent">
            <Line theme={theme} muted>
              {[step.agent.provider, step.agent.model, step.agent.mode, step.agent.thinking].filter(Boolean).join(" · ") || "manager's provider and model"}
              {timeoutText}
              {step.retries ? ` · retries ${step.retries}` : ""}
            </Line>
          </Section>
        ) : null}
        {step.kind === "script" ? (
          <Section theme={theme} title="Script">
            <Line theme={theme} muted>
              {step.script}
              {step.pollMs ? ` · every ${formatInterval(step.pollMs)} until done` : " · runs once"}
              {timeoutText}
              {step.retries ? ` · retries ${step.retries}` : ""}
            </Line>
            {latest ? (
              <Line theme={theme} muted>
                {latest.checks} check(s){latest.nextCheckAt && state?.status === "running" ? ` · next at ${new Date(latest.nextCheckAt).toLocaleTimeString()}` : ""}
              </Line>
            ) : null}
          </Section>
        ) : null}
        {step.kind === "handoff" ? (
          <Section theme={theme} title="Hand-off">
            <Line theme={theme} muted>
              Hands a job to the singleton playbook "{step.handoff}" and waits for its result
              {timeoutText}
              {step.retries ? ` · retries ${step.retries}` : ""}
            </Line>
            {latest?.job ? (
              <Line theme={theme} muted>
                Job {latest.job.jobId} · run {latest.job.runId}
              </Line>
            ) : null}
            {latest?.lastMessage && !latest.report ? <Line theme={theme}>{latest.lastMessage}</Line> : null}
          </Section>
        ) : null}
        {step.when?.length ? (
          <Section theme={theme} title="Runs only when">
            {step.when.map((when) => (
              <Line key={when.input} theme={theme} muted>
                {conditionText(when)}
              </Line>
            ))}
          </Section>
        ) : null}
        {state?.status === "skipped" ? (
          <Line theme={theme} muted>
            Skipped: {run?.history.findLast((event) => event.type === "step_skipped" && event.stepId === stepId)?.detail ?? "not reached"}
          </Line>
        ) : null}
        {step.branch ? (
          <Section theme={theme} title="Branch (first case that holds runs)">
            {step.branch.cases.map((candidate) => (
              <Line key={candidate.name} theme={theme} muted={state?.branch !== candidate.name}>
                {state?.branch === candidate.name ? "▶ " : ""}
                {candidate.name}: {candidate.when ? `if ${candidate.when.map(conditionText).join(" and ")}` : "else"}
              </Line>
            ))}
          </Section>
        ) : null}
        {Object.keys(step.inputs).length > 0 ? (
          <Section theme={theme} title="Inputs">
            {Object.entries(step.inputs).map(([name, wiring]) => {
              const received = latest?.inputs[name];
              return (
                <Line key={name} theme={theme}>
                  {name} ← {wiring.label}
                  {wiring.auto ? " (auto)" : ""}
                  {received ? `: ${received.value.length > 300 ? `${received.value.slice(0, 300)}…` : received.value}` : ""}
                </Line>
              );
            })}
          </Section>
        ) : null}
        {latest?.brief ? (
          <Section theme={theme} title="Manager's brief">
            <Line theme={theme}>{latest.brief}</Line>
          </Section>
        ) : null}
        {latest?.report ? (
          <Section theme={theme} title={`Report · ${latest.report.outcome}`}>
            <Line theme={theme}>{latest.report.summary}</Line>
            {Object.entries(latest.report.outputs).map(([name, value]) => (
              <Line key={name} theme={theme} muted>
                {name}: {String(value)}
              </Line>
            ))}
          </Section>
        ) : null}
        {step.kind === "script" && latest?.lastMessage ? (
          <Section theme={theme} title={latest.report ? "Output" : "Output of the last check"}>
            <Line theme={theme} muted>
              {latest.lastMessage}
            </Line>
          </Section>
        ) : step.kind !== "handoff" && !latest?.report && latest?.lastMessage ? (
          <Section theme={theme} title="Ended without a report · last message">
            <Line theme={theme}>{latest.lastMessage}</Line>
          </Section>
        ) : null}
        {pendingGate && run ? (
          <Section theme={theme} title="Decision">
            {pendingGate.decider?.by === "role" && pendingGate.escalated === null ? (
              <Line theme={theme} muted>
                Role {pendingGate.decider.role} is deciding; you can still decide first.
              </Line>
            ) : pendingGate.decider?.by === "manager" && pendingGate.escalated === null ? (
              <Line theme={theme} muted>
                The manager may decide this gate; you can still decide first.
              </Line>
            ) : null}
            <GateActions theme={theme} run={run} gate={pendingGate} hostLabel={props.hostLabel} />
          </Section>
        ) : step.kind === "gate" && step.gate ? (
          <Section theme={theme} title="Gate">
            <Line theme={theme}>{step.gate}</Line>
          </Section>
        ) : null}
        {decidedGates.map((gate) => (
          <Line key={gate.id} theme={theme} muted>
            {gate.status}
            {gate.decidedVia === "role" ? ` by role ${gate.decidedBy ?? "?"}` : gate.decidedVia === "manager" ? " by the manager" : ` via ${gate.decidedVia ?? "?"}${gate.decidedBy ? ` by ${gate.decidedBy}` : ""}`}
            {gate.comment ? `: ${gate.comment}` : ""}
          </Line>
        ))}
        {attempts.length > 0 ? (
          <Section theme={theme} title="Attempts">
            {step.kind === "script" || step.kind === "handoff"
              ? attempts.map((attempt) => (
                  <Line key={attempt.n} theme={theme} muted>
                    #{attempt.n} · {attempt.outcome ?? attempt.report?.outcome ?? attempt.turnEnd ?? "running"}
                    {step.kind === "script" ? ` · ${attempt.checks} check(s)` : attempt.job ? ` · job ${attempt.job.jobId}` : ""}
                  </Line>
                ))
              : attempts.map((attempt) => (
                  <Pressable
                    key={attempt.n}
                    accessibilityRole="button"
                    accessibilityLabel={`Open the conversation of attempt ${attempt.n}`}
                    onPress={() => props.onOpenAgent(attempt.agentId)}
                  >
                    <Text style={{ color: theme.colors.accent, fontSize: 13 }}>
                      #{attempt.n} · {attempt.outcome ?? attempt.report?.outcome ?? attempt.turnEnd ?? "running"} · open conversation ↗
                    </Text>
                  </Pressable>
                ))}
          </Section>
        ) : null}
        {canNudge ? (
          <Section theme={theme} title="Nudge">
            <TextInput
              accessibilityLabel="Follow-up message for the step agent"
              placeholder="Follow-up for the step agent"
              placeholderTextColor={theme.colors.foregroundMuted}
              value={message}
              onChangeText={setMessage}
              multiline
              style={{ minHeight: 36, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, padding: 8, color: theme.colors.foreground, backgroundColor: theme.colors.surface2 }}
            />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button
                theme={theme}
                label="Send"
                disabled={!message.trim()}
                onPress={() =>
                  void nudge({ runId: run!.id, stepId, message })
                    .then(() => {
                      setMessage("");
                      toast.show("Sent", { variant: "success" });
                    })
                    .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
                }
              />
              {canRetry ? (
                <Button
                  theme={theme}
                  label="Ask manager to retry"
                  onPress={() =>
                    void retry({ runId: run!.id, stepId })
                      .then(() => toast.show("Asked the manager", { variant: "success" }))
                      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
                  }
                />
              ) : null}
            </View>
          </Section>
        ) : null}
        {canRestart ? (
          <Section theme={theme} title="Restart run from here">
            <RestartRun theme={theme} run={run!} stepId={stepId} hostLabel={props.hostLabel} onDone={props.onClose} />
          </Section>
        ) : null}
        {role ? (
          <Section theme={theme} title={`Role instructions${role.readonly ? " · readonly" : ""}`}>
            <Markdown>{role.instructions}</Markdown>
          </Section>
        ) : null}
        {step.prompt ? (
          <Section theme={theme} title="Prompt template">
            <Line theme={theme} muted>
              {step.prompt}
            </Line>
          </Section>
        ) : null}
      </Modal.Content>
    </Modal>
  );
}
