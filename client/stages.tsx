import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { admissionStatusRpc } from "../shared/contracts";
import { isTerminal, type RunSummary, type Stage } from "../shared/types";
import { ADMISSION_POLL_MS, admissionLine, failureHeading, heldView } from "./admission";
import { lastLines } from "./script-output";
import type { Theme } from "./theme";

/** What the stages need of a run: a summary or a whole run. */
export type StageRun = Pick<RunSummary, "id" | "createdAt" | "status" | "batch" | "jobs" | "playbook" | "gates">;

/** The batches of a pipeline, newest first. */
export function batchesOf(pipeline: StageRun, runs: readonly StageRun[]): StageRun[] {
  return runs.filter((run) => run.batch?.pipelineId === pipeline.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A batch's name, from its stage: "Dev batch". */
export function batchName(run: StageRun): string {
  const title = run.playbook.title;
  const cut = title.lastIndexOf(" · ");
  return `${cut === -1 ? (run.batch?.stage ?? title) : title.slice(cut + 3)} batch`;
}

/** "1 job", "3 jobs". */
function jobsLabel(count: number): string {
  return `${count} ${count === 1 ? "job" : "jobs"}`;
}

/** Jobs not ended yet, on a pipeline: "1 job", "3 jobs". */
export function openJobsLabel(pipeline: StageRun): string {
  return jobsLabel(pipeline.jobs.filter((job) => job.status === "open").length);
}

/** A stage's admission check (`queue.admit`): running or waiting for the next one, with an alert when the last check failed. */
function AdmissionInfo(props: { theme: Theme; pipeline: StageRun; stage: Stage; waiting: number }) {
  const { theme, pipeline, stage } = props;
  const fetchStatus = useRpc(admissionStatusRpc);
  const query = useQuery({
    queryKey: ["playbooks", "admission", pipeline.id],
    queryFn: () => fetchStatus({ runId: pipeline.id }),
    refetchInterval: props.waiting > 0 ? ADMISSION_POLL_MS : false,
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (props.waiting === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [props.waiting]);
  const status = query.data?.stages[stage.id];
  const line = admissionLine(status, props.waiting, now);
  return (
    <View accessibilityLabel={`${stage.title} admission: ${line.text}`} style={{ gap: 2 }}>
      <Text style={{ color: line.kind === "failed" ? theme.colors.statusDanger : theme.colors.foregroundMuted, fontSize: 11 }}>{line.text}</Text>
      {line.error && status ? (
        <View accessibilityRole="alert" style={{ gap: 2, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.statusDanger, padding: 6 }}>
          <Text style={{ color: theme.colors.statusDanger, fontSize: 11, fontWeight: "600" }}>{failureHeading(status, line.error)}</Text>
          <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>{line.error.message}</Text>
          {line.error.tail ? (
            <Text numberOfLines={6} style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontFamily: "monospace" }}>
              {lastLines(line.error.tail, 6)}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** A waiting job: its label, and when a stage's admission holds it, a "Held" badge with the reason, since when and the last check. */
function WaitingJob(props: { theme: Theme; job: StageRun["jobs"][number]; stage: string; asked: boolean; now: number }) {
  const { theme, job } = props;
  const entry = job.waiting.find((place) => place.stage === props.stage)!;
  const held = heldView(entry, props.now);
  return (
    <View accessibilityLabel={held ? `${job.label}: ${held.badge.toLowerCase()}, ${held.reason}` : job.label} style={{ gap: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.statusWarning, fontSize: 12 }}>
          {job.label}
        </Text>
        {held ? (
          <Text style={{ color: theme.colors.statusWarning, fontSize: 10, fontWeight: "600", borderRadius: 4, borderWidth: 1, borderColor: theme.colors.statusWarning, paddingHorizontal: 4 }}>{held.badge}</Text>
        ) : null}
        {job.requeued && job.requeued.stage === props.stage ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "600", borderRadius: 4, borderWidth: 1, borderColor: theme.colors.foregroundMuted, paddingHorizontal: 4 }}>Requeued</Text>
        ) : null}
        {props.asked ? <Text style={{ color: theme.colors.accent, fontSize: 10, fontWeight: "600" }}>Needs you</Text> : null}
      </View>
      {job.requeued && job.requeued.stage === props.stage ? (
        <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: 11 }}>
          {job.requeued.outcome}: {job.requeued.reason}
          {job.requeued.blocker ? ` · blocker: ${job.requeued.blocker}` : ""}
        </Text>
      ) : null}
      {held ? (
        <>
          <Text numberOfLines={3} style={{ color: theme.colors.foreground, fontSize: 11 }}>
            {held.reason}
          </Text>
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
            {held.detail}
          </Text>
        </>
      ) : null}
    </View>
  );
}

/**
 * A singleton pipeline's stages, in `needs` order: each one's waiting list (the jobs waiting
 * there, oldest first) and its current batch.
 */
export function Stages(props: { theme: Theme; pipeline: StageRun; runs: readonly StageRun[]; onOpenBatch?: (run: StageRun) => void }) {
  const { theme, pipeline } = props;
  const stages = pipeline.playbook.singleton?.stages ?? [];
  const batches = batchesOf(pipeline, props.runs);
  const [now, setNow] = useState(() => Date.now());
  const anyHeld = pipeline.jobs.some((job) => job.waiting.some((place) => place.held));
  useEffect(() => {
    if (!anyHeld) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyHeld]);
  return (
    // The stages share the row's width, with an arrow between each one and the next.
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      {stages.map((stage, index) => {
        const waiting = pipeline.jobs
          .filter((job) => job.status === "open" && job.waiting.some((place) => place.stage === stage.id))
          .sort((a, b) => a.waiting.find((place) => place.stage === stage.id)!.since.localeCompare(b.waiting.find((place) => place.stage === stage.id)!.since));
        const batch = batches.find((candidate) => candidate.batch!.stage === stage.id && !isTerminal(candidate.status));
        const last = batches.find((candidate) => candidate.batch!.stage === stage.id && isTerminal(candidate.status));
        const inBatch = batch ? batch.jobs.filter((job) => job.status === "open").length : 0;
        return (
          <Fragment key={stage.id}>
            {index > 0 ? (
              <Text accessibilityElementsHidden importantForAccessibility="no" style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>
                →
              </Text>
            ) : null}
            <View
              accessibilityLabel={`Stage ${stage.title}: ${jobsLabel(waiting.length)} waiting, ${batch ? `batch ${batch.id} running with ${jobsLabel(inBatch)}` : "no batch running"}`}
              style={{ flexGrow: 1, flexBasis: 0, minWidth: 200, alignSelf: "stretch", borderRadius: 10, borderWidth: 1, borderColor: batch ? theme.colors.accent : theme.colors.border, backgroundColor: theme.colors.surface1, padding: 10, gap: 6 }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
                {stage.title}
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "400" }}> · {stage.mode}</Text>
              </Text>
              <View style={{ gap: 2 }}>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Waiting list</Text>
                {waiting.length === 0 ? (
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>empty</Text>
                ) : (
                  waiting.map((job) => <WaitingJob key={job.id} theme={theme} job={job} stage={stage.id} asked={pipeline.gates.some((gate) => gate.kind === "admission" && gate.jobId === job.id && gate.status === "pending")} now={now} />)
                )}
                {stage.admit ? <AdmissionInfo theme={theme} pipeline={pipeline} stage={stage} waiting={waiting.filter((job) => !job.waiting.find((place) => place.stage === stage.id)!.forced).length} /> : null}
              </View>
              <View style={{ gap: 2 }}>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Batch</Text>
                {batch ? (
                  <Pressable accessibilityRole="button" accessibilityLabel={`Open batch ${batch.id}`} disabled={!props.onOpenBatch} onPress={() => props.onOpenBatch?.(batch)}>
                    <Text numberOfLines={2} style={{ color: theme.colors.accent, fontSize: 12 }}>
                      {batch.id.replace(/^run_/, "")} · {jobsLabel(inBatch)} · {batch.status === "waiting_gate" ? "waiting for a human" : "running"}
                    </Text>
                  </Pressable>
                ) : (
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                    {last ? `None running · last ${last.id.replace(/^run_/, "")} ${last.status}` : "None yet"}
                  </Text>
                )}
              </View>
            </View>
          </Fragment>
        );
      })}
    </View>
  );
}
