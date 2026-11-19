# Step agents can validate playbooks

## Status
Accepted

## Context
Step sessions received only result reporting (and gate answers for managerless runs), so implementers and reviewers could not call the existing validator to check PR criteria.

## Decision
Expose and preapprove `validate_playbooks` for all Playbook step sessions, including managerless steps. Reuse the existing validator directly with the calling agent's context. Do not add common run tools or manager controls.

The optional path continues to select only the root to inspect; active profiles come from the caller's workspace project. Preserve the existing ability to inspect another local worktree: this is a trusted local read tool, not a workspace sandbox. Validation does not change playbooks or run state.

## Consequences
Step agents can validate project playbooks without manager delegation. The tool's existing fresh-source resolution and filesystem read scope remain unchanged. An empty result set is not evidence that the intended project's playbooks passed. Existing sessions receive the tool when their session next opens; no run restart or replay is required.
