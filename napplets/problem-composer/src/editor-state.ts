import type { ProblemMarkdownEditor } from "@platform/napplet-markdown-editor";

export function collectProblemFields(root: ParentNode): FormData {
  const data = new FormData();
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input[name], textarea[name], select[name]").forEach((control) => {
    if (!control.disabled) data.append(control.name, control.value);
  });
  return data;
}

export function resetProblemEditorFields(root: ParentNode, editor: ProblemMarkdownEditor, count: HTMLOutputElement): void {
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input[name], textarea[name], select[name]").forEach((control) => {
    if (control instanceof HTMLSelectElement) control.selectedIndex = 0;
    else control.value = "";
  });
  editor.setValue("");
  count.value = "0";
}
