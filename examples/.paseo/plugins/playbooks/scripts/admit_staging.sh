#!/bin/sh
# Admission check of a stage's queue. It looks once and exits; the plugin reruns it, so it must be idempotent.
#
# In:  PLAYBOOK_JOBS     JSON list of the stage's waiting jobs: [{ "id", "label", "since", "inputs": { ... } }]
#      PLAYBOOK_STAGE    the stage this queue belongs to (here: staging); PLAYBOOK_STATION is its deprecated name
#      PLAYBOOK_PIPELINE the pipeline's playbook id (here: staged_release)
# Out: the last line of stdout, a JSON object:
#        admit:    [ids]                  these may join the next batch
#        hold:     { id: "reason" }       these wait; the reason is shown in the panel and in get_run
#        escalate: { id: "reason" }       these cannot become admissible by themselves: a human is asked
#      A job the script does not name is held ("not admitted by the script").
# Exit 75 means "not yet": nothing changes and the next trigger retries. Any other failure changes nothing either
# and is shown as an alert on the stage.
#
# Replace the rule below with a real look at your tracker, code host or CI (needs jq to read the jobs).
echo "$PLAYBOOK_JOBS" | jq -c '{
  admit: [.[] | select((.inputs.ticket // "") != "") | .id],
  hold: ([.[] | select((.inputs.ticket // "") == "") | { key: .id, value: "no ticket: add one to the change" }] | from_entries)
}'
