# Format stability: no syntax versioning before v1.0

Status: Accepted

Refines `2026-11-02-release-versioning.md`.

## Context

The playbook format is still settling (chaining removed, after-tasks added, outcome rules
made explicit). Keeping old forms working, or versioning the syntax, would cost more than it
saves while few playbooks exist. Users still need to know when an upgrade breaks theirs.

## Decision

- Until v1.0, any minor release may break the playbook format. There is no syntax version
  and no support for old forms.
- A removed or changed form fails validation with a message that says what to write
  instead (as the removed `next` key does).
- Users pin the plugin to a release tag (`paseo plugin install … --ref vX.Y.Z`,
  `paseo plugin update paseo-playbooks --ref <tag>`) and read the release notes before
  upgrading. The README opens with a warning saying so; the website's install step too.
- Every pull request that breaks the format carries the `breaking-change` label and lists
  the migration under a "Breaking changes" heading in its body. `.github/release.yml` puts
  labelled pull requests in their own "Breaking changes" section of the generated release
  notes.
- At v1.0 the format freezes: an optional top-level `version: 1` key is introduced, and a
  breaking format change then requires a major version.

## Consequences

- Format changes stay cheap before v1.0; the cost moves to clear errors and release notes.
- Contributors must label breaking pull requests, or the change is not surfaced in its own
  section.
