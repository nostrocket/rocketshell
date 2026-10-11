import { describe, expect, it } from "vitest";
import { attachmentMarkdown } from "./attachment";

describe("attachmentMarkdown", () => {
  it("creates a direct Markdown media reference", () => {
    expect(attachmentMarkdown("https://blossom.example/abc", "Screen ] shot"))
      .toBe("![Screen ) shot](https://blossom.example/abc)");
  });

  it("rejects unusable upload URLs", () => {
    expect(() => attachmentMarkdown("javascript:alert(1)", "bad")).toThrow("invalid media URL");
  });
});
