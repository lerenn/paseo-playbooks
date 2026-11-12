import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every test that uses a RunStore checks, on each mutation, that the event reducers rebuild the state the mutators made (ADR 2026-11-12-event-core).
    env: { PLAYBOOKS_EVENT_PARITY: "throw" },
  },
});
