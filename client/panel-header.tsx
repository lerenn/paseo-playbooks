import { useTranslation } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { messages } from "./i18n";
import { headerParts } from "./panel-header-view";
import type { Theme } from "./theme";

/** Brand header at the top of the panel: an accent tile with the Playbooks glyph, the name and a one-line pitch. */
export function PanelHeader(props: { theme: Theme; compact: boolean; pad: number; dismissed: boolean; onDismiss(): void }) {
  const { theme } = props;
  const { t } = useTranslation(messages);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const parts = headerParts({ compact: props.compact, dismissed: props.dismissed });
  if (!parts.visible) return null;
  const size = props.compact ? 40 : 44;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: props.pad, paddingTop: 8, paddingBottom: 4 }}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ width: size, height: size, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.accent }}
      >
        <Icon name="Workflow" size={size / 2} color="#ffffff" />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text accessibilityRole="header" numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 20, fontWeight: "700" }}>{t("title")}</Text>
        {parts.tagline ? (
          <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{t("panel.tagline")}</Text>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("panel.dismissHeader")}
        hitSlop={8}
        onPress={props.onDismiss}
        onHoverIn={() => setHover(true)}
        onHoverOut={() => setHover(false)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{ opacity: hover || focus ? 1 : 0 }}
      >
        <Icon name="X" size={14} color={theme.colors.foregroundMuted} />
      </Pressable>
    </View>
  );
}
