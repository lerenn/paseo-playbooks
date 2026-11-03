# Release versioning: bump the version for shipped changes, tag releases from main

Status: Accepted (#15)

## Context

The plugin installs from Git, so Paseo and the Paseo Cafe registry track commits, not a
version. Releases had no clear name, and nothing tied a change that users install to a new
version.

## Decision

- The version lives in `package.json`, starting at `0.1.0`.
- CI (`.github/scripts/check-version.mjs`) fails a pull request that changes shipped files
  without increasing the version: `client/`, `server/`, `shared/`, `skills/`, `assets/`,
  `index.*`, `paseo-plugin.json` and `OVERVIEW*.md`. It also fails when `package-lock.json`
  is out of sync, or when the version goes backwards. Docs, website, examples and CI changes
  need no bump.
- On `main`, the Release workflow tags a new version `vX.Y.Z` and creates a GitHub release.
  The Cafe listing is updated by pointing it at that tag.

## Consequences

- Every user-visible change has a version and a release with generated notes.
- Contributors must run `npm version <patch|minor|major> --no-git-tag-version` in pull
  requests that touch shipped files.
