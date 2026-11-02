import type { PluginClientContext } from "@getpaseo/plugin/client";
import { PlaybooksPanel } from "./client/panel";
import { CapSettings } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "playbooks",
    title: "Playbooks",
    icon: "Workflow",
    locations: ["explorer", "workspace"],
    Component: PlaybooksPanel,
  });
  client.addCommandCenterItem({
    id: "open-playbooks",
    title: "Open Playbooks",
    icon: "Workflow",
    keywords: ["playbook", "run", "gate"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("playbooks", { location: "explorer" });
    },
  });
  client.addSettingsScreen({ id: "cap", title: "Allowed agent modes", icon: "ShieldCheck", Component: CapSettings });
  return () => {};
}
