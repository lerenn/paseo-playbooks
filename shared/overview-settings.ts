import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** The Playbooks screen's preferences, kept by the host so they survive reloads and are shared by its clients. */
export const overviewSettings = defineSettings({
  id: "overview",
  scope: "host",
  version: 1,
  schema: z.object({ sort: z.enum(["name", "activity", "status", "started"]).default("name") }),
});
