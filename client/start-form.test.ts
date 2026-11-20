import { Children, isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { RunPlaybookButton } from "./start-form";
import type { Theme } from "./theme";

vi.mock("react-native", () => ({ Pressable: "Pressable", Switch: "Switch", Text: "Text", View: "View" }));
// The real catalogue helpers, resolved in the locale `locale.current` (like the host does).
const locale = vi.hoisted(() => ({ current: "en" }));
vi.mock("@getpaseo/plugin/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@getpaseo/plugin/client")>();
  const { PluginTranslationRuntime } = await import("@getpaseo/plugin/client/host");
  const runtime = new PluginTranslationRuntime({ getLocale: () => locale.current, subscribe: () => () => {} });
  return {
    ...actual,
    useRpc: vi.fn(),
    useTranslation: (messages: Parameters<typeof actual.useTranslation>[0]) => ({
      locale: locale.current,
      t: (key: string, ...args: unknown[]) => runtime.resolve((messages.message as (key: string, ...args: unknown[]) => never)(key, ...args)),
    }),
  };
});
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

describe("Run Playbook button in another language", () => {
  it.each([
    ["fr", "Lancer un playbook : démarrer un playbook dans un nouvel espace de travail", "Lancer un playbook"],
    ["zh-CN", "运行 Playbook：在新工作区中开始一个 playbook", "运行 Playbook"],
  ])("labels it in %s, visible text and accessibility label", (language, label, text) => {
    locale.current = language;
    try {
      const button = RunPlaybookButton({ theme, onPress: vi.fn() });
      expect(button.props.accessibilityLabel).toBe(label);
      const child = Children.toArray(button.props.children).filter(isValidElement).at(-1) as ReactElement<Record<string, unknown>>;
      expect(child.props.children).toBe(text);
    } finally {
      locale.current = "en";
    }
  });
});
