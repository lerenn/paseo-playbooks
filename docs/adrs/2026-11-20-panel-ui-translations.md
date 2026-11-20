# Panel UI translations (fr, zh-CN)

Status: Accepted

## Context

Issue #249 asks for the panel itself, not only the listing, in French and Simplified Chinese.
`2026-11-04-listing-translations.md` kept UI labels in English because the panel was not
translated. The plugin SDK (`@getpaseo/plugin` 0.14, the version the plugin already requires)
now offers `defineTranslations` and `useTranslation`: the host follows the app language, supplies
the translation provider on every plugin surface, falls back to English for a missing key or
language, and accepts translated messages as registration titles.

## Decision

- Panel text lives in one catalogue, `client/i18n.ts`, built with `defineTranslations`. English
  is the source and the fallback; `fr` and `zh-CN` match the listing's languages. The language is
  the Paseo app language: there is no plugin setting.
- React components call `useTranslation(messages)`. Registration titles (workspace panel, screen,
  sidebar row, command center item, header button) are `messages.message(key)` values, so the
  host resolves them and updates them on a language change.
- First step, shipped together: those titles and the header button's waiting state, the panel
  toolbar and empty state, the Start button and its menu, the Run Playbook and Start forms
  (including accessibility labels and toasts), the project picker and the sidebar badge label.
  The rest of the panel and screen (run cards and menus, statuses, graph, analytics, Sidekick,
  gate text) stays English until later steps move it into the catalogue; a string not yet in the
  catalogue simply shows in English.
- Never translated: the name "Playbooks", the term "Playbook Manager", and anything a playbook
  author wrote (titles, descriptions, input names, step names, values). Agent prompts, tool
  contracts, run state and playbook YAML are unchanged.
- Placeholders are validated by the SDK when the module loads; `client/i18n.test.ts` also checks
  that `fr` and `zh-CN` cover every English key, the English fallback, plural forms and a live
  language change.
- Each release ships whatever is in the catalogue: a language needs no completeness gate, because
  of the fallback. A new user-facing string in a translated component is added to all three
  languages in the same pull request.

## Consequences

- Supersedes the listing ADR's rule that UI labels stay in English in the translations; its other
  rules stand. That bullet now points here.
- The listing translations keep the English labels where they name controls that are not yet
  translated, until the panel is fully moved over.
- Every new UI string costs three catalogue entries.
- Adding a language means a new `resources` entry plus listing files, through a new ADR.
