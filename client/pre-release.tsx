import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Theme } from "./theme";

/** Shown on hover, focus or press, so it also works on touch screens and for screen readers. */
export const PRE_RELEASE_NOTICE =
  "Pre-1.0: any minor release may change the playbook format in breaking ways. Pin a release tag and read the release notes before upgrading.";

/** A small yellow warning that Playbooks is not v1 yet; the full text opens beside it. */
export function PreReleaseFlag(props: { theme: Theme }) {
  const { theme } = props;
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pressed, setPressed] = useState(false);
  const shown = hover || focus || pressed;
  return (
    <View style={{ position: "relative", zIndex: 50 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={PRE_RELEASE_NOTICE}
        hitSlop={8}
        onHoverIn={() => setHover(true)}
        onHoverOut={() => setHover(false)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        onPress={() => setPressed(!pressed)}
      >
        <Icon name="TriangleAlert" size={16} color={theme.colors.statusWarning} />
      </Pressable>
      {shown ? (
        <View
          style={{
            position: "absolute",
            top: 24,
            left: 0,
            width: 260,
            padding: 10,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.statusWarning,
            backgroundColor: theme.colors.surface2,
          }}
        >
          <Text style={{ color: theme.colors.foreground, fontSize: 12, lineHeight: 17 }}>{PRE_RELEASE_NOTICE}</Text>
        </View>
      ) : null}
    </View>
  );
}
