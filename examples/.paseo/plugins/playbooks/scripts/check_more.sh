#!/bin/sh
# Decides whether another pass is needed: outcome "more" goes back to listing, "done" ends.
# Replace the body with a real check (are there items left that were not ready before?).
echo '{"outcome": "done", "summary": "no items left"}'
