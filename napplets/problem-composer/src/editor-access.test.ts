// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ProblemMarkdownEditor } from "@platform/napplet-markdown-editor";
import { applyEditorAccessState } from "./editor-access";

describe("identity access changes", () => {
  it("preserves dirty Markdown while switching editor read-only", () => {
    const host = document.createElement("div");
    host.innerHTML = '<input id="title"><select id="problem-status"></select><button id="publish"></button><button data-editor-media></button><span class="authority"></span>';
    let draft = "unfinished local Markdown";
    const editor: ProblemMarkdownEditor = {
      getValue: () => draft, setValue: (value) => { draft = value; }, insertMarkdown: () => undefined,
      focus: () => undefined, setDisabled: vi.fn(), isDirtyComparedWith: (value) => draft !== value, destroy: () => undefined
    };
    const message = applyEditorAccessState(false, false, editor, host);
    expect(editor.getValue()).toBe("unfinished local Markdown");
    expect(editor.setDisabled).toHaveBeenCalledWith(true);
    expect(host.querySelector<HTMLInputElement>("#title")?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("[data-editor-media]")?.disabled).toBe(true);
    expect(message).toContain("Draft preserved");
    applyEditorAccessState(true, false, editor, host);
    expect(editor.getValue()).toBe("unfinished local Markdown");
    expect(editor.setDisabled).toHaveBeenLastCalledWith(false);
    expect(host.querySelector<HTMLButtonElement>("[data-editor-media]")?.disabled).toBe(false);
  });
});
