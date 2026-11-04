# Listing translations

Status: Accepted

## Context

The paseo.sh listing is the plugin's main storefront, and its search matches only the
listing's name and description. The registry also reads translated descriptions from
`paseo-plugin.json` (`translations.<lang>.description`) and translated overviews from
`OVERVIEW.<lang>.md` next to the manifest, and shows them to users of that language. A
large share of Paseo users read French or Chinese.

## Decision

- Ship French (`fr`) and Simplified Chinese (`zh-CN`) listing text: a translated
  description in `paseo-plugin.json` and a full translated overview in `OVERVIEW.fr.md`
  and `OVERVIEW.zh-CN.md`. The plugin name stays "Playbooks" in every language.
- The translations say the same thing as `OVERVIEW.md` and the English description. A
  change to either updates the translations in the same pull request.
- UI labels (Start, Approve, Reject, menu entries) stay in English in the translations,
  because the panel is not translated.
- The repository's Docs check playbook includes the translated overviews in the documents
  it checks.

## Consequences

- Every overview or description change costs three edits instead of one.
- The translations are shipped files, so changing them bumps the version like any other
  shipped file (CI already treats `OVERVIEW*.md` as shipped).
- Adding another language means a new description entry, a new `OVERVIEW.<lang>.md` and
  a line in this rule, through a new ADR.
