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
- First step (#250): the registration titles, header button, panel toolbar and empty state, the
  Start button and the Run Playbook and Start forms. Final step (#249): everything else in the
  panel and screen: run cards, statuses, graph and stages, run tabs and step sheet, gates and
  loop limits, analytics, the Quota limitation tab, Sidekick, profiles, errors and accessibility
  labels. Plurals use `_one`/`_other` keys and dates and numbers follow the app language.
- Layout: `client/i18n.ts` is still the one catalogue; to keep it reviewable it merges one fragment
  per area from `client/i18n-<area>.ts` (cards, detail, graph, analytics, sidekick, shell). A
  string with no catalogue entry still shows in English.
- Glossary: run = exécution / 运行, step = étape / 步骤, gate = validation / 审批, manager =
  gestionnaire / 管理器, hold = mise en attente / 暂缓, pause = pause / 暂停, quota = quota / 配额,
  workspace = espace de travail / 工作区. "playbook" stays untranslated.
- Guard: `client/i18n-literals.test.ts` scans `client/*.tsx` and `client/sidekick/*.tsx` for literal English in JSX text and in text attributes (`label`, `placeholder`, `accessibilityLabel`, `title`, `hint`, `description`) and fails on a hit. It cannot see strings built in ternaries or helpers, so reviews still check those. The names "Playbooks" and "Sidekick" are allowed.
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
- Text produced by the server or by the shared modules (error messages, run state text, the
  description of a deferred gate's condition) is not translated and shows in English.
- Every new UI string costs three catalogue entries.
- Adding a language means a new `resources` entry plus listing files, through a new ADR.
