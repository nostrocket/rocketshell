/*
  Shared shell-facing editor plumbing for both composer modes:
  - mount the rich Markdown editor, degrade to the plain fallback on failure
  - run a NAP-UPLOAD media upload and insert the returned URL as Markdown
*/
import { upload } from "@napplet/sdk";
import { createPlainMarkdownEditorFallback, createProblemMarkdownEditor, type ProblemMarkdownEditor } from "@platform/napplet-markdown-editor";
import { attachmentMarkdown } from "./attachment";

export type EditorErrorReporter = (operation: string, error: unknown, details?: Readonly<Record<string, string>>) => void;

export interface FallbackEditorOptions {
  /** Status line that receives the degraded notice and anchors the fallback button. */
  status: HTMLElement | null;
  /** Mark the fallback media button so access-state helpers can find it. */
  markMediaButton?: boolean;
  disabled?: boolean;
}

export interface MountProblemEditorOptions {
  host: HTMLElement;
  value: string;
  disabled?: boolean;
  ariaLabel: string;
  placeholder: string;
  uploadAvailable: boolean;
  onAddMedia?: () => void;
  onChange: (value: string) => void;
  onError: EditorErrorReporter;
  fallback: FallbackEditorOptions;
}

export function mountProblemEditor(options: MountProblemEditorOptions): ProblemMarkdownEditor {
  const { host, value, disabled, ariaLabel, placeholder, uploadAvailable, onAddMedia, onChange, onError, fallback } = options;
  const disabledOption = disabled === undefined ? {} : { disabled };
  try {
    return createProblemMarkdownEditor({
      parent: host, value, ...disabledOption, ariaLabel, placeholder,
      ...(onAddMedia ? { onAddMedia } : {}), onChange, onError
    });
  } catch (error) {
    onError("initialize", error);
    const button = document.createElement("button");
    button.type = "button";
    if (fallback.markMediaButton) button.dataset.editorMedia = "true";
    button.textContent = "Add image or video";
    button.disabled = (fallback.disabled ?? disabled ?? false) || !uploadAvailable;
    if (onAddMedia) button.addEventListener("click", onAddMedia);
    if (fallback.status) {
      fallback.status.before(button);
      fallback.status.textContent = "Rich editor unavailable. Plain Markdown editing remains available.";
    }
    return createPlainMarkdownEditorFallback({
      parent: host, value, ...disabledOption, ariaLabel, placeholder, onChange
    });
  }
}

/** Caption derived from the uploaded filename. */
export function attachmentCaption(file: File): string {
  return file.name.replace(/\.[^.]+$/, "") || "Attached media";
}

/** Upload one file through shell-owned Blossom storage, returning its HTTPS URL. */
export async function uploadAttachmentFile(file: File): Promise<string> {
  const result = await upload.upload({ data: file, filename: file.name, mimeType: file.type || undefined });
  if (!result.ok || result.status !== "complete" || !result.url) throw new Error(result.error ?? "Media upload did not complete.");
  return result.url;
}

/** Upload and insert a Markdown media reference at the editor selection. */
export async function insertUploadedMedia(file: File, editor: ProblemMarkdownEditor): Promise<void> {
  const url = await uploadAttachmentFile(file);
  editor.insertMarkdown(attachmentMarkdown(url, attachmentCaption(file)));
}
