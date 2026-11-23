import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A guard, not a proof: it flags the obvious ways to leave user-facing English in a component, a
 * JSX text child (`>Some text<`) and a literal text attribute (`label="Some text"`). Text that
 * goes through `t(...)`, names of icons and identifiers are not matched. A string built in a
 * helper or a ternary is outside what it can see.
 */
const FILES = ["client", "client/sidekick"].flatMap((dir) => readdirSync(dir).filter((name) => name.endsWith(".tsx")).map((name) => join(dir, name)));
const TEXT_ATTRIBUTES = /\b(?:label|placeholder|accessibilityLabel|accessibilityHint|title|hint|description)="([^"]*[A-Za-z]{2}[^"]*)"/g;
const JSX_TEXT = /(?<![=\-\w)])>\s*([A-Za-z][^<>{}=;]*[a-z][^<>{}=;]*?)\s*<\/?[A-Za-z]/g;

/** Literals that are not prose: the plus of an add button, a symbol, an abbreviation, the names of the plugin and of the Sidekick feature. */
const ALLOWED = new Set<string>(["+", "Playbooks", "Sidekick"]);

function findings(path: string): string[] {
  const found: string[] = [];
  readFileSync(path, "utf8").split("\n").forEach((line, index) => {
    const code = line.trim();
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*") || code.startsWith("import ")) return;
    for (const match of line.matchAll(TEXT_ATTRIBUTES)) if (!ALLOWED.has(match[1]!)) found.push(`${path}:${index + 1}: ${match[0]}`);
    for (const match of line.matchAll(JSX_TEXT)) if (!ALLOWED.has(match[1]!) && /^[A-Z]/.test(match[1]!) && /[a-z]{2}/.test(match[1]!)) found.push(`${path}:${index + 1}: >${match[1]}<`);
  });
  return found;
}

describe("user-facing text stays in the catalogue", () => {
  it("has no literal English text in a component", () => {
    expect(FILES.flatMap(findings)).toEqual([]);
  });
});
