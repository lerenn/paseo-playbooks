#!/bin/sh
# Prints the items that are ready to be worked on now, as a JSON list in the last line.
# Replace the body with your own source (a file, an API, a dependency graph).
echo '{"summary": "2 items ready", "outputs": {"items": [{"id": "item-1", "title": "First"}, {"id": "item-2", "title": "Second"}]}}'
