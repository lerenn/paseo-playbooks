# Addable panel tabs: Runs only by default, the others added with "+"

## Status

Accepted. Changes the tab bar of the main panel (Runs, Analytics, Quota limitation, Off hours, Profiles).

## Context

The panel showed five tabs to every user from the first load. Most users only need Runs, and the
others (analytics, quota, off hours, profiles) overwhelmed new users.

## Decision

- **Runs** is the default tab, always shown, and cannot be closed. It is the only fixed tab.
- Every other tab is addable. A **+** button at the end of the bar opens a small menu of the tabs that
  are not open; picking one opens and selects it. The button is hidden when all tabs are open.
- An added tab has an **x**, shown on the selected or hovered (or focused) tab, and always on compact
  (mobile) layouts where there is no hover. Closing the selected tab selects Runs.
- Added tabs are kept in the host settings the panel already uses for its sort
  (`overviewSettings`, scope `host`): a new `openTabs` list, default empty. They survive reloads and
  are shared by the clients of the host. Unknown names in the stored list are ignored.
- **No migration.** On the first load after this update everyone, existing users included, sees
  Runs only: the tabs they saw before are hidden until they add them again.
- Every way of selecting a tab goes through one function (`openTab`), so a link that selects a hidden
  tab opens it instead of landing on nothing. Today the tab is only selected from the bar and its
  "+" menu (no run link or hint selects a tab programmatically); any future link must use `openTab`.
- No tab shows a badge or dot today. A tab that gains one must show it when open and nothing when closed.
- The open/close/select logic is a small pure module (`shared/panel-tabs.ts`) with tests.
- The bar uses `tablist` / `tab` roles; the "+" button and each close button are labelled, the menu
  uses `menu` / `menuitem`. Strings exist in en, fr and zh-CN.

## Consequences

- Users who relied on seeing Analytics, Quota limitation, Off hours or Profiles must add them once
  with "+". This is stated in the release notes.
- A fresh user reads one tab; the others are one click away.
- The settings schema gains a defaulted field, so existing stored settings load unchanged.
