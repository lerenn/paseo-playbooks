import { Fragment } from "react";
import { Pressable, Text, View } from "react-native";
import { isTerminal, type RunSummary } from "../shared/types";
import type { Theme } from "./theme";

/** What the stations need of a run: a summary or a whole run. */
export type StationRun = Pick<RunSummary, "id" | "createdAt" | "status" | "train" | "jobs" | "playbook">;

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

/**
 * A singleton pipeline's stations, in `needs` order: each one's waiting list (the jobs waiting
 * there, oldest first) and its current train.
 */
export function Stations(props: { theme: Theme; pipeline: StationRun; runs: readonly StationRun[]; onOpenTrain?: (run: StationRun) => void }) {
  const { theme, pipeline } = props;
  const stations = pipeline.playbook.singleton?.stations ?? [];
  const trains = trainsOf(pipeline, props.runs);
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
                  waiting.map((job) => (
                    <Text key={job.id} numberOfLines={1} style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
                      {job.label}
                    </Text>
                  ))
                )}
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
