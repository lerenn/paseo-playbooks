import { useTranslation } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { messages } from "./i18n";
import { BUTTONS_HEIGHT, BUTTONS_LIFT, HEADER, headerPad, summaryLayout } from "./panel-header";
import type { Theme } from "./theme";

/**
 * The screen's brand header: an accent tile with the Playbooks glyph, the name and a one-line
 * pitch on the left, `actions` (the header buttons) on the right. The tagline is left out on a
 * compact layout.
 */
export function PanelHeader(props: { theme: Theme; compact: boolean; actions?: ReactNode; summary?: ReactNode }) {
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
      {props.actions ? (
        props.compact || !props.summary ? (
          <View style={{ flexDirection: "row", alignItems: "center", alignSelf: "center", gap: 10 }}>{props.actions}</View>
        ) : (
          // Wide: the buttons, then the summary below them with a gap, in a column as tall as the tile (the summary overflows
          // it, into the gap above the tabs) that never shrinks, so nothing is cut off and the tabs do not move.
          <View style={{ alignSelf: "center", alignItems: "flex-end", flexShrink: 0, height: summaryLayout().columnHeight }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, height: BUTTONS_HEIGHT, transform: [{ translateY: -BUTTONS_LIFT }] }}>{props.actions}</View>
            <View style={{ flexShrink: 0, marginTop: summaryLayout().groupMarginTop }}>{props.summary}</View>
          </View>
        )
      ) : null}
    </View>
  );
}
