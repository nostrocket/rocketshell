// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { bindParentEditor, parentCoordinatesFromEditor, renderParentOptions, renderParentRows } from "./parent-editor";
import type { ParentOption } from "./revise";

const coordinate = (owner: string, id: string) => `31971:${owner.repeat(64)}:${id.repeat(64)}`;

const choices: ParentOption[] = [
  { coordinate: coordinate("a", "b"), title: "Alpha problem" },
  { coordinate: coordinate("c", "d"), title: "Beta problem" },
  { coordinate: coordinate("e", "f"), title: "Gamma problem" }
];

const mount = (parents: string[] = []) => {
  const host = document.createElement("div");
  host.innerHTML = `<div id="parent-list">${renderParentRows(parents, true, choices)}</div><select id="parent-choice">${renderParentOptions(choices, parents)}</select><button id="add-parent" type="button">Add parent</button>`;
  const onStatus = vi.fn();
  bindParentEditor(true, choices, onStatus, host);
  return { host, select: host.querySelector<HTMLSelectElement>("#parent-choice")!, onStatus };
};

describe("direct parent editor", () => {
  it("adds with pointer and removes with pointer", () => {
    const { host, select } = mount();
    select.value = coordinate("a", "b");
    host.querySelector<HTMLButtonElement>("#add-parent")!.click();
    expect(parentCoordinatesFromEditor(host)).toEqual([coordinate("a", "b")]);
    expect(host.querySelector(".parent-row strong")?.textContent).toBe("Alpha problem");
    host.querySelector<HTMLButtonElement>(".remove-parent")!.click();
    expect(parentCoordinatesFromEditor(host)).toEqual([]);
  });

  it("adds on Enter without form submission", () => {
    const { host, select } = mount();
    select.value = coordinate("c", "d");
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    select.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(parentCoordinatesFromEditor(host)).toEqual([coordinate("c", "d")]);
  });

  it("requires a selection and removes chosen parents from dropdown", () => {
    const existing = coordinate("e", "f");
    const { host, select, onStatus } = mount([existing]);
    host.querySelector<HTMLButtonElement>("#add-parent")!.click();
    expect(parentCoordinatesFromEditor(host)).toEqual([existing]);
    expect([...select.options].some((option) => option.value === existing)).toBe(false);
    expect(onStatus).toHaveBeenCalledOnce();
  });
});
