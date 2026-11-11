# Attachments in the Sidekick composer

Status: Accepted

Extends `2026-11-10-sidekick-chat-column.md`, whose composer was text only.

## Context

The Sidekick chat column is a plain composer over the agent's timeline. Humans need to show it a
screenshot or hand it a file, which today means opening the agent as a native tab.

## Decision

- The composer accepts files pasted, dropped (web) or picked with a paperclip button, with a chip per
  attachment (thumbnail for images) and a remove button. Limits live in `shared/attachments.ts`: 8 per
  message, 5 MB per image, 10 MB per other file, 25 MB total, no executables or installers.
- Images (png, jpeg, gif, webp) use the same path as Paseo's own composer and `paseo send --image`:
  `agents.ref(id).send(text, { images: [{ data (base64), mimeType }] })`. No parallel path.
- Other files cannot be written from the client, and the plugin API does not expose Paseo's upload.
  A new RPC `sidekick.save-attachment` saves the bytes under the system temp folder
  (`paseo-playbooks-attachments/<uuid>/<sanitized name>`, owner-only permissions, folders older than a
  week removed on the next save) and returns the path. The message text then ends with a list of the
  saved paths, which the agent reads with its file tools.

## Consequences

- Attachments live in the composer's state: they are lost when the tab is closed before sending.
- Files are readable by the agent only if its tools can read the temp folder.
- If the plugin API later exposes Paseo's `uploadFile`, the RPC can be replaced by `uploaded_file`
  attachments without changing the composer.
