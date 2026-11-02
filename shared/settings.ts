import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Daemon-side cap on agent modes. Playbooks come from the workspace (any branch can ship
 * one), so they may never ask for more freedom than the daemon owner allows here.
 */
export const capSettings = defineSettings({
  id: "cap",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Allowed `mode` values per provider. An unset mode (provider default) is always allowed. */
    allowedModes: z.record(z.string(), z.array(z.string())).default({ claude: ["default", "acceptEdits"] }),
  }),
});

export type CapValues = z.output<typeof capSettings.schema>;
export const DEFAULT_CAP: CapValues = { allowedModes: { claude: ["default", "acceptEdits"] } };
