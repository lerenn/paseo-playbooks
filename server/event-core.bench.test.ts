import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { EventLog } from "./event-log";

/**
 * Micro-benchmark, not a CI gate (ADR 2026-11-12-event-core-migration): `EVENT_CORE_BENCH=1 npx vitest run server/event-core.bench`.
 * Compares what one mutation costs today (stringify the whole run, write a temp file, rename) with appending one event line.
 * `EVENT_CORE_BENCH_RUN=<run.json>` uses a real run file instead of a synthetic one of the same shape (≈3.8 MB, ≈1200 history entries).
 */
const enabled = process.env.EVENT_CORE_BENCH === "1";

async function sampleRun(): Promise<object> {
  if (process.env.EVENT_CORE_BENCH_RUN) return JSON.parse(await readFile(process.env.EVENT_CORE_BENCH_RUN, "utf8"));
  const history = Array.from({ length: 1172 }, (_, i) => ({ seq: i + 1, at: "2026-11-12T10:00:00.000Z", type: "step_started", stepId: `step${i % 40}`, detail: "x".repeat(120) }));
  return { id: "run_bench", history, steps: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`step${i}`, { attempts: Array.from({ length: 6 }, () => ({ report: "y".repeat(1800), usage: { input: 1, output: 2 } })) }])), blob: "z".repeat(3_000_000) };
}

async function time(runs: number, fn: () => Promise<void>): Promise<{ median: number; p95: number }> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return { median: samples[Math.floor(samples.length / 2)]!, p95: samples[Math.floor(samples.length * 0.95)]! };
}

describe.skipIf(!enabled)("event core benchmark", () => {
  it("whole-file rewrite vs one appended event", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "event-bench-"));
    try {
      const run = await sampleRun();
      const file = path.join(dir, "run.json");
      const snapshot = await time(30, async () => {
        const text = `${JSON.stringify(run, null, 2)}\n`;
        await writeFile(`${file}.tmp`, text, "utf8");
        await rename(`${file}.tmp`, file);
      });
      const log = new EventLog(dir);
      const event = { type: "job.joined", at: "2026-11-12T10:00:00.000Z", data: { stage: "stg", batchRunId: "run_abc123", jobIds: ["job_a", "job_b"], since: { job_a: "2026-11-12T09:00:00.000Z", job_b: "2026-11-12T09:01:00.000Z" } } };
      const append = await time(500, async () => void (await log.append("bench", [event])));
      const size = (await readFile(file, "utf8")).length;
      console.log(`run file ${(size / 1e6).toFixed(2)} MB: rewrite median ${snapshot.median.toFixed(2)} ms (p95 ${snapshot.p95.toFixed(2)}); append median ${append.median.toFixed(3)} ms (p95 ${append.p95.toFixed(3)}); one event ≈ ${JSON.stringify(event).length} bytes`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
