import { describe, expect, it } from "vitest";
import { SEMANTIC_DARK, SEMANTIC_LIGHT, semanticColor, semanticOn, type SemanticTone } from "./semantic-colors";
import { runStatusColor, runStatusTone, nodeColor, type Theme } from "./theme";

const TONES: SemanticTone[] = ["running", "waiting", "done", "failed", "paused"];

function theme(surface1: string, accent: string): Theme {
  return {
    colors: { surface0: surface1, surface1, surface2: surface1, border: "#888888", foreground: "#ffffff", foregroundMuted: "#999999", accent, accentForeground: "#ffffff", statusSuccess: accent, statusWarning: accent, statusDanger: accent },
  };
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [16, 8, 0].map((s) => ((n >> s) & 255) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("semantic colours", () => {
  it("ignore the theme's own accent and status colours", () => {
    const green = theme("#18181b", "#00ff00");
    const blue = theme("#18181b", "#0000ff");
    for (const tone of TONES) expect(semanticColor(green, tone)).toBe(semanticColor(blue, tone));
    expect(runStatusColor(green, "running")).not.toBe(runStatusColor(green, "completed"));
  });

  it("follow only the light or dark flag", () => {
    expect(semanticColor(theme("#18181b", "#fff"), "running")).toBe(SEMANTIC_DARK.running.color);
    expect(semanticColor(theme("#ffffff", "#fff"), "running")).toBe(SEMANTIC_LIGHT.running.color);
    expect(semanticOn(theme("#ffffff", "#fff"), "failed")).toBe(SEMANTIC_LIGHT.failed.on);
  });

  it("gives every tone its own colour", () => {
    for (const palette of [SEMANTIC_DARK, SEMANTIC_LIGHT]) expect(new Set(TONES.map((t) => palette[t].color)).size).toBe(TONES.length);
  });

  it("keeps the hues: running blue, done green, failed red, paused violet, waiting orange", () => {
    const hue = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      const max = Math.max(r, g, b);
      const d = max - Math.min(r, g, b);
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    for (const palette of [SEMANTIC_DARK, SEMANTIC_LIGHT]) {
      expect(hue(palette.running.color)).toBeGreaterThan(200);
      expect(hue(palette.running.color)).toBeLessThan(240);
      expect(hue(palette.done.color)).toBeGreaterThan(130);
      expect(hue(palette.done.color)).toBeLessThan(160);
      expect(hue(palette.waiting.color)).toBeGreaterThan(20);
      expect(hue(palette.waiting.color)).toBeLessThan(45);
      expect(hue(palette.paused.color)).toBeGreaterThan(250);
      expect(hue(palette.paused.color)).toBeLessThan(270);
      const failed = hue(palette.failed.color);
      expect(failed < 10 || failed > 350).toBe(true);
    }
  });

  it("stays readable on the usual panel surfaces", () => {
    for (const tone of TONES) {
      for (const surface of ["#101012", "#18181b", "#222226", "#2c2c31"]) expect(contrast(SEMANTIC_DARK[tone].color, surface)).toBeGreaterThanOrEqual(4.5);
      for (const surface of ["#ffffff", "#f5f5f4", "#ebebe9"]) expect(contrast(SEMANTIC_LIGHT[tone].color, surface)).toBeGreaterThanOrEqual(4.2);
      for (const surface of ["#e0e0de"]) expect(contrast(SEMANTIC_LIGHT[tone].color, surface)).toBeGreaterThanOrEqual(3.5);
      expect(contrast(SEMANTIC_DARK[tone].color, SEMANTIC_DARK[tone].on)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(SEMANTIC_LIGHT[tone].color, SEMANTIC_LIGHT[tone].on)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("maps the states to the same tones as before", () => {
    expect(runStatusTone("running")).toBe("running");
    expect(runStatusTone("completed")).toBe("done");
    expect(runStatusTone("failed")).toBe("failed");
    expect(runStatusTone("canceled")).toBe("failed");
    expect(runStatusTone("waiting_gate")).toBe("waiting");
    expect(runStatusTone("boarding")).toBe("waiting");
    const t = theme("#18181b", "#fff");
    expect(nodeColor(t, "needs_permission")).toBe(semanticColor(t, "waiting"));
    expect(nodeColor(t, "running")).toBe(semanticColor(t, "running"));
  });
});
