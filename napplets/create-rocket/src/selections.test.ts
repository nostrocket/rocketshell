import { describe, expect, it, vi } from "vitest";
import { problemChoices, repositoryChoices, ROOT_PROBLEM_COORDINATE, type ChoiceResult } from "./selections";

const owner = "a".repeat(64);
const problemId = "b".repeat(64);
const rootOwner = ROOT_PROBLEM_COORDINATE.split(":")[1]!;
const rootId = ROOT_PROBLEM_COORDINATE.split(":")[2]!;
const result = (changes: Partial<ChoiceResult["event"]> = {}, relayHints?: string[]): ChoiceResult => ({
  event: { id: "1".repeat(64), pubkey: owner, kind: 31971, created_at: 1, content: "Problem body", tags: [
    ["d", problemId], ["title", "Problem title"], ["a", `31971:${owner}:${problemId}`, "wss://origin.example", "origin"], ["A", ROOT_PROBLEM_COORDINATE]
  ], ...changes },
  ...(relayHints ? { sidecar: { relayHints } } : {})
});

describe("rocket reference choices", () => {
  const root = () => result({ id: "9".repeat(64), pubkey: rootOwner, tags: [
    ["d", rootId], ["title", "Root"], ["a", ROOT_PROBLEM_COORDINATE, "wss://root.example", "origin"], ["A", ROOT_PROBLEM_COORDINATE]
  ] });

  it("uses same configured root as problem DAG viewer", () => {
    expect(ROOT_PROBLEM_COORDINATE).toBe("31971:d91191e30e00444b942c0e82cad470b32af171764c2275bee0bd99377efd4075:7cff61a9f7565ed63c1213040fe0f39c7f2ee1dd4fb96a41e95de049a8dcc170");
  });

  it("shows current problem heads in root-to-leaf order", () => {
    const previous = result({ tags: [...result().event.tags, ["a", ROOT_PROBLEM_COORDINATE]] });
    const current = result({ id: "2".repeat(64), created_at: 2, content: "Current body", tags: [
      ["d", problemId], ["title", "Current title"], ["a", `31971:${owner}:${problemId}`, "wss://origin.example", "origin"], ["A", ROOT_PROBLEM_COORDINATE], ["a", ROOT_PROBLEM_COORDINATE],
      ["e", previous.event.id, "", "previous"]
    ] }, ["wss://seen.example"]);
    const grandchildOwner = "c".repeat(64);
    const grandchildId = "d".repeat(64);
    const grandchild = result({ id: "3".repeat(64), pubkey: grandchildOwner, tags: [
      ["d", grandchildId], ["title", "Grandchild"], ["a", `31971:${grandchildOwner}:${grandchildId}`, "", "origin"],
      ["A", ROOT_PROBLEM_COORDINATE], ["a", `31971:${owner}:${problemId}`]
    ] });
    expect(problemChoices([grandchild, current, root(), previous])).toEqual([
      expect.objectContaining({ coordinate: ROOT_PROBLEM_COORDINATE, title: "Root", depth: 0 }),
      { coordinate: `31971:${owner}:${problemId}`, relay: "wss://seen.example", title: "Current title", summary: "Current body", createdAt: 2, depth: 1 },
      { coordinate: `31971:${grandchildOwner}:${grandchildId}`, relay: "", title: "Grandchild", summary: "Problem body", createdAt: 1, depth: 2 }
    ]);
  });

  it("excludes malformed, wrong-root, and disconnected problems", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const child = result({ tags: [...result().event.tags, ["a", ROOT_PROBLEM_COORDINATE]] });
    const disconnected = result({ id: "4".repeat(64), pubkey: "c".repeat(64), tags: [
      ["d", "d".repeat(64)], ["a", `31971:${"c".repeat(64)}:${"d".repeat(64)}`, "", "origin"], ["A", ROOT_PROBLEM_COORDINATE]
    ] });
    const wrongRoot = result({ id: "5".repeat(64), tags: [...result().event.tags.filter((item) => item[0] !== "A"), ["A", `31971:${owner}:${problemId}`]] });
    expect(problemChoices([root(), child, disconnected, wrongRoot], ["not-a-relay", "wss://fallback.example"]).map((choice) => choice.coordinate)).toEqual([
      ROOT_PROBLEM_COORDINATE, `31971:${owner}:${problemId}`
    ]);
    expect(problemChoices([root(), child], ["not-a-relay", "wss://fallback.example"])[1]?.relay).toBe("wss://origin.example");
    expect(warn).toHaveBeenCalledWith("Rocket reference relay hint validation failed", expect.objectContaining({ value: "not-a-relay" }));
    warn.mockRestore();
  });

  it("collapses repository replacements and derives labels", () => {
    const oldRepo = result({ kind: 30617, id: "3".repeat(64), created_at: 1, content: "", tags: [["d", "rocket"], ["name", "Old name"]] });
    const currentRepo = result({ kind: 30617, id: "4".repeat(64), created_at: 3, content: "", tags: [["d", "rocket"], ["name", "Rocket engine"], ["description", "Build rockets"]] }, ["wss://git.example"]);
    expect(repositoryChoices([oldRepo, currentRepo], owner)).toEqual([{
      coordinate: `30617:${owner}:rocket`, relay: "wss://git.example", title: "Rocket engine", summary: "Build rockets", createdAt: 3
    }]);
  });

  it("keeps long and unusual display text bounded", () => {
    const choice = repositoryChoices([result({ kind: 30617, tags: [["d", "repo"], ["name", "مستودع 🚀"], ["description", `  ${"x ".repeat(200)}`]] })], owner)[0]!;
    expect(choice.title).toBe("مستودع 🚀");
    expect([...choice.summary].length).toBe(180);
  });

  it("includes independent and local root problems without requiring hardcoded nostrocket root", () => {
    const localOwner = "e".repeat(64);
    const localId = "f".repeat(64);
    const localCoord = `31971:${localOwner}:${localId}`;
    const localProblem = result({
      id: "7".repeat(64),
      pubkey: localOwner,
      tags: [
        ["d", localId],
        ["title", "Local problem"],
        ["a", localCoord, "wss://local.example", "origin"],
        ["A", localCoord]
      ]
    });
    const choices = problemChoices([localProblem]);
    expect(choices).toEqual([
      { coordinate: localCoord, relay: "wss://local.example", title: "Local problem", summary: "Problem body", createdAt: 1, depth: 0 }
    ]);
  });
});
