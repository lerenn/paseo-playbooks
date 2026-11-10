import { describe, expect, it, vi } from "vitest";
import { createSidekickUiStore, resolveSelected } from "./ui-state";

describe("sidekick ui store", () => {
  it("keeps open, tab, added projects, clamped width and drafts, and notifies on change only", () => {
    const store = createSidekickUiStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setOpen(true);
    store.setOpen(true);
    store.select("shop");
    store.addProject("blog");
    store.addProject("blog");
    store.setWidth(5000);
    store.setDraft("shop", "hello");
    expect(store.get()).toMatchObject({ open: true, selectedProjectId: "shop", added: ["blog"], width: 800, drafts: { shop: "hello" } });
    expect(listener).toHaveBeenCalledTimes(5);
    store.setDraft("shop", "");
    expect(store.get().drafts).toEqual({});
  });
  it("resets a vanished tab to the first", () => {
    expect(resolveSelected("a", ["a", "b"])).toBe("a");
    expect(resolveSelected("gone", ["a", "b"])).toBe("a");
    expect(resolveSelected("x", [])).toBeNull();
  });
});
