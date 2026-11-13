#!/bin/sh
# Prints the jobs that can start now, given the finished keys in $PLAYBOOK_INPUT_DONE (a JSON list such as ["fetch"]).
# It runs many times, so it must depend only on what is done; the plugin ignores jobs it already knows.
# Replace the table below with your own source (a file, an API, a dependency graph).
is_done() { printf '%s' "$PLAYBOOK_INPUT_DONE" | grep -q "\"$1\""; }
items=""
add() { items="${items:+$items,}{\"id\": \"$1\", \"title\": \"$2\"}"; }
if is_done fetch; then
  add parse "Parse the data"
  add index "Build the index"
fi
if is_done parse && is_done index; then
  add report "Write the report"
fi
echo "{\"summary\": \"unlocked jobs\", \"outputs\": {\"items\": [$items]}}"
