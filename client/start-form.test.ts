import { Children, isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { RunPlaybookButton } from "./start-form";
import type { Theme } from "./theme";

vi.mock("react-native", () => ({ Pressable: "Pressable", Switch: "Switch", Text: "Text", View: "View" }));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: vi.fn() }));
vi.mock("@getpaseo/plugin/client/ui", () => ({ Icon: "Icon", Modal: "Modal", TextInput: "TextInput", useToast: vi.fn() }));

const theme = { colors: { accent: "blue", accentForeground: "white" } } as Theme;

describe.each([false, true])("Run Playbook button compact=%s", compact => {
  it.each([
    { loading: true, emptyReason: undefined, reason: "Loading playbooks" },
    { loading: false, emptyReason: "No workspaces found", reason: "No workspaces found" },
    { loading: false, emptyReason: "No runnable playbooks", reason: "No runnable playbooks" },
    { loading: true, emptyReason: "No runnable playbooks", reason: "Loading playbooks" },
    { loading: false, emptyReason: undefined, reason: undefined },
  ])("communicates state for $reason (loading=$loading)", ({ loading, emptyReason, reason }) => {
    const onPress = vi.fn();
    const button = RunPlaybookButton({ theme, compact, loading, emptyReason, onPress });
    const disabled = reason !== undefined;
    expect(button.props.disabled).toBe(disabled);
    expect(button.props.accessibilityRole).toBe("button");
    expect(button.props.accessibilityState).toEqual({ disabled });
    expect(button.props.accessibilityLabel).toBe(disabled
      ? `Run Playbook unavailable: ${reason}` : "Run Playbook: start a playbook in a new workspace");
    expect(button.props.style.opacity).toBe(disabled ? 0.5 : 1);
    expect(button.props.onPress).toBe(onPress);
    const text = Children.toArray(button.props.children).filter(isValidElement).at(-1) as ReactElement<Record<string, unknown>>;
    expect(text.props.children).toBe(reason === undefined ? "Run Playbook" : `Run Playbook${compact ? "\n" : " · "}${reason}`);
    // Native text can grow and wrap at narrow widths and larger system font sizes.
    expect(button.props.style).toMatchObject({ flexShrink: 1, maxWidth: "100%" });
    expect(text.props.style).toMatchObject({ flexShrink: 1 });
    expect(text.props.numberOfLines).toBeUndefined();
    expect(text.props.allowFontScaling).not.toBe(false);
    expect(button.props.style.height).toBeUndefined();
  });
});
