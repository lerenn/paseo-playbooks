import { z } from "zod";

/** One usage window of a provider, with the pacing's numbers. Percent points of the window throughout. */
export const QuotaWindowSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** A window of one model (`weekly_model_x`): shown, never paced. */
  modelScoped: z.boolean(),
  /** The raw usage reading; null when the provider gave none. */
  used: z.number().nullable(),
  /** The share of the window the playbooks may use (`usable_percent`). */
  usable: z.number(),
  /** The pace ceiling now (never above `usable`); null when the window is not paced. */
  ceiling: z.number().nullable(),
  /** Ceiling minus usage (negative when usage is ahead of the pace); null when not paced. */
  headroom: z.number().nullable(),
  /** What admitted and queued runs still have to use of the window. */
  reserved: z.number(),
  /** Headroom minus reservations: what a new run can still take; null when not paced. */
  free: z.number().nullable(),
  resetsAt: z.string().nullable(),
  /** The window already reset: its reading is stale until the next refresh. */
  stale: z.boolean(),
});
export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;

export const QuotaRunRefSchema = z.object({ runId: z.string(), title: z.string() });

export const QuotaProviderSchema = z.object({
  provider: z.string(),
  /** `ok`: paced on its windows; `override`: "continue anyway" is on; `unavailable`: no fresh reading, new work is held; `unreported`: no usage reported, not paced. */
  state: z.enum(["ok", "override", "unavailable", "unreported"]),
  readAt: z.string().nullable(),
  overrideUntil: z.string().nullable(),
  windows: z.array(QuotaWindowSchema),
  /** Runs whose estimated cost is reserved on this provider (admitted or queued), with what they still have to use per window id. */
  reservations: z.array(QuotaRunRefSchema.extend({ remaining: z.record(z.string(), z.number()) })),
  /** Runs held or paused by this provider's quota (`quota`, `headroom` and `pace` holds). */
  held: z.array(QuotaRunRefSchema.extend({ kind: z.string(), reason: z.string(), window: z.string().nullable(), retryAt: z.string().nullable() })),
  /** `provider/model` targets marked out of tokens by runs, until when. */
  exhausted: z.array(QuotaRunRefSchema.extend({ target: z.string(), until: z.string() })),
});
export type QuotaProvider = z.infer<typeof QuotaProviderSchema>;

export const QuotaLimitationSchema = z.object({
  now: z.string(),
  pacing: z.boolean(),
  usablePercent: z.number(),
  refreshSeconds: z.number(),
  maxAgeSeconds: z.number(),
  steps: z.object({ limit: z.number().nullable(), running: z.number() }),
  playbooks: z.object({ limit: z.number().nullable(), admitted: z.number().nullable() }),
  providers: z.array(QuotaProviderSchema),
  /** Runs held by the step or run caps (no provider). */
  limitHeld: z.array(QuotaRunRefSchema.extend({ kind: z.string(), reason: z.string() })),
});
export type QuotaLimitation = z.infer<typeof QuotaLimitationSchema>;
