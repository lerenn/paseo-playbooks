import { describe, expect, it } from "vitest";
import { headerParts } from "./panel-header-view";

describe("headerParts", () => {
  it("shows icon, title and tagline on a wide screen", () => {
    expect(headerParts({ compact: false, dismissed: false })).toEqual({ visible: true, tagline: true });
  });
  it("drops the tagline on a compact screen", () => {
    expect(headerParts({ compact: true, dismissed: false })).toEqual({ visible: true, tagline: false });
  });
  it("hides everything once dismissed", () => {
    expect(headerParts({ compact: false, dismissed: true }).visible).toBe(false);
  });
});
