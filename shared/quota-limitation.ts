import { z } from "zod";
import type { ClosedSlotView } from "./closed-hours";

/** One usage window of a provider, with the pacing's numbers. Percent points of the window throughout. */
export const QuotaWindowSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** A window of one model (`weekly_model_x`): shown, never paced. */
  modelScoped: z.boolean(),
  /** The raw usage reading; null when the provider gave none. */
  used: z.number().nullable(),
  /** What admitted and queued runs still have to use of the window. */
  reserved: z.number(),
  /** The pace figures, one per distinct `usable_percent` among the projects that have pacing on; empty when no project paces or the window is not paced (a model window, a reset window, no reading). */
  paces: z.array(
    z.object({
      /** The share of the window those projects may use (`usable_percent`). */
      usable: z.number(),
      /** The closed hours these projects have (a stable text of them; null for none): with `usable`, which pace a project reads. Absent from an older server. */
      closedKey: z.string().nullable().optional(),
      /** Now falls in a closed slot: what is allowed so far is flat. Absent from an older server. */
      frozen: z.boolean().optional(),
      /** Closed hours are set but the window has no open hour: the plain linear rule is used. Absent from an older server. */
      closedIgnored: z.boolean().optional(),
      /** What is allowed so far now (never above `usable`). */
      ceiling: z.number(),
      /** Ceiling minus usage (negative when usage is ahead of the pace). */
      headroom: z.number(),
      /** Headroom minus reservations: what a new run can still take. */
      free: z.number(),
      /** Labels of the projects with this percent. */
      projects: z.array(z.string()),
    }),
  ),
  resetsAt: z.string().nullable(),
  /** The window already reset: its reading is stale until the next refresh. */
  stale: z.boolean(),
});
export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;

/** A run, with its project so the tab can list it under that project (absent from an older server: shown under every project). */
export const QuotaRunRefSchema = z.object({
  runId: z.string(),
  title: z.string(),
  projectId: z.string().optional(),
});
export type QuotaRunRef = z.infer<typeof QuotaRunRefSchema>;

export const QuotaProviderSchema = z.object({
  provider: z.string(),
  /** Labels of the projects whose resolved limits have pacing on (empty: nothing is paced, whatever the reading says). */
  pacedBy: z.array(z.string()),
  /** `ok`: fresh reading; `override`: "continue anyway" is on; `unavailable`: no fresh reading, new work is held; `unreported`: no usage reported, not paced. */
  state: z.enum(["ok", "override", "unavailable", "unreported"]),
  readAt: z.string().nullable(),
  /**
   * The provider's usage reading as a condition of the provider (ADR 2026-11-23-provider-usage-unavailable), derived from the pacer's
   * readings and failure streak: available, or unavailable since the first failure of the streak with a short reason. Absent from an older server.
   */
  usage: z.object({ available: z.boolean(), since: z.string().nullable(), lastReadAt: z.string().nullable(), reason: z.string().nullable(), failures: z.number() }).optional(),
  overrideUntil: z.string().nullable(),
  windows: z.array(QuotaWindowSchema),
  /** Runs whose estimated cost is reserved on this provider (admitted or queued), with what they still have to use per window id. */
  /** `exempt`: the run is not subject to quota limiting (`quotaExempt`): it reserves quota but is never held. */
  reservations: z.array(QuotaRunRefSchema.extend({ remaining: z.record(z.string(), z.number()), exempt: z.boolean().optional() })),
  /** Runs held or paused by this provider's quota (`quota`, `headroom` and `pace` holds). */
  held: z.array(QuotaRunRefSchema.extend({ kind: z.string(), reason: z.string(), window: z.string().nullable(), retryAt: z.string().nullable(), /** When the hold began, and (headroom holds) the estimated cost of what waits: both read from the run's `rateHold`, nothing new is stored. Absent from an older server. */ since: z.string().optional(), estimatedCost: z.number().nullable().optional() })),
  /** `provider/model` targets marked out of tokens by runs, until when. */
  exhausted: z.array(QuotaRunRefSchema.extend({ target: z.string(), until: z.string() })),
});
export type QuotaProvider = z.infer<typeof QuotaProviderSchema>;

/** The limits a run of a project gets (folder defaults, then user config, then built-in), for one set of the project's playbooks. */
export const QuotaProjectLimitsSchema = z.object({
  /** The repositories (`default`, profile ids) whose playbooks have these limits; empty when the project has no playbook. */
  repos: z.array(z.string()),
  pacing: z.boolean(),
  usablePercent: z.number(),
  /** Closed hours (ADR 2026-11-23-quota-closed-hours): slots not counted towards what is allowed so far; null for none. Absent from an older server. */
  closedHours: z.object({ timezone: z.string(), slots: z.array(z.custom<ClosedSlotView>()) }).nullable().optional(),
  /** Whether a closed slot is running now and when that next changes (ADR 2026-11-23-off-hours-tab); only with `closedHours`. `changeAt` is null when nothing changes within a week. Absent from an older server. */
  closedNow: z.object({ closed: z.boolean(), changeAt: z.string().nullable() }).optional(),
  /** Matches `paces[].closedKey`. */
  closedKey: z.string().nullable().optional(),
  stepsLimit: z.number().nullable(),
  runsLimit: z.number().nullable(),
});
export type QuotaProjectLimits = z.infer<typeof QuotaProjectLimitsSchema>;

export const QuotaProjectSchema = z.object({
  projectId: z.string(),
  label: z.string(),
  /** The largest measured cost of one step of the project's playbooks, per provider then window id (points of the window): the throttle's fallback when no run of the project has a need yet. Absent from an older server. */
  unitCost: z.record(z.string(), z.record(z.string(), z.number())).optional(),
  /** Usually one set; several when a profile's defaults differ from the default repository's. */
  limits: z.array(QuotaProjectLimitsSchema),
});
export type QuotaProject = z.infer<typeof QuotaProjectSchema>;

export const QuotaLimitationSchema = z.object({
  now: z.string(),
  /** The resolved limits per project the plugin knows. */
  projects: z.array(QuotaProjectSchema),
  /** Steps running and runs in the queue, counted over all projects (the caps apply to these). */
  stepsRunning: z.number(),
  runsActive: z.number(),
  providers: z.array(QuotaProviderSchema),
  /** Runs held by the step or run caps (no provider). */
  limitHeld: z.array(QuotaRunRefSchema.extend({ kind: z.string(), reason: z.string() })),
});
export type QuotaLimitation = z.infer<typeof QuotaLimitationSchema>;
