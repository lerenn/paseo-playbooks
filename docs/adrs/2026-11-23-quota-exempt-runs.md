# A run can be started exempt from quota limiting

Status: Accepted. Builds on `2026-11-23-run-quota-priority-override.md` (priority, `start_playbook`'s flat `priority` stays), `2026-11-21-pause-admitted-runs-to-fit-pace.md` (the pace plan) and `2026-11-23-zero-cost-runs-not-paced.md`.

## Context

Requests that come from a human through a chat hub start playbooks with `start_playbook`. Those runs must not wait behind paced background work, nor be held because the quota is exhausted or unreadable: the person is waiting for the answer. A high `priority` only orders the queue; it still holds the run when the headroom is short, the window is exhausted, the data is unavailable or a cap is full.

## Decision

- **Tool.** `start_playbook` takes a `quota` block: `quota: { exempt: true }` (an extensible block; the flat `priority` is unchanged). Omitted or `exempt: false`: the run is limited like any other.
- **Run state.** A new optional boolean `quotaExempt` (default `false`; runs saved before it load as `false`). Set only at start; not changeable afterwards. It is carried through the same path as `priority` (the run reservation the manager's own `start_playbook` takes, `startFromPanel`, `startInNewWorkspace`). Child runs (fan-out, pool, refills) inherit it from their parent run, and a run attached by `replace_child` takes the flag of its new parent; `restart_run` reopens the same run, so it keeps it.
- **Never held.** `rateCheck` returns no hold for an exempt run, and lifts any it had: no headroom queue, no pace pause, no `quota` hold for an exhausted window or unavailable usage data, and the `steps` and `playbooks` caps do not apply to it (a decision of this ADR: "not subject to quota limiting" includes the caps). Its running steps still count in the "running now" figures and so in the caps of the other runs. It gets no hold notice, since it has no hold.
- **Still reserves.** At its first step it reserves its estimated cost (steps still to run × the playbook's measured cost, the same figure as for any run; its remaining need afterwards). That reservation is subtracted from the headroom the other runs see (the queue and the pace plan), so paced work yields to it. It cannot hold itself: it is not a candidate of the queue (so it blocks no lower-priority waiter on its provider) and not an entry of the pace plan (its reservation counts among the "other" reservations the plan takes first).
- **Cost history.** Unchanged: its measured cost is recorded like any run's.
- **Visibility.** `get_run` and `list_runs` show `quotaExempt`; the run's history entry `run_started` says `quota: exempt` (a run that inherits it says so too); `run.started` does not exist as an event, so the history entry is the audit trail. In the Runs view an exempt run shows an `exempt` tag where the priority control would be (the control is hidden: priority means nothing without a queue); in the Quota limitation tab's Reservations list it carries an `exempt` tag in the accent colour, is never listed held or paused, and does not set the typical need the throttle is measured against. Strings in en, fr and zh-CN.
- **Who may set it.** Any agent that can call `start_playbook` (managers and Sidekicks; step agents cannot). There is no config switch: no existing option restricts what `start_playbook` can do, and adding one would be a new surface.

## Consequences

- A caller can exempt its own work from quota limiting; the run's history records it, nothing else stops it. Any agent that may start a playbook could exempt itself or its runs, so a misbehaving manager could use it to skip pacing. If that becomes a problem, a `quota_limits: { allow_exempt }` switch can be added by a later ADR.
- Exempt runs can push the quota past what pacing allows: that is the point. Others wait for the headroom they leave.
- A run that is exempt and its parent's other children share the flag, so a fan-out of exempt runs is as exempt as its parent.
