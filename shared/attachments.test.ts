import { describe, expect, it } from "vitest";
import { attachmentKind, MAX_ATTACHMENTS, MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES, promptWithFiles, refusal } from "./attachments";

const file = (name: string, mimeType: string, size: number) => ({ name, mimeType, size });

describe("attachment rules", () => {
  it("sends png, jpeg, gif and webp as images and the rest as files", () => {
    expect(attachmentKind("image/png")).toBe("image");
    expect(attachmentKind("IMAGE/JPEG")).toBe("image");
    expect(attachmentKind("image/svg+xml")).toBe("file");
    expect(attachmentKind("application/pdf")).toBe("file");
  });

  it("accepts a normal image and file", () => {
    expect(refusal([], file("a.png", "image/png", 1000))).toBeNull();
    expect(refusal([], file("notes.md", "text/markdown", 1000))).toBeNull();
  });

  it("refuses empty, oversized, blocked and surplus attachments", () => {
    expect(refusal([], file("a.png", "image/png", 0))).toMatch(/empty/);
    expect(refusal([], file("a.png", "image/png", MAX_IMAGE_BYTES + 1))).toMatch(/limit/);
    expect(refusal([], file("a.txt", "text/plain", MAX_FILE_BYTES + 1))).toMatch(/limit/);
    expect(refusal([], file("setup.EXE", "application/octet-stream", 10))).toMatch(/not accepted/);
    expect(refusal(Array.from({ length: MAX_ATTACHMENTS }, () => file("a.txt", "text/plain", 1)), file("b.txt", "text/plain", 1))).toMatch(/At most/);
    expect(refusal([file("a.txt", "text/plain", MAX_TOTAL_BYTES - 5)], file("b.txt", "text/plain", 10))).toMatch(/in total/);
  });

  it("appends the saved paths to the text", () => {
    expect(promptWithFiles("hi", [])).toBe("hi");
    const text = promptWithFiles("look", [{ name: "a.pdf", path: "/tmp/x/a.pdf" }]);
    expect(text).toContain("look\n\nAttached files");
    expect(text).toContain("- a.pdf: /tmp/x/a.pdf");
    expect(promptWithFiles("", [{ name: "a.pdf", path: "/p" }]).startsWith("Attached files")).toBe(true);
  });
});
