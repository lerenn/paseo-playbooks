/**
 * Display form of an id: its last segment (steps of a sub-playbook are "pr.investigate"),
 * first letter capitalised ("investigate" → "Investigate"). The id itself is unchanged.
 */
export function stepLabel(id: string): string {
  const name = id.slice(id.lastIndexOf(".") + 1);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

type Titled = { id: string; title?: string; shortTitle?: string };

/** A step's full name, for the details panel and the graph: its `title`, else stepLabel(id). */
export function stepTitle(step: Titled): string {
  return step.title ?? stepLabel(step.id);
}

/** A step's name in the Playbooks screen columns: its `short_title`, else its full name. */
export function stepShortTitle(step: Titled): string {
  return step.shortTitle ?? stepTitle(step);
}

/** stepTitle of the step with this id in a playbook (stepLabel(id) if it is not there). */
export function stepTitleOf(playbook: { steps: Titled[] }, id: string): string {
  return stepTitle(playbook.steps.find((step) => step.id === id) ?? { id });
}

type Condition = { input: string; values: string[]; empty?: boolean; loop?: Array<{ op: string; value: number }> };

/** A `when` / `if` condition on one line: "env=stg|prd", "url is set", "loop >=2". */
export function conditionText(condition: Condition): string {
  if (condition.loop) return `loop ${condition.loop.map((test) => `${test.op}${test.value}`).join("|")}`;
  if (condition.empty !== undefined) return `${condition.input} is ${condition.empty ? "empty" : "set"}`;
  return `${condition.input}=${condition.values.join("|")}`;
}
