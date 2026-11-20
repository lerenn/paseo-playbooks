import { PluginTranslationRuntime } from "@getpaseo/plugin/client/host";
import { describe, expect, it } from "vitest";
import { messages } from "./i18n";

/** A locale source the test can change, like the app's language setting. */
function source(initial: string) {
  let locale = initial;
  const listeners = new Set<() => void>();
  return {
    getLocale: () => locale,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: string) {
      locale = next;
      for (const listener of listeners) listener();
    },
  };
}

function keys(resource: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(resource).flatMap(([key, value]) =>
    typeof value === "string" ? [`${prefix}${key}`] : keys(value as Record<string, unknown>, `${prefix}${key}.`),
  );
}

const base = (key: string) => key.replace(/_(zero|one|two|few|many|other)$/, "");

describe("panel translations", () => {
  const { resources } = messages;

  it("ships English, French and Simplified Chinese", () => {
    expect(Object.keys(resources).sort()).toEqual(["en", "fr", "zh-CN"]);
  });

  it("translates every English message in fr and zh-CN (plural forms aside)", () => {
    const english = new Set(keys(resources.en).map(base));
    for (const locale of ["fr", "zh-CN"]) {
      expect(new Set(keys(resources[locale] as Record<string, unknown>).map(base)), locale).toEqual(english);
    }
  });

  it("follows the app language and changes it live", () => {
    const locale = source("fr");
    const runtime = new PluginTranslationRuntime(locale);
    expect(runtime.t(messages, "common.start")).toBe("Démarrer");
    locale.set("zh-CN");
    expect(runtime.t(messages, "common.start")).toBe("开始");
    locale.set("en");
    expect(runtime.t(messages, "common.start")).toBe("Start");
    runtime.dispose();
  });

  it("falls back to English for a language it does not ship", () => {
    const runtime = new PluginTranslationRuntime(source("de"));
    expect(runtime.t(messages, "common.cancel")).toBe("Cancel");
    runtime.dispose();
  });

  it("fills placeholders in every language, leaving authored text untouched", () => {
    const locale = source("en");
    const runtime = new PluginTranslationRuntime(locale);
    const title = "Review {{x}} <b>";
    for (const lng of ["en", "fr", "zh-CN"]) {
      locale.set(lng);
      const text = runtime.t(messages, "form.startTitle", { title });
      expect(text).toContain(title);
      expect(text).not.toMatch(/\{\{title\}\}/);
    }
    runtime.dispose();
  });

  it("picks the plural form for the waiting count", () => {
    const locale = source("en");
    const runtime = new PluginTranslationRuntime(locale);
    expect([1, 3].map((count) => runtime.t(messages, "needsYou", { count }))).toEqual(["1 needs you", "3 need you"]);
    locale.set("fr");
    expect([1, 3].map((count) => runtime.t(messages, "needsYou", { count }))).toEqual(["1 attend votre décision", "3 attendent votre décision"]);
    locale.set("zh-CN");
    expect([1, 3].map((count) => runtime.t(messages, "needsYou", { count }))).toEqual(["1 项需要你处理", "3 项需要你处理"]);
    runtime.dispose();
  });

  it("resolves a registration title message in the current language", () => {
    const locale = source("fr");
    const runtime = new PluginTranslationRuntime(locale);
    expect(runtime.resolve(messages.message("openCommand"))).toBe("Ouvrir Playbooks");
    locale.set("zh-CN");
    expect(runtime.resolve(messages.message("headerWaiting"))).toContain("等待");
    runtime.dispose();
  });

  it("rejects a message with a missing placeholder value", () => {
    // @ts-expect-error the title is required
    expect(() => messages.message("form.startTitle", {})).toThrow(/Missing translation value/);
  });
});
