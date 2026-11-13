#!/bin/sh
# Prints the jobs that wait for nothing, as a JSON list in the last line.
# Replace the body with your own source (a file, an API, a dependency graph).
echo '{"summary": "1 job ready", "outputs": {"items": [{"id": "fetch", "title": "Fetch the data"}]}}'
