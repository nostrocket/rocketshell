import type { ProblemMarkdownEditor } from "@platform/napplet-markdown-editor";

export function applyEditorAccessState(
  mayEdit: boolean,
  busy: boolean,
  editor: ProblemMarkdownEditor | undefined,
  scope: ParentNode = document
): string {
  const disabled = !mayEdit || busy;
  editor?.setDisabled(disabled);
  scope.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("#title, #problem-status, #child-status, #attachment, [data-editor-media]").forEach((control) => { control.disabled = disabled; });
  const publishButton = scope.querySelector<HTMLButtonElement>("#publish");
  if (publishButton) publishButton.disabled = disabled;
  const authority = scope.querySelector<HTMLElement>(".authority");
  if (authority) {
    authority.className = `authority ${mayEdit ? "allowed" : "denied"}`;
    authority.textContent = mayEdit ? "Authorized editor" : "Read-only identity";
  }
  return mayEdit ? "Identity updated. Draft preserved." : "Identity changed. Draft preserved read-only.";
}
