import type { ParentOption } from "./revise";

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);

export const parentCoordinatesFromEditor = (scope: ParentNode = document): string[] =>
  [...scope.querySelectorAll<HTMLElement>("[data-parent-coordinate]")]
    .map((node) => node.dataset.parentCoordinate ?? "");

const shortId = (coordinate: string) => {
  const id = coordinate.split(":")[2] ?? "";
  return `${id.slice(0, 8)}…${id.slice(-5)}`;
};

const optionByCoordinate = (options: ParentOption[]) => new Map(options.map((option) => [option.coordinate, option]));

export function renderParentRows(coordinates: string[], canChange: boolean, options: ParentOption[] = []): string {
  if (!coordinates.length) return '<p class="parent-empty">No direct parents in this draft.</p>';
  const labels = optionByCoordinate(options);
  return coordinates.map((coordinate) => {
    const title = labels.get(coordinate)?.title ?? "Unavailable problem";
    return `<div class="parent-row" data-parent-coordinate="${coordinate}">
    <span><strong>${escapeHtml(title)}</strong><code title="${coordinate}">${shortId(coordinate)}</code></span>
    ${canChange ? `<button type="button" class="remove-parent" aria-label="Remove ${escapeHtml(title)} as parent">Remove</button>` : ""}
  </div>`;
  }).join("");
}

export function renderParentOptions(options: ParentOption[], selected: string[]): string {
  const available = options.filter((option) => !selected.includes(option.coordinate));
  return `<option value="">${available.length ? "Choose a problem…" : "No other valid problems available"}</option>${available
    .map((option) => `<option value="${option.coordinate}">${escapeHtml(option.title)} · ${shortId(option.coordinate)}</option>`)
    .join("")}`;
}

export function bindParentEditor(
  canChange: boolean,
  options: ParentOption[],
  onStatus: (message: string, error?: boolean) => void,
  scope: ParentNode = document
): void {
  const list = scope.querySelector<HTMLElement>("#parent-list");
  const select = scope.querySelector<HTMLSelectElement>("#parent-choice");
  const add = scope.querySelector<HTMLButtonElement>("#add-parent");
  if (!list || !select || !add || !canChange) return;
  const repaint = (coordinates: string[]) => {
    list.innerHTML = renderParentRows(coordinates, true, options);
    select.innerHTML = renderParentOptions(options, coordinates);
    select.disabled = options.every((option) => coordinates.includes(option.coordinate));
    add.disabled = select.disabled;
    list.querySelectorAll<HTMLButtonElement>(".remove-parent").forEach((button) => button.addEventListener("click", () => {
      const coordinate = button.closest<HTMLElement>("[data-parent-coordinate]")?.dataset.parentCoordinate;
      if (!coordinate) return;
      repaint(parentCoordinatesFromEditor(scope).filter((value) => value !== coordinate));
      select.focus();
    }));
  };
  const addParent = () => {
    const coordinate = select.value;
    if (!coordinate) {
      onStatus("Choose a problem to add as parent.", true);
      select.focus();
      return;
    }
    const existing = parentCoordinatesFromEditor(scope);
    if (existing.includes(coordinate)) {
      onStatus("That direct parent is already listed.", true);
      select.focus();
      return;
    }
    repaint([...existing, coordinate]);
    select.value = "";
    onStatus("Parent draft updated. Publish revision to apply it.");
    select.focus();
  };
  repaint(parentCoordinatesFromEditor(scope));
  add.addEventListener("click", addParent);
  select.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addParent();
  });
}
