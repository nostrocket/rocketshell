// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ProblemMarkdownEditor } from "@platform/napplet-markdown-editor";
import { collectProblemFields, resetProblemEditorFields } from "./editor-state";

describe("new-problem editor state", () => {
  it("collects scripted controls and resets published Markdown", () => {
    const root = document.createElement("div");
    root.innerHTML = '<input name="title" value="Broken flow"><select name="status"><option value="open">Open</option><option value="draft" selected>Draft</option></select><input name="ignored" value="x" disabled><output>24</output>';
    let markdown = "unfinished **detail**";
    const editor: ProblemMarkdownEditor = {
      getValue: () => markdown, setValue: vi.fn((value) => { markdown = value; }), insertMarkdown: () => undefined,
      focus: () => undefined, setDisabled: () => undefined, isDirtyComparedWith: (value) => markdown !== value, destroy: () => undefined
    };
    const data = collectProblemFields(root);
    expect(data.get("title")).toBe("Broken flow");
    expect(data.get("status")).toBe("draft");
    expect(data.has("ignored")).toBe(false);
    const count = root.querySelector("output") as HTMLOutputElement;
    resetProblemEditorFields(root, editor, count);
    expect(editor.setValue).toHaveBeenCalledWith("");
    expect(markdown).toBe("");
    expect(root.querySelector<HTMLInputElement>('[name="title"]')?.value).toBe("");
    expect(root.querySelector<HTMLSelectElement>('[name="status"]')?.value).toBe("open");
    expect(count.value).toBe("0");
  });
});
