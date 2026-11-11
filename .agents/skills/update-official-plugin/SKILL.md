---
name: update-official-plugin
description: Publish the latest released version of this plugin to the official registry behind paseo.sh/plugins (getpaseo/plugins). Use when asked to update, bump or submit the plugin on the official listing. It finds the latest release tag, compares it with the listed one, writes a submission issue with the changes and permission notes, and closes superseded submissions.
---

# Update the official plugin listing

The listing on paseo.sh/plugins is the registry `getpaseo/plugins`. Git updates are **manual**:
the registry never scans our repository. An update is a new submission issue naming the release
tag; the bot opens a "Review Playbooks" PR and a reviewer merges it. Registry id:
`lerenn/playbooks` (record `plugins/lerenn/playbooks.json`).

Opening an issue is public and outward-facing: show the user the final body and get a yes
before step 5 (unless they already said to go ahead).

## 1. Find the latest release

```bash
git fetch --tags origin
gh release list --repo lerenn/paseo-playbooks --limit 1   # latest tag, e.g. v0.70.0
gh api repos/lerenn/paseo-playbooks/commits/<tag> -q .sha  # the commit it points at
```

The tag must come from a release on `main` (the Release workflow creates it). If the version
in `package.json` on `main` has no tag yet, stop: the release is not out.

## 2. Read what is listed now

```bash
gh api repos/getpaseo/plugins/contents/plugins/lerenn/playbooks.json -q .content | base64 -d
```

Note `artifact.tag` and `artifact.commit`. If it already equals the latest tag, say so and stop.

## 3. Check for pending submissions

```bash
gh issue list --repo getpaseo/plugins --author lerenn --state open
gh pr list --repo getpaseo/plugins --state open --search "Playbooks"
```

Any open, unmerged Playbooks submission is superseded by the new one: list it in the new
issue and close it (step 6) so the reviewer sees only one.

## 4. Write the submission body

Collect the changes between the listed tag and the latest one:

```bash
git log --oneline <listed-tag>..<latest-tag>
git diff --stat <listed-tag>..<latest-tag> -- paseo-plugin.json OVERVIEW.md assets
```

Use this exact shape (the form fields are parsed: keep `### Source` and `### Categories`):

```markdown
### Source

https://github.com/lerenn/paseo-playbooks/tree/<latest-tag>

### Categories

- [ ] Daemon management
- [ ] Themes
- [ ] Providers
- [x] Orchestration
- [ ] Git
- [x] Workspaces
- [ ] Sidebar
- [ ] Extras
- [ ] Utils

Update of the existing `lerenn/playbooks` listing (currently <listed-tag>, `<listed-commit>`)
to release <latest-tag>, commit `<latest-commit>`. The requirement is still Paseo `<requirements.paseo>`.
<Say if the manifest, icon and media changed or not.>

**Breaking change to the playbook format:** <only if any; the plugin is pre-1.0 and says so.
Name the ADR.>

**Permissions:** <unchanged, or what changed: new files written, new commands run, new
network or tool access. Diff `server/` for new process spawns, file writes and fetches.>

Changes since <listed-tag>:
- <grouped, user-facing bullets from the log and the ADRs in docs/adrs/, not a commit dump>

Supersedes #<n> (<tag>), which I am closing. <only if step 3 found some>
```

Keep the categories as in the current record (`orchestration`, `workspaces`). Write the
permissions note from the actual diff; the reviewer checks it against the artifact.

## 5. Open the issue

```bash
gh issue create --repo getpaseo/plugins --label submission --title "Playbooks" --body-file <file>
```

The title is the plugin's name. Do not add a Git ref other than the tag in the Source URL.

## 6. Close superseded submissions

For each one from step 3, comment that it is superseded by the new issue, then close it:

```bash
gh issue close <n> --repo getpaseo/plugins --comment "Superseded by #<new>."
gh pr close <pr> --repo getpaseo/plugins --comment "Superseded by #<new>."
```

## 7. Report and follow up

Give the user the issue link. Within about 30 minutes the bot opens the review PR
(`gh pr list --repo getpaseo/plugins --search "Playbooks"`); the reviewer then tags the
author in the outcome. If a PR exists but nothing happens for a day, say so rather than
re-submitting. Do not open a second issue for the same tag.
