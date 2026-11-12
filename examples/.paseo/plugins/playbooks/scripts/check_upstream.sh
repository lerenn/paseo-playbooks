#!/bin/sh
# One look, then exit. Events only say "something changed, look again": the truth is read here.
# Replace the body with a real check (ask your tracker or CLI whether job $PLAYBOOK_INPUT_JOB has settled).
if [ -f "${PLAYBOOK_WORKSPACE:-.}/upstream-settled" ]; then
  echo '{"summary": "settled upstream", "outputs": {"outcome_seen": "success"}}'
  exit 0
fi
echo "job $PLAYBOOK_INPUT_JOB not settled yet (check $PLAYBOOK_CHECK)"
exit 75
