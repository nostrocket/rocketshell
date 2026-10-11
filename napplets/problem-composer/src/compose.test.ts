import { describe, expect, it } from "vitest";
import type { NostrEvent, RelayEventResult } from "@napplet/sdk";
import { CHILD_CONVENTION, buildProblemTemplate, createProblemId, normalizeProblemText, resolveParent } from "./compose";
import { isProblemIdPayload } from "./problem";

const hex = (char: string) => char.repeat(64);
const result = (event: Partial<NostrEvent> & Pick<NostrEvent, "id" | "pubkey" | "tags">): RelayEventResult => ({
  event: { kind: 31971, created_at: 1, content: "body", sig: hex("f"), ...event },
  sidecar: { relayHints: ["wss://relay.example"] }
});

describe("problem events", () => {
  it("uses the advertised problem-child convention", () => {
    expect(CHILD_CONVENTION).toBe("napplet:composer/problem-child");
  });

  it("generates a lowercase 32-byte id", () => {
    expect(createProblemId(new Uint8Array(32).fill(171))).toBe("ab".repeat(32));
  });

  it("builds a title-only problem while still requiring its title", () => {
    const text = normalizeProblemText("  Broken thing  ", "   \n");
    const template = buildProblemTemplate(hex("a"), hex("b"), {
      ...text, status: "open", maintainers: []
    }, 10);
    expect(template.tags).toContainEqual(["title", "Broken thing"]);
    expect(template.content).toBe("");
    expect(() => normalizeProblemText("  ", "Description")).toThrow("Add a problem title.");
  });

  it("validates exact child intent payloads", () => {
    expect(isProblemIdPayload({ problemId: hex("a") })).toBe(true);
    expect(isProblemIdPayload({ problemId: hex("a"), owner: hex("b") })).toBe(false);
    expect(isProblemIdPayload({ problemId: "no" })).toBe(false);
  });

  it("builds graph-root genesis tags", () => {
    const pubkey = hex("a");
    const id = hex("b");
    const template = buildProblemTemplate(pubkey, id, {
      title: "Broken thing", description: "Complete description", status: "open", maintainers: []
    }, 10);
    expect(template.tags).toContainEqual(["a", `31971:${pubkey}:${id}`, "", "origin"]);
    expect(template.tags).toContainEqual(["A", `31971:${pubkey}:${id}`, ""]);
    expect(template.tags.some((item) => item[0] === "E")).toBe(false);
    expect(template.tags).toContainEqual(["p", pubkey, "", "maintainer"]);
  });

  it("resolves a root parent and builds child graph tags", () => {
    const owner = hex("a");
    const parentId = hex("b");
    const parentEventId = hex("c");
    const parent = resolveParent(parentId, [result({
      id: parentEventId, pubkey: owner,
      tags: [["d", parentId], ["title", "Parent"], ["a", `31971:${owner}:${parentId}`, "", "origin"],
        ["A", `31971:${owner}:${parentId}`, ""], ["K", "31971"], ["P", owner, ""]]
    })]);
    const template = buildProblemTemplate(hex("d"), hex("e"), {
      title: "Child", description: "Details", status: "open", maintainers: []
    }, 10, parent);
    expect(template.tags).toContainEqual(["E", parentEventId, "wss://relay.example", owner]);
    expect(template.tags).toContainEqual(["e", parentEventId, "wss://relay.example", owner]);
    expect(template.tags).toContainEqual(["p", owner, "", "maintainer"]);
    expect(template.tags).toContainEqual(["p", hex("d"), "", "maintainer"]);
  });

  it("carries every parent ancestor into child maintainers", () => {
    const rootOwner = hex("a");
    const parentOwner = hex("b");
    const rootId = hex("c");
    const parentId = hex("d");
    const rootCoordinate = `31971:${rootOwner}:${rootId}`;
    const parentCoordinate = `31971:${parentOwner}:${parentId}`;
    const root = result({ id: hex("1"), pubkey: rootOwner, tags: [
      ["d", rootId], ["a", rootCoordinate, "", "origin"], ["A", rootCoordinate]
    ] });
    const parentEvent = result({ id: hex("2"), pubkey: parentOwner, tags: [
      ["d", parentId], ["a", parentCoordinate, "", "origin"], ["A", rootCoordinate], ["a", rootCoordinate]
    ] });
    const parent = resolveParent(parentId, [parentEvent, root]);
    const childOwner = hex("e");
    const template = buildProblemTemplate(childOwner, hex("f"), {
      title: "Child", description: "Details", status: "open", maintainers: []
    }, 10, parent);
    for (const maintainer of [childOwner, parentOwner, rootOwner]) {
      expect(template.tags).toContainEqual(["p", maintainer, "", "maintainer"]);
    }
  });

  it("rejects forked parent heads", () => {
    const owner = hex("a");
    const problemId = hex("b");
    const tags = [["d", problemId], ["a", `31971:${owner}:${problemId}`, "", "origin"]];
    expect(() => resolveParent(problemId, [
      result({ id: hex("c"), pubkey: owner, tags }), result({ id: hex("d"), pubkey: owner, tags })
    ])).toThrow("unresolved current heads");
  });

  it("selects newest logical-maintainer parent without complete ancestry", () => {
    const owner = hex("a");
    const parentOwner = hex("d");
    const problemId = hex("b");
    const coordinate = `31971:${owner}:${problemId}`;
    const tags = [["d", problemId], ["title", "Parent"], ["a", coordinate, "", "origin"], ["A", coordinate]];
    const genesis = result({ id: hex("c"), pubkey: owner, tags });
    const latest = result({ id: hex("e"), pubkey: parentOwner, created_at: 20,
      tags: [...tags, ["p", parentOwner], ["e", hex("f"), "", "previous", parentOwner]] });
    expect(resolveParent(problemId, [genesis, latest]).revisionId).toBe(latest.event.id);
  });
});
