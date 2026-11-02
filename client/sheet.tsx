import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Markdown, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { decideGateRpc, nudgeStepRpc, retryStepRpc } from "../shared/contracts";
import { isTerminal, type Gate, type Playbook, type Run } from "../shared/types";
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
function Section(props: { theme: Theme; title: string; children: ReactNode }) {
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

/** Approve / reject a pending gate, with an optional comment. Used in the sheet and under gate nodes. */
export function GateActions(props: { theme: Theme; run: Run; gate: Gate; hostLabel: string }) {
  const { theme, run, gate } = props;
  const decide = useRpc(decideGateRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (decision: "approved" | "rejected") => {
    setBusy(true);
    try {
      const result = await decide({ runId: run.id, gateId: gate.id, decision, comment, hostLabel: props.hostLabel });
      toast.show(result.alreadyDecided ? `Already ${result.decision}` : decision === "approved" ? "Approved" : "Rejected", { variant: "success" });
      await queryClient.invalidateQueries({ queryKey: ["playbooks"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 6 }}>
      <Line theme={theme}>{gate.message}</Line>
      <TextInput
        accessibilityLabel="Comment for the decision"
        placeholder="Comment (sent back on reject)"
        placeholderTextColor={theme.colors.foregroundMuted}
        value={comment}
        onChangeText={setComment}
        multiline
        style={{ minHeight: 36, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, padding: 8, color: theme.colors.foreground, backgroundColor: theme.colors.surface2 }}
      />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button theme={theme} kind="primary" label="Approve" disabled={busy} onPress={() => void submit("approved")} />
        <Button theme={theme} kind="danger" label="Reject" disabled={busy} onPress={() => void submit("rejected")} />
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
  const active = run !== null && !isTerminal(run.status);
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
