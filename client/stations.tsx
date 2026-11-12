import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { admissionStatusRpc } from "../shared/contracts";
import { isTerminal, type RunSummary, type Station } from "../shared/types";
import { ADMISSION_POLL_MS, admissionLine, failureHeading, heldView } from "./admission";
import { lastLines } from "./script-output";
import type { Theme } from "./theme";

/** What the stations need of a run: a summary or a whole run. */
export type StationRun = Pick<RunSummary, "id" | "createdAt" | "status" | "train" | "jobs" | "playbook" | "gates">;

/** The trains of a pipeline, newest first. */
export function trainsOf(pipeline: StationRun, runs: readonly StationRun[]): StationRun[] {
  return runs.filter((run) => run.train?.pipelineId === pipeline.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A train's name, from its station: "Dev train". */
export function trainName(run: StationRun): string {
  const title = run.playbook.title;
  const cut = title.lastIndexOf(" · ");
  return `${cut === -1 ? (run.train?.station ?? title) : title.slice(cut + 3)} train`;
}

/** "1 job", "3 jobs". */
function jobsLabel(count: number): string {
  return `${count} ${count === 1 ? "job" : "jobs"}`;
}

/** Jobs not ended yet, on a pipeline: "1 job", "3 jobs". */
export function openJobsLabel(pipeline: StationRun): string {
  return jobsLabel(pipeline.jobs.filter((job) => job.status === "open").length);
}

/** A station's admission check (`queue.admit`): running or waiting for the next one, with an alert when the last check failed. */
function AdmissionInfo(props: { theme: Theme; pipeline: StationRun; station: Station; waiting: number }) {
  const { theme, pipeline, station } = props;
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
  const status = query.data?.stations[station.id];
  const line = admissionLine(status, props.waiting, now);
  return (
    <View accessibilityLabel={`${station.title} admission: ${line.text}`} style={{ gap: 2 }}>
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

/** A waiting job: its label, and when a station's admission holds it, a "Held" badge with the reason, since when and the last check. */
function WaitingJob(props: { theme: Theme; job: StationRun["jobs"][number]; station: string; asked: boolean; now: number }) {
  const { theme, job } = props;
  const entry = job.waiting.find((place) => place.station === props.station)!;
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
        {props.asked ? <Text style={{ color: theme.colors.accent, fontSize: 10, fontWeight: "600" }}>Needs you</Text> : null}
      </View>
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
 * A singleton pipeline's stations, in `needs` order: each one's waiting list (the jobs waiting
 * there, oldest first) and its current train.
 */
export function Stations(props: { theme: Theme; pipeline: StationRun; runs: readonly StationRun[]; onOpenTrain?: (run: StationRun) => void }) {
  const { theme, pipeline } = props;
  const stations = pipeline.playbook.singleton?.stations ?? [];
  const trains = trainsOf(pipeline, props.runs);
  const [now, setNow] = useState(() => Date.now());
  const anyHeld = pipeline.jobs.some((job) => job.waiting.some((place) => place.held));
  useEffect(() => {
    if (!anyHeld) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyHeld]);
  return (
    // The stations share the row's width, with an arrow between each one and the next.
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      {stations.map((station, index) => {
        const waiting = pipeline.jobs
          .filter((job) => job.status === "open" && job.waiting.some((place) => place.station === station.id))
          .sort((a, b) => a.waiting.find((place) => place.station === station.id)!.since.localeCompare(b.waiting.find((place) => place.station === station.id)!.since));
        const train = trains.find((candidate) => candidate.train!.station === station.id && !isTerminal(candidate.status));
        const last = trains.find((candidate) => candidate.train!.station === station.id && isTerminal(candidate.status));
        const riding = train ? train.jobs.filter((job) => job.status === "open").length : 0;
        return (
          <Fragment key={station.id}>
            {index > 0 ? (
              <Text accessibilityElementsHidden importantForAccessibility="no" style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>
                →
              </Text>
            ) : null}
            <View
              accessibilityLabel={`Station ${station.title}: ${jobsLabel(waiting.length)} waiting, ${train ? `train ${train.id} running with ${jobsLabel(riding)}` : "no train running"}`}
              style={{ flexGrow: 1, flexBasis: 0, minWidth: 200, alignSelf: "stretch", borderRadius: 10, borderWidth: 1, borderColor: train ? theme.colors.accent : theme.colors.border, backgroundColor: theme.colors.surface1, padding: 10, gap: 6 }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
                {station.title}
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "400" }}> · {station.mode}</Text>
              </Text>
              <View style={{ gap: 2 }}>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Waiting list</Text>
                {waiting.length === 0 ? (
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>empty</Text>
                ) : (
                  waiting.map((job) => <WaitingJob key={job.id} theme={theme} job={job} station={station.id} asked={pipeline.gates.some((gate) => gate.kind === "admission" && gate.jobId === job.id && gate.status === "pending")} now={now} />)
                )}
                {station.admit ? <AdmissionInfo theme={theme} pipeline={pipeline} station={station} waiting={waiting.filter((job) => !job.waiting.find((place) => place.station === station.id)!.forced).length} /> : null}
              </View>
              <View style={{ gap: 2 }}>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Train</Text>
                {train ? (
                  <Pressable accessibilityRole="button" accessibilityLabel={`Open train ${train.id}`} disabled={!props.onOpenTrain} onPress={() => props.onOpenTrain?.(train)}>
                    <Text numberOfLines={2} style={{ color: theme.colors.accent, fontSize: 12 }}>
                      {train.id.replace(/^run_/, "")} · {jobsLabel(riding)} · {train.status === "waiting_gate" ? "waiting for a human" : "running"}
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
