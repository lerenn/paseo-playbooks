/** Gate IDs are scoped to a run, so flattened Needs You rows need both parts of their identity. */
export function needsYouRowKey(runId: string, gateId: string): string {
  return `${runId}:${gateId}`;
}
