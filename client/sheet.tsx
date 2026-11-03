import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Markdown, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { decideGateRpc, nudgeStepRpc, retryStepRpc } from "../shared/contracts";
import { ASK_CHOICES, destinationOf, gateChoices, gateText, linkify, LOOP_LIMIT_CHOICES } from "../shared/gates";
import { isStepLive, type Gate, type GateChoice, type Playbook, type Run } from "../shared/types";
import { stepLabel, type Theme } from "./theme";

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
function destinationLabel(run: Run, gate: Gate, choiceId: string): string {
  if (gate.kind === "ask") return `→ ${stepLabel(gate.gotoTarget ?? "")}`;
  if (gate.kind === "loop_limit") return choiceId === "approved" ? `→ ${stepLabel(gate.gotoTarget ?? "")}` : "→ Fail run";
  const step = run.playbook.steps.find((candidate) => candidate.id === gate.stepId);
  if (!step) return "";
  const destination = destinationOf(run.playbook, step, choiceId);
  if (destination.kind === "end") return "→ End";
  if (destination.kind === "end_block") return `→ End ${run.playbook.blocks[destination.targets[0]!]?.title ?? destination.targets[0]}`;
  if (destination.kind === "fail") return "→ Fail run";
  return `→ ${destination.targets.map(stepLabel).join(", ")}`;
}

/** A pending gate: its summary, collapsed details, and one full-width button per choice. Choices that take a comment open a text box with Send. */
export function GateActions(props: { theme: Theme; run: Run; gate: Gate; hostLabel: string }) {
  const { theme, run, gate } = props;
  const decide = useRpc(decideGateRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const text = gateText(gate);
  const step = run.playbook.steps.find((candidate) => candidate.id === gate.stepId);
  const choices = gate.kind === "loop_limit" ? LOOP_LIMIT_CHOICES : gate.kind === "ask" ? ASK_CHOICES : step ? gateChoices(step) : [];
  const submit = async (choice: GateChoice, withComment: string) => {
    setBusy(true);
    try {
      const result = await decide({ runId: run.id, gateId: gate.id, decision: choice.id, comment: withComment, hostLabel: props.hostLabel });
      toast.show(result.alreadyDecided ? `Already decided: ${result.decision}` : `${choice.label}: sent`, { variant: "success" });
      setOpen(null);
      setComment("");
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
  const canNudge = active && (state?.status === "running" || state?.status === "reported");
  const canRetry = active && state?.status === "reported" && (latest?.report?.outcome === "failure" || latest?.report === null);

  return (
    <Modal title={`${stepLabel(step.id)}${role ? ` · ${role.title}` : step.kind === "gate" ? " · Gate" : ""}`} open onOpenChange={(open) => !open && props.onClose()}>
      <Modal.Content>
        {state ? <Line theme={theme}>Status: {state.status}{latest ? ` · attempt ${latest.n}` : ""}</Line> : null}
        {step.kind === "agent" ? (
          <Section theme={theme} title="Agent">
            <Line theme={theme} muted>
              {[step.agent.provider, step.agent.model, step.agent.mode, step.agent.thinking].filter(Boolean).join(" · ") || "manager's provider and model"}
              {step.timeoutMs ? ` · timeout ${Math.round(step.timeoutMs / 60000)} min` : ""}
              {step.retries ? ` · retries ${step.retries}` : ""}
            </Line>
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
        ) : latest?.lastMessage ? (
          <Section theme={theme} title="Ended without a report · last message">
            <Line theme={theme}>{latest.lastMessage}</Line>
          </Section>
        ) : null}
        {pendingGate && run ? (
          <Section theme={theme} title="Decision">
            <GateActions theme={theme} run={run} gate={pendingGate} hostLabel={props.hostLabel} />
          </Section>
        ) : step.kind === "gate" && step.gate ? (
          <Section theme={theme} title="Gate">
            <Line theme={theme}>{step.gate}</Line>
          </Section>
        ) : null}
        {decidedGates.map((gate) => (
          <Line key={gate.id} theme={theme} muted>
            {gate.status} via {gate.decidedVia ?? "?"}
            {gate.decidedBy ? ` by ${gate.decidedBy}` : ""}
            {gate.comment ? `: ${gate.comment}` : ""}
          </Line>
        ))}
        {attempts.length > 0 ? (
          <Section theme={theme} title="Attempts">
            {attempts.map((attempt) => (
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
