import { describe, expect, it } from "vitest";
import type { NostrEvent, RelayEventResult } from "@napplet/sdk";
import { EDIT_CONVENTION, buildRevisionTemplate, resolveParentChange, selectableParentOptions, selectEditableProblem } from "./revise";
import { hasProblemChildren, isProblemIdPayload } from "./problem";

const hex = (char: string) => char.repeat(64);
const owner = hex("a");
const problemId = hex("b");
const event = (id: string, pubkey = owner, extra: string[][] = []): NostrEvent => ({
  id, pubkey, kind: 31971, created_at: 10, content: "Old body", sig: hex("f"),
  tags: [["d", problemId], ["title", "Old title"], ["status", "open"],
    ["a", `31971:${owner}:${problemId}`, "wss://relay.example", "origin"],
    ["A", `31971:${owner}:${problemId}`, "wss://relay.example"], ["K", "31971"], ["P", owner, "wss://relay.example"], ...extra]
});
const result = (nostrEvent: NostrEvent): RelayEventResult => ({ event: nostrEvent, sidecar: { relayHints: ["wss://relay.example"] } });

describe("problem editor", () => {
  it("uses stable composer edit convention", () => expect(EDIT_CONVENTION).toBe("napplet:composer/problem-edit"));

  it("accepts only exact problem-id payload", () => {
    expect(isProblemIdPayload({ problemId })).toBe(true);
    expect(isProblemIdPayload({ problemId, owner })).toBe(false);
    expect(isProblemIdPayload({ problemId: "bad" })).toBe(false);
  });

  it("selects only head and grants listed maintainer", () => {
    const genesis = event(hex("c"), owner, [["p", hex("d"), "", "maintainer"]]);
    const revision = event(hex("e"), hex("d"), [["p", hex("d"), "", "maintainer"], ["e", genesis.id, "", "genesis", owner], ["e", genesis.id, "", "previous", owner]]);
    expect(selectEditableProblem(problemId, [result(genesis), result(revision)], hex("d")).event.id).toBe(revision.id);
  });

  it("grants direct parent owner permissions", () => {
    const parentOwner = hex("d");
    const parentId = hex("e");
    const parentCoordinate = `31971:${parentOwner}:${parentId}`;
    const parent = result({ ...event(hex("1"), parentOwner), tags: [
      ["d", parentId], ["title", "Parent"], ["status", "open"],
      ["a", parentCoordinate, "", "origin"], ["A", parentCoordinate], ["K", "31971"], ["P", parentOwner]
    ] });
    const child = event(hex("c"), owner, [["a", parentCoordinate], ["p", parentOwner, "wss://parent.example"]]);
    expect(selectEditableProblem(problemId, [result(child), parent], parentOwner).mayEdit).toBe(true);
    expect(selectEditableProblem(problemId, [result(child), parent], hex("f")).mayEdit).toBe(false);
  });

  it("grants every resolved ancestor owner permissions", () => {
    const rootOwner = hex("d");
    const parentOwner = hex("e");
    const rootId = hex("1");
    const parentId = hex("2");
    const rootCoordinate = `31971:${rootOwner}:${rootId}`;
    const parentCoordinate = `31971:${parentOwner}:${parentId}`;
    const root = result({ ...event(hex("3"), rootOwner), tags: [
      ["d", rootId], ["a", rootCoordinate, "", "origin"], ["A", rootCoordinate]
    ] });
    const parent = result({ ...event(hex("4"), parentOwner), tags: [
      ["d", parentId], ["a", parentCoordinate, "", "origin"], ["A", rootCoordinate], ["a", rootCoordinate]
    ] });
    const child = result(event(hex("5"), owner, [["A", rootCoordinate], ["a", parentCoordinate]]));
    const problem = selectEditableProblem(problemId, [child, parent, root], rootOwner);
    expect(problem.mayEdit).toBe(true);
    expect(problem.ancestorOwners).toEqual([rootOwner, parentOwner].sort());
  });

  it("builds full revision lineage and preserves graph tags", () => {
    const problem = selectEditableProblem(problemId, [result(event(hex("c")))], owner);
    const template = buildRevisionTemplate(problem, { title: "New title", description: "New body", status: "big", childStatus: "open" }, 20);
    expect(template.tags).toContainEqual(["e", hex("c"), "wss://relay.example", "genesis", owner]);
    expect(template.tags).toContainEqual(["e", hex("c"), "wss://relay.example", "previous", owner]);
    expect(template.tags).toContainEqual(["A", `31971:${owner}:${problemId}`, "wss://relay.example"]);
    expect(template.tags).toContainEqual(["child_status", "open"]);
  });

  it("allows an empty problem description", () => {
    const problem = selectEditableProblem(problemId, [result(event(hex("c")))], owner);
    const template = buildRevisionTemplate(problem, {
      title: "Title only", description: "  \n", status: "open"
    }, 20);
    expect(template.content).toBe("");
  });

  it("adds owner and resolved ancestor owners as maintainers on owner edit", () => {
    const parentOwner = hex("d");
    const existingMaintainer = hex("e");
    const parentId = hex("1");
    const parentCoordinate = `31971:${parentOwner}:${parentId}`;
    const parent = result({ ...event(hex("2"), parentOwner), tags: [
      ["d", parentId], ["a", parentCoordinate, "", "origin"], ["A", parentCoordinate]
    ] });
    const problem = selectEditableProblem(problemId, [result(event(hex("c"), owner, [
      ["a", parentCoordinate],
      ["p", parentOwner, "wss://parent.example"],
      ["p", existingMaintainer, "", "maintainer"]
    ])), parent], owner);
    const template = buildRevisionTemplate(problem, { title: "New title", description: "New body", status: "open" }, 20);
    expect(template.tags).toContainEqual(["p", owner, "", "maintainer"]);
    expect(template.tags).toContainEqual(["p", parentOwner, "", "maintainer"]);
    expect(template.tags).toContainEqual(["p", existingMaintainer, "", "maintainer"]);
    expect(template.tags.filter((item) => item[0] === "p" && item[1] === parentOwner && item[3] === "maintainer")).toHaveLength(1);
  });

  it("preserves maintainer list unchanged on non-owner edit", () => {
    const parentOwner = hex("d");
    const problem = selectEditableProblem(problemId, [result(event(hex("c"), owner, [
      ["p", parentOwner, "wss://parent.example"]
    ]))], parentOwner);
    const template = buildRevisionTemplate(problem, { title: "New title", description: "New body", status: "open" }, 20);
    expect(template.tags).not.toContainEqual(["p", owner, "", "maintainer"]);
    expect(template.tags).not.toContainEqual(["p", parentOwner, "", "maintainer"]);
  });

  it("rejects forked heads", () => {
    expect(() => selectEditableProblem(problemId, [result(event(hex("c"))), result(event(hex("d")))], owner)).toThrow("unresolved current heads");
  });

  it("selects newest logical-maintainer head without complete ancestry", () => {
    const parentOwner = hex("d");
    const genesis = result(event(hex("c")));
    const latest = result({ ...event(hex("e"), parentOwner, [
      ["p", parentOwner], ["e", hex("f"), "", "previous", parentOwner]
    ]), created_at: 20, content: "Latest body" });
    expect(selectEditableProblem(problemId, [genesis, latest], owner).event.id).toBe(latest.event.id);
  });

  it("forces owner edits to children when current children exist", () => {
    const problem = selectEditableProblem(problemId, [result(event(hex("c")))], owner);
    const template = buildRevisionTemplate(problem, { title: "New title", description: "New body", status: "open" }, 20, true);
    expect(template.tags).toContainEqual(["status", "children"]);
    expect(template.tags).not.toContainEqual(["status", "open"]);
  });

  it("does not override maintainer-selected status", () => {
    const maintainer = hex("d");
    const problem = selectEditableProblem(problemId, [result(event(hex("c"), owner, [["p", maintainer, "", "maintainer"]]))], maintainer);
    const template = buildRevisionTemplate(problem, { title: "New title", description: "New body", status: "open" }, 20, true);
    expect(template.tags).toContainEqual(["status", "open"]);
  });

  it("counts only current direct child heads", () => {
    const childId = hex("d");
    const childCoordinate = `31971:${hex("e")}:${childId}`;
    const child = (id: string, previous?: string, parent = `31971:${owner}:${problemId}`) => result({
      ...event(id, hex("e")), tags: [["d", childId], ["a", childCoordinate, "", "origin"], ["a", parent],
        ...(previous ? [["e", previous, "", "previous"]] : [])]
    });
    const genesis = child(hex("1"));
    expect(hasProblemChildren(`31971:${owner}:${problemId}`, [genesis])).toBe(true);
    expect(hasProblemChildren(`31971:${owner}:${problemId}`, [genesis, child(hex("2"), hex("1"), `31971:${owner}:${hex("0")}`)])).toBe(false);
  });

  describe("direct parent changes", () => {
    const rootOwner = hex("1");
    const rootId = hex("2");
    const parentOwner = hex("3");
    const parentId = hex("4");
    const rootCoordinate = `31971:${rootOwner}:${rootId}`;
    const parentCoordinate = `31971:${parentOwner}:${parentId}`;
    const graphEvent = (id: string, eventOwner: string, eventProblemId: string, parents: string[] = [], previous?: string) => result({
      ...event(id, eventOwner),
      tags: [
        ["d", eventProblemId], ["title", "Graph problem"], ["status", "open"],
        ["a", `31971:${eventOwner}:${eventProblemId}`, "wss://graph.example", "origin"],
        ["A", rootCoordinate, "wss://root.example"], ["K", "31971"], ["P", rootOwner, "wss://root.example"],
        ...parents.flatMap((coordinate) => [["a", coordinate, "wss://parent.example"], ["k", "31971"]]),
        ...(previous ? [["e", previous, "", "previous", eventOwner]] : [])
      ]
    });
    const editableChild = (parents = [parentCoordinate], editor = owner, extraTags: string[][] = []) => selectEditableProblem(problemId, [
      result({ ...event(hex("5")), tags: [
        ["d", problemId], ["title", "Child"], ["status", "open"],
        ["a", `31971:${owner}:${problemId}`, "wss://child.example", "origin"],
        ["A", rootCoordinate, "wss://root.example"], ["E", hex("6"), "wss://root.example", rootOwner], ["K", "31971"], ["P", rootOwner, "wss://root.example"],
        ...parents.map((coordinate) => ["a", coordinate, "wss://parent.example"]),
        ...extraTags
      ] }),
      graphEvent(hex("7"), rootOwner, rootId),
      graphEvent(hex("8"), parentOwner, parentId, [rootCoordinate])
    ], editor);
    const graph = () => [
      graphEvent(hex("7"), rootOwner, rootId),
      graphEvent(hex("8"), parentOwner, parentId, [rootCoordinate])
    ];

    it("offers named parents while excluding self, descendants, and forks", () => {
      const problem = editableChild();
      const siblingOwner = hex("9");
      const siblingId = hex("a");
      const siblingCoordinate = `31971:${siblingOwner}:${siblingId}`;
      const descendantOwner = hex("b");
      const descendantId = hex("c");
      const forkOwner = hex("d");
      const forkId = hex("e");
      const options = selectableParentOptions(problem, [
        ...graph(),
        graphEvent(hex("9"), siblingOwner, siblingId, [rootCoordinate]),
        graphEvent(hex("a"), descendantOwner, descendantId, [`31971:${owner}:${problemId}`]),
        graphEvent(hex("b"), forkOwner, forkId, [rootCoordinate]),
        graphEvent(hex("c"), forkOwner, forkId, [rootCoordinate]),
        result(problem.event)
      ]);
      expect(options).toContainEqual({ coordinate: siblingCoordinate, title: "Graph problem" });
      expect(options.map((option) => option.coordinate)).not.toContain(`31971:${owner}:${problemId}`);
      expect(options.map((option) => option.coordinate)).not.toContain(`31971:${descendantOwner}:${descendantId}`);
      expect(options.map((option) => option.coordinate)).not.toContain(`31971:${forkOwner}:${forkId}`);
    });

    it("resolves multiple parents and rebuilds direct parent tag groups", () => {
      const secondOwner = hex("9");
      const secondId = hex("a");
      const secondCoordinate = `31971:${secondOwner}:${secondId}`;
      const problem = editableChild();
      const change = resolveParentChange(problem, [parentCoordinate, secondCoordinate], [
        ...graph(), graphEvent(hex("b"), secondOwner, secondId, [rootCoordinate])
      ]);
      const template = buildRevisionTemplate(problem, { title: "Moved", description: "Body", status: "open" }, 20, false, change);
      expect(change.ancestorOwners).toEqual([rootOwner, parentOwner, secondOwner].sort());
      expect(template.tags.filter((tag) => tag[0] === "a" && tag[3] === undefined).map((tag) => tag[1])).toEqual([parentCoordinate, secondCoordinate]);
      expect(template.tags.filter((tag) => tag[0] === "e" && tag[3] !== "genesis" && tag[3] !== "previous")).toHaveLength(2);
      expect(template.tags.filter((tag) => tag[0] === "p" && tag[3] === undefined)).toHaveLength(2);
      expect(template.tags.filter((tag) => tag[0] === "k")).toEqual([["k", "31971"]]);
      expect(template.tags).toContainEqual(["p", secondOwner, "", "maintainer"]);
    });

    it("rejects invalid, duplicate, self, and missing parents", () => {
      const problem = editableChild();
      expect(() => resolveParentChange(problem, ["bad"], graph())).toThrow("coordinate is invalid");
      expect(() => resolveParentChange(problem, [parentCoordinate, parentCoordinate], graph())).toThrow("duplicated");
      expect(() => resolveParentChange(problem, [`31971:${owner}:${problemId}`], graph())).toThrow("own parent");
      expect(() => resolveParentChange(problem, [`31971:${hex("c")}:${hex("d")}`], graph())).toThrow("was not found");
      expect(() => resolveParentChange(problem, [], graph())).toThrow("at least one");
    });

    it("rejects another graph, cycles, and unresolved parent forks", () => {
      const problem = editableChild();
      const other = result({ ...event(hex("c"), hex("9")), tags: [
        ["d", hex("a")], ["a", `31971:${hex("9")}:${hex("a")}`, "", "origin"],
        ["A", `31971:${hex("9")}:${hex("a")}`]
      ] });
      expect(() => resolveParentChange(problem, [`31971:${hex("9")}:${hex("a")}`], [...graph(), other])).toThrow("different problem graph");
      const cycleParent = graphEvent(hex("d"), hex("9"), hex("a"), [`31971:${owner}:${problemId}`]);
      expect(() => resolveParentChange(problem, [`31971:${hex("9")}:${hex("a")}`], [...graph(), cycleParent])).toThrow("cycle");
      const forkCoordinate = `31971:${hex("9")}:${hex("a")}`;
      expect(() => resolveParentChange(problem, [forkCoordinate], [
        ...graph(), graphEvent(hex("d"), hex("9"), hex("a")), graphEvent(hex("e"), hex("9"), hex("a"))
      ])).toThrow("unresolved revision forks");
    });

    it("allows root to stay parentless but rejects adding a parent", () => {
      const root = selectEditableProblem(rootId, graph(), rootOwner);
      expect(resolveParentChange(root, [], graph()).parents).toEqual([]);
      expect(() => resolveParentChange(root, [parentCoordinate], graph())).toThrow("Graph root");
    });

    it("lets listed maintainers add, remove, and change parents without changing maintainer tags", () => {
      const maintainer = hex("d");
      const secondOwner = hex("9");
      const secondId = hex("a");
      const secondCoordinate = `31971:${secondOwner}:${secondId}`;
      const maintainerTags = [
        ["p", maintainer, "wss://maintainer.example", "maintainer"],
        ["p", hex("e"), "", "maintainer"]
      ];
      const problem = editableChild([parentCoordinate], maintainer, maintainerTags);
      const events = [...graph(), graphEvent(hex("b"), secondOwner, secondId, [rootCoordinate])];

      expect(problem.isOwner).toBe(false);
      expect(problem.mayEdit).toBe(true);
      for (const parents of [
        [parentCoordinate, secondCoordinate],
        [secondCoordinate],
        [rootCoordinate]
      ]) {
        const change = resolveParentChange(problem, parents, events);
        const template = buildRevisionTemplate(problem, { title: "Moved", description: "Body", status: "open" }, 20, false, change);
        expect(template.tags.filter((tag) => tag[0] === "a" && tag[3] === undefined).map((tag) => tag[1])).toEqual(parents);
        expect(template.tags.filter((tag) => tag[0] === "p" && tag[3] === "maintainer")).toEqual(maintainerTags);
      }
    });

    it("rejects parent changes by unauthorized identities", () => {
      const problem = editableChild();
      problem.isOwner = false;
      problem.mayEdit = false;
      expect(() => resolveParentChange(problem, [parentCoordinate], graph())).toThrow("not authorized");
    });
  });
});
