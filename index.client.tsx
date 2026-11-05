import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeHeaderButtons } from "./client/header";
import { PlaybooksScreen, PlaybooksSidebarItem, SCREEN_ID } from "./client/overview";
import { PlaybooksPanel } from "./client/panel";

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
  // Every workspace's runs on one screen, opened from a sidebar row badged with the gates waiting.
  const screen = client.addScreen({ id: SCREEN_ID, title: "Playbooks", Component: PlaybooksScreen });
  const sidebar = client.addSidebarHeaderItem({ id: "playbooks", title: "Playbooks", Component: PlaybooksSidebarItem });
  const headers = contributeHeaderButtons(client);
  return () => {
    headers();
    sidebar();
    screen();
  };
}
