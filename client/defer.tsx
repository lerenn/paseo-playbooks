import { useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { deferGateRpc, returnGateRpc } from "../shared/contracts";
import { deferRequest, type DeferDraft } from "../shared/defer";
import { describeCondition, isTracked } from "../shared/gates";
import type { Gate, RunSummary } from "../shared/types";
import type { Theme } from "./theme";
import { semanticColor } from "./semantic-colors";

type Kind = DeferDraft["kind"];
const KINDS: { kind: Kind; label: string }[] = [
  { kind: "manual", label: "Something else (I track it)" },
  { kind: "date", label: "On a date" },
  { kind: "run_ended", label: "Another run ends" },
  { kind: "gate_decided", label: "Another gate is decided" },
];

function Chip(props: { theme: Theme; label: string; on: boolean; onPress(): void }) {
  const { theme } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.on }}
      onPress={props.onPress}
      style={{ borderRadius: 7, borderWidth: 1, borderColor: props.on ? theme.colors.accent : theme.colors.border, backgroundColor: props.on ? theme.colors.surface2 : "transparent", paddingHorizontal: 9, paddingVertical: 5 }}
    >
      <Text style={{ color: props.on ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 12 }}>{props.label}</Text>
    </Pressable>
  );
}

/** Sets an open gate aside in Waiting. The gate stays open and can still be decided; only the reason and what it waits for are recorded. */
export function DeferForm(props: { theme: Theme; run: RunSummary; gate: Gate; hostLabel: string; others: RunSummary[]; onDone(): void }) {
  const { theme, run, gate } = props;
  const defer = useRpc(deferGateRpc);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [kind, setKind] = useState<Kind>("manual");
  const [text, setText] = useState("");
  const [remind, setRemind] = useState("");
  const [runId, setRunId] = useState("");
  const [gateId, setGateId] = useState("");
  const [busy, setBusy] = useState(false);
  const sameProject = props.others.filter((other) => other.projectId === run.projectId && other.id !== run.id);
  const draft: DeferDraft =
    kind === "manual" ? { kind, note: text, remind } : kind === "date" ? { kind, when: text, remind } : kind === "run_ended" ? { kind, runId, remind } : { kind, runId, gateId, remind };
  const input = { borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, padding: 8, color: theme.colors.foreground, backgroundColor: theme.colors.surface2 } as const;
  const submit = async () => {
    const request = deferRequest(reason, draft);
    if (!request.ok) return toast.error(request.error);
    setBusy(true);
    try {
      await defer({ runId: run.id, gateId: gate.id, reason: reason.trim(), condition: request.condition, remindAt: request.remindAt, hostLabel: props.hostLabel });
      toast.show("Moved to Waiting. It is still open: nothing was decided.", { variant: "success" });
      props.onDone();
      await queryClient.invalidateQueries({ queryKey: ["playbooks"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Defer: you reviewed this and will not decide now. It stays open (you can still decide it); it just leaves Needs you.</Text>
      <TextInput accessibilityLabel="Why it is deferred" placeholder="Why not now? (required)" placeholderTextColor={theme.colors.foregroundMuted} value={reason} onChangeText={setReason} multiline style={{ ...input, minHeight: 48 }} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Waiting for</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {KINDS.map((entry) => (
          <Chip key={entry.kind} theme={theme} label={entry.label} on={kind === entry.kind} onPress={() => setKind(entry.kind)} />
        ))}
      </View>
      {kind === "manual" ? (
        <>
          <Text style={{ color: semanticColor(theme, "waiting"), fontSize: 12 }}>Not tracked: the plugin cannot see a PR merge, a reply or a deploy. Bring it back yourself (or set a reminder date).</Text>
          <TextInput accessibilityLabel="What it waits for" placeholder="What are you waiting for? (e.g. the PR merges)" placeholderTextColor={theme.colors.foregroundMuted} value={text} onChangeText={setText} style={input} />
        </>
      ) : null}
      {kind === "date" ? <TextInput accessibilityLabel="Return date" placeholder="Back on (2026-12-01 or 2026-12-01 14:30)" placeholderTextColor={theme.colors.foregroundMuted} value={text} onChangeText={setText} style={input} /> : null}
      {kind === "run_ended" ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {sameProject.length === 0 ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>No other run in this project.</Text> : null}
          {sameProject.map((other) => (
            <Chip key={other.id} theme={theme} label={`${other.playbook.title} · ${other.name ?? other.id}`} on={runId === other.id} onPress={() => setRunId(other.id)} />
          ))}
        </View>
      ) : null}
      {kind === "gate_decided" ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {sameProject.flatMap((other) => other.gates.filter((candidate) => candidate.status === "pending").map((candidate) => ({ other, candidate }))).map(({ other, candidate }) => (
            <Chip key={`${other.id}:${candidate.id}`} theme={theme} label={`${other.playbook.title} › ${candidate.stepId}`} on={runId === other.id && gateId === candidate.id} onPress={() => { setRunId(other.id); setGateId(candidate.id); }} />
          ))}
        </View>
      ) : null}
      <TextInput accessibilityLabel="Reminder date" placeholder="Remind me on (optional, e.g. 2026-12-01)" placeholderTextColor={theme.colors.foregroundMuted} value={remind} onChangeText={setRemind} style={input} />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Move to Waiting" disabled={busy} onPress={() => void submit()} style={{ borderRadius: 7, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: theme.colors.accent, opacity: busy ? 0.6 : 1 }}>
          <Text style={{ color: theme.colors.accentForeground, fontSize: 12, fontWeight: "600" }}>Move to Waiting</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** What a Waiting gate is waiting for, and how: tracked by the plugin, or by hand. */
export function WaitingInfo(props: { theme: Theme; gate: Gate }) {
  const { theme, gate } = props;
  const deferral = gate.deferral;
  if (!deferral) return null;
  const tracked = isTracked(deferral.condition);
  return (
    <View style={{ gap: 2 }}>
      <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Why: {deferral.reason}</Text>
      <Text numberOfLines={2} style={{ color: tracked ? theme.colors.foregroundMuted : semanticColor(theme, "waiting"), fontSize: 11 }}>{describeCondition(deferral)}</Text>
    </View>
  );
}

/** Brings a deferred gate back to Needs you (it does not decide it). */
export function BringBack(props: { theme: Theme; run: Pick<RunSummary, "id">; gate: Gate; hostLabel: string }) {
  const { theme } = props;
  const back = useRpc(returnGateRpc);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Bring back to Needs you"
      disabled={busy}
      onPress={async () => {
        setBusy(true);
        try {
          await back({ runId: props.run.id, gateId: props.gate.id, hostLabel: props.hostLabel });
          await queryClient.invalidateQueries({ queryKey: ["playbooks"] });
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        } finally {
          setBusy(false);
        }
      }}
      style={{ borderRadius: 7, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: theme.colors.surface2, opacity: busy ? 0.6 : 1 }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>Bring back</Text>
    </Pressable>
  );
}
