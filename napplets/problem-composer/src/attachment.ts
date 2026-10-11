/** Direct Markdown media reference shared by both composer modes. */
export function attachmentMarkdown(url: string, caption: string): string {
  const cleanUrl = url.trim();
  if (!/^https:\/\/[^\s)]+$/.test(cleanUrl)) throw new Error("Upload returned an invalid media URL.");
  const alt = caption.trim().replace(/\[/g, "(").replace(/\]/g, ")") || "Attached media";
  return `![${alt}](${cleanUrl})`;
}

export function insertAtSelection(input: HTMLTextAreaElement, value: string): void {
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const prefix = before && !before.endsWith("\n") ? "\n\n" : "";
  const suffix = after && !after.startsWith("\n") ? "\n\n" : "";
  input.setRangeText(`${prefix}${value}${suffix}`, start, end, "end");
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
