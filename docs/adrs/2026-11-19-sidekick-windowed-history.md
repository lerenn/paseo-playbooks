# Sidekick chat: a small first page, older entries on demand, memoized items

Status: Accepted

## Context

The Sidekick conversation in the main panel was slow to open. It read the last 200 timeline entries
(`timeline.refetch({ direction: "tail", limit: 200 })`), reduced them and rendered every item in a plain
`ScrollView`. Older entries were unreachable, and each streaming event re-rendered every item.

Measured (read-only, against the local daemon through the client SDK, plus a synthetic timeline):

- Fetch, 196 real agents, tail of 200: median payload 42 KiB, largest 377 KiB (200 entries). Typical
  latency is 1 to 30 ms; on a busy daemon 100 to 450 ms, with one cold-agent outlier at 4.3 s. For the two
  largest: limit 20 = 41 / 20 KiB, 40 = 73 / 41 KiB, 100 = 228 / 129 KiB, 200 = 377 / 325 KiB. Latency is
  dominated by daemon load, not by the limit.
- Reducer: a refetch of 200 real entries takes 0.05 to 0.07 ms; 2000 synthetic heavy entries (about 10 MiB)
  0.3 ms; a streaming chunk 0.006 ms. The reducer is not the problem.
- Render: could not be timed (no React renderer in the test setup, and the host UI kit is not loadable in
  Node). Counted instead: with 200 items, every streaming event re-rendered all 201 `ItemView`s (each
  assistant one parses Markdown), though the reducer already changes the identity of one item only.
  The first paint mounted 200 items.
- A `before` page read with the daemon's `startCursor` returns the contiguous entries before it
  (`hasOlder`, `startCursor`, `staleCursor`, `reset` in the payload).

## Decision

- First page of `FIRST_PAGE` = 40 entries; older pages of `OLDER_PAGE` = 40 read with
  `refetch({ direction: "before", cursor: startCursor })` when the reader scrolls within `NEAR_TOP_PX` of the
  top. A reconnect or replaced timeline re-reads the tail with `RELOAD_PAGE` = 200.
- The chat state keeps `older: { epoch, cursor, hasMore, loading }`. A page is merged only if its epoch and
  the cursor it was read from still match (never twice), entries are deduplicated by key and tool call id,
  and a failed or stale read can be retried. A tail re-read keeps the older pages already read when it
  overlaps them (merge by sequence number) and resets cleanly when it does not or the epoch changed.
- The scroll position is kept when older entries are prepended (offset compensation in
  `onContentSizeChange`); the stick-to-bottom rule of v0.115.5 is unchanged and a prepend never follows the
  end. A fixed-height slot at the top shows "Loading older…" or "Start of the conversation" without moving
  the items. The maths is pure (`client/sidekick/window.ts`).
- `ItemView` is `React.memo`; the reducer keeps the identity of unchanged items on a re-read.

## Consequences

- First paint mounts 40 items instead of 200 (up to 5x less Markdown and layout) and reads 2 to 9x fewer
  bytes; a streaming event renders 1 item instead of about 200 (counted, not timed).
- Older history is reachable. Loading older entries adds a request per page.
- Not done, because the numbers do not justify it: virtualization (`FlatList`; it would put the scroll
  rules at risk and could not be checked live), further truncation of tool payloads (they are already
  closed by default and cut at 4000 characters when opened), any change to the reducer cost.
- Not verified live: the real scroll feel in the panel (compensation relies on `onContentSizeChange` and
  `scrollTo` of the host's `ScrollView`).
