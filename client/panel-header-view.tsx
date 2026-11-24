import { useTranslation } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { messages } from "./i18n";
import { HEADER, headerPad } from "./panel-header";
import type { Theme } from "./theme";

/**
 * The screen's brand header: an accent tile with the Playbooks glyph, the name and a one-line
 * pitch on the left, `actions` (the header buttons) on the right. The tagline is left out on a
 * compact layout.
 */
export function PanelHeader(props: { theme: Theme; compact: boolean; actions?: ReactNode }) {
  const { theme } = props;
  const { t } = useTranslation(messages);
  const pad = headerPad(props.compact);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: HEADER.tileGap, rowGap: 8, paddingLeft: pad, paddingRight: pad, paddingTop: pad }}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ width: HEADER.tile, height: HEADER.tile, borderRadius: HEADER.tileRadius, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.accent }}
      >
        <Icon name="Workflow" size={26} color={theme.colors.accentForeground} />
      </View>
      <View style={{ flex: 1, minWidth: 120, gap: HEADER.textGap }}>
        <Text accessibilityRole="header" numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: props.compact ? HEADER.titleSizeCompact : HEADER.titleSizeWide, fontWeight: "700" }}>{t("title")}</Text>
        {props.compact ? null : (
          <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: HEADER.taglineSize }}>{t("panel.tagline")}</Text>
        )}
      </View>
      {props.actions ? <View style={{ flexDirection: "row", alignItems: "center", alignSelf: "center", gap: 10, ...(props.compact ? {} : { transform: [{ translateY: -3 }] }) }}>{props.actions}</View> : null}
    </View>
  );
}
