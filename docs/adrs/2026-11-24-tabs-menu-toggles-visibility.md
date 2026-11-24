# The "+" menu lists every tab and toggles its visibility; tabs lose their x

## Status

Accepted. Supersedes the "closed with its x" and "menu of the closed tabs" parts of
`2026-11-23-addable-panel-tabs.md`; the rest of that ADR (Runs fixed, nothing but Runs by default,
the stored `openTabs` setting) stands.

## Context

The x on a hovered tab changed the tab's width, so the whole bar shifted under the pointer. The "+"
menu also only listed hidden tabs and vanished once all were shown.

## Decision

- Tabs have no x. The "+" button is always there and opens a menu of all tabs, each with a check mark
  while it is shown. Picking an item shows or hides that tab (same `openTabs` setting, same save).
- Runs and the tab currently being shown are disabled items: they cannot be hidden.
- The menu floats over the content on an opaque background, stays open while several tabs are toggled,
  and closes on an outside click or Esc. Opening it moves and resizes nothing in the bar.
- Showing a tab from the menu does not select it.

## Consequences

- The tab bar geometry is unchanged; the geometry test is untouched.
- The "Close the {tab} tab" string is gone; "Add a tab" became "Choose the tabs to show", and one hint
  string was added (en, fr, zh-CN).
- Items use the `menuitem` role with a checked state: the UI stack's role type has no `menuitemcheckbox`.
