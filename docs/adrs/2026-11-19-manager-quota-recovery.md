# State-preserving manager quota recovery

## Status

Accepted. Supersedes the manager creation-only rule in `2026-11-10-provider-fallback-tiers.md`;
its other tier, step fallback and exhaustion decisions remain in effect.

## Context

Steps already fail over on provider quota, but a live run's manager can stay stuck on the
exhausted provider. Restarting a run replays steps; archiving its manager can archive its
children. Neither is a safe manager recovery.

## Decision

Add `recover_manager(runId, expectedManagerId, reason, model?)` to non-step agents' common
tools, with the same guarded `runs.recover_manager` system RPC. Require an active unarchived managed playbook run, a single active run per manager,
an idle manager with known provider/model and a final quota notice/error in its latest turn.
Refuse paused runs, pending agent questions/permissions, missing/archived managers and CAS
mismatches. Ordinary human, manager and role gates keep their complete state and deciders.

Use the pinned manager tier followed by `providers.fallback`, skipping run-local exhausted
and usage-blocked targets. An optional model must be in that chain. Use that target's own
mode/thinking (provider-wide fallback inherits those only within the same provider); never
add a tier or reasoning override. A quota completed/failed manager turn calls the same path;
other exits do not. No available target or a creation failure leaves the manager durably
quota-blocked, with no automatic retry loop or changes to step wait/retry limits.

Serialize inbox/event/watchdog/compaction delivery with recovery. Within the run write queue,
create an unprompted replacement, recheck the old manager, then change ownership using
`engine.replaceManager`. Preserve every step, attempt, report, output, job, gate, definition
and script. Never archive the previous manager. Persist `managerRecoveries` (from/to, target,
thinking, reason, at), `managerQuotaBlockedId` and `managerRecoveryPrompt`, defaulted for old
run files. The replacement receives a takeover brief and the existing inbox only after commit.
Inbox entries remain durable until send succeeds; a crash can redeliver to the same manager.

Transfer event subscriptions by ID, retaining their pending queues. Repair interrupted
subscription transfers on startup from committed recovery records. Retrying the same CAS is
idempotent, including after reload. Startup never creates a replacement from guessed quota
state; an explicit recovery can inspect an already-stuck manager's current timeline.

## Consequences

Runs can change manager provider without replay or gate decisions. Human-held gates remain
held; agent-bound questions/permissions require their original conversation and refuse migration.
No configuration format changes or profile model-map changes are needed. Results expose the
exact model and configured thinking (null means provider default, not a known effort level).
Subscription consumption is not inferred from API prices.

Creation and run persistence are separate daemon operations: a crash before commit can leave
an unprompted orphan, but it cannot start a duplicate replacement. There is no automatic retry
of ambiguous creation. The idle check is repeated after creation; only an unused replacement
is archived if the old manager became active. Human messages can still start old conversations;
manager tools reject former owners and plugin deliveries follow the committed owner.
