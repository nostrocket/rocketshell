import { describe, expect, it } from "vitest";
import { filterForest, forestFromRockets, forestStats, parseRocket, rocketsFromEvents, type NostrEvent } from "./rockets";

const NOSTROCKET_IGNITION: NostrEvent = {
  kind: 31108,
  id: "acff2d209b97f458ba1539ee1b9fe802ca1f511fe1d912ce8fc9163fd2f140cd",
  pubkey: "d91191e30e00444b942c0e82cad470b32af171764c2275bee0bd99377efd4075",
  created_at: 1721634906,
  tags: [["d", "NOSTROCKET"], ["ruleset", "334000"], ["ignition", "this"], ["parent", "this"]],
  content: "",
  sig: "a8837515d5065d834549beeb5c848750311ef60832b5b314a32c3e7b312c59a1b6b3828f922e3d7bae9bf827dd5b225b1783c3fab4ca19aa889e4e0c1bfcd3b1"
};

const author = (n: number): string => n.toString(16).padStart(64, "0");

let syntheticIds = 0;

const rocketEvent = (identifier: string, options: {
  author?: string;
  parent?: string;
  mission?: string;
  problem?: [string, string?];
  repo?: [string, string?];
  createdAt?: number;
  id?: string;
} = {}): NostrEvent => {
  const tags: string[][] = [["d", identifier], ["ruleset", "334000"], ["ignition", "this"], ["parent", options.parent ?? "this"]];
  if (options.mission) tags.push(["mission", options.mission]);
  if (options.problem) tags.push(["problem", ...options.problem.filter((value): value is string => Boolean(value))]);
  if (options.repo) tags.push(["repo", ...options.repo.filter((value): value is string => Boolean(value))]);
  return {
    kind: 31108,
    id: options.id ?? String(++syntheticIds).padStart(64, "0"),
    pubkey: options.author ?? author(1),
    created_at: options.createdAt ?? 1,
    tags,
    content: "",
    sig: "0".repeat(128)
  };
};

const coordinate = (identifier: string, authorN = 1): string => `31108:${author(authorN)}:${identifier}`;

describe("parseRocket", () => {
  it("parses the signed NOSTROCKET ignition as a root rocket", () => {
    expect(parseRocket(NOSTROCKET_IGNITION)).toMatchObject({
      coordinate: "31108:d91191e30e00444b942c0e82cad470b32af171764c2275bee0bd99377efd4075:NOSTROCKET",
      identifier: "NOSTROCKET",
      author: "d91191e30e00444b942c0e82cad470b32af171764c2275bee0bd99377efd4075",
      parent: "this",
      createdAt: 1721634906
    });
  });

  it("extracts mission, problem, and repo references with optional relay hints", () => {
    const problem = ["31971:" + "a".repeat(64) + ":" + "b".repeat(64), "wss://relay.example"] as [string, string?];
    const repo = ["30617:" + "a".repeat(64) + ":repo"] as [string, string?];
    const rocket = parseRocket(rocketEvent("CHILD", {
      parent: coordinate("NOSTROCKET"),
      mission: "Coordinate independent builders.",
      problem,
      repo
    }));
    expect(rocket).toMatchObject({
      identifier: "CHILD",
      parent: coordinate("NOSTROCKET"),
      mission: "Coordinate independent builders.",
      problem: { coordinate: problem[0], relay: "wss://relay.example" },
      repo: { coordinate: repo[0] }
    });
    expect(rocket?.repo?.relay).toBeUndefined();
  });

  it("defaults a missing parent tag to a root rocket", () => {
    const event = rocketEvent("NO_PARENT");
    event.tags = event.tags.filter(([name]) => name !== "parent");
    expect(parseRocket(event)?.parent).toBe("this");
  });

  it("rejects non-31108 events, malformed pubkeys, and missing identifiers", () => {
    expect(parseRocket({ ...NOSTROCKET_IGNITION, kind: 1 })).toBeUndefined();
    expect(parseRocket({ ...NOSTROCKET_IGNITION, pubkey: "not-hex" })).toBeUndefined();
    expect(parseRocket({ ...NOSTROCKET_IGNITION, tags: [["mission", "No identifier"]] })).toBeUndefined();
    expect(parseRocket({ ...NOSTROCKET_IGNITION, tags: [["d", "   "]] })).toBeUndefined();
  });
});

describe("rocketsFromEvents", () => {
  it("keeps the latest head per rocket coordinate by created_at", () => {
    const stale = rocketEvent("ROCKET", { createdAt: 10, mission: "Stale" });
    const fresh = rocketEvent("ROCKET", { createdAt: 20, mission: "Fresh" });
    expect(rocketsFromEvents([fresh, stale])).toHaveLength(1);
    expect(rocketsFromEvents([stale, fresh])[0].mission).toBe("Fresh");
  });

  it("breaks created_at ties with the lexically larger event id", () => {
    const low = rocketEvent("ROCKET", { createdAt: 10, id: "a".repeat(64) });
    const high = rocketEvent("ROCKET", { createdAt: 10, id: "f".repeat(64) });
    expect(rocketsFromEvents([high, low])[0].event.id).toBe("f".repeat(64));
  });

  it("keeps distinct coordinates from different authors and identifiers", () => {
    const rockets = rocketsFromEvents([
      rocketEvent("ROCKET", { author: author(1) }),
      rocketEvent("ROCKET", { author: author(2) }),
      rocketEvent("OTHER", { author: author(1) })
    ]);
    expect(rockets.map(({ coordinate }) => coordinate).sort()).toEqual([coordinate("OTHER"), coordinate("ROCKET"), coordinate("ROCKET", 2)].sort());
  });
});

describe("forestFromRockets", () => {
  it("nests children under their parent coordinate with increasing depth", () => {
    const roots = forestFromRockets(rocketsFromEvents([
      rocketEvent("ROOT"),
      rocketEvent("CHILD", { parent: coordinate("ROOT") }),
      rocketEvent("GRANDCHILD", { parent: coordinate("CHILD") })
    ]));
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ rocket: { identifier: "ROOT" }, depth: 0, detached: false });
    expect(roots[0].children[0]).toMatchObject({ rocket: { identifier: "CHILD" }, depth: 1 });
    expect(roots[0].children[0].children[0]).toMatchObject({ rocket: { identifier: "GRANDCHILD" }, depth: 2 });
  });

  it("supports multiple independent roots sorted by identifier", () => {
    const roots = forestFromRockets(rocketsFromEvents([rocketEvent("ZULU"), rocketEvent("ALPHA"), rocketEvent("MIKE")]));
    expect(roots.map(({ rocket }) => rocket.identifier)).toEqual(["ALPHA", "MIKE", "ZULU"]);
    expect(roots.every(({ depth, detached }) => depth === 0 && !detached)).toBe(true);
  });

  it("sorts sibling children by identifier", () => {
    const roots = forestFromRockets(rocketsFromEvents([
      rocketEvent("ROOT"),
      rocketEvent("BETA", { parent: coordinate("ROOT") }),
      rocketEvent("ALPHA", { parent: coordinate("ROOT") })
    ]));
    expect(roots[0].children.map(({ rocket }) => rocket.identifier)).toEqual(["ALPHA", "BETA"]);
  });

  it("surfaces rockets with missing parents as detached roots", () => {
    const roots = forestFromRockets(rocketsFromEvents([
      rocketEvent("ROOT"),
      rocketEvent("ORPHAN", { parent: coordinate("ABSENT") })
    ]));
    const orphan = roots.find(({ rocket }) => rocket.identifier === "ORPHAN");
    expect(roots.map(({ rocket }) => rocket.identifier).sort()).toEqual(["ORPHAN", "ROOT"]);
    expect(orphan).toMatchObject({ depth: 0, detached: true });
    expect(orphan?.rocket.parent).toBe(coordinate("ABSENT"));
  });

  it("rescues parent cycles as detached roots without dropping members", () => {
    const roots = forestFromRockets(rocketsFromEvents([
      rocketEvent("ALPHA", { parent: coordinate("BETA") }),
      rocketEvent("BETA", { parent: coordinate("ALPHA") })
    ]));
    expect(roots).toHaveLength(1);
    expect(roots[0].detached).toBe(true);
    const seen = [roots[0].rocket.identifier, ...roots[0].children.map(({ rocket }) => rocket.identifier)].sort();
    expect(seen).toEqual(["ALPHA", "BETA"]);
  });

  it("treats a rocket naming its own coordinate as parent as a detached root", () => {
    const roots = forestFromRockets(rocketsFromEvents([rocketEvent("SELF", { parent: coordinate("SELF") })]));
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ rocket: { identifier: "SELF" }, detached: true, children: [] });
  });
});

describe("filterForest", () => {
  const forest = (): ReturnType<typeof forestFromRockets> => forestFromRockets(rocketsFromEvents([
    rocketEvent("NOSTROCKET", { mission: "Sovereign Economic Communities" }),
    rocketEvent("GARDEN", { parent: coordinate("NOSTROCKET"), mission: "Grow food resilience" }),
    rocketEvent("TOOLS", { parent: coordinate("GARDEN"), mission: "Shared equipment" }),
    rocketEvent("MEDIA", { mission: "Broadcast stories" })
  ]));

  it("returns every root for a blank query", () => {
    expect(filterForest(forest(), "   ")).toHaveLength(2);
  });

  it("matches identifiers, keeps ancestors visible, and keeps the matched subtree intact", () => {
    const roots = filterForest(forest(), "garden");
    expect(roots).toHaveLength(1);
    expect(roots[0].rocket.identifier).toBe("NOSTROCKET");
    expect(roots[0].children).toHaveLength(1);
    expect(roots[0].children[0].rocket.identifier).toBe("GARDEN");
    expect(roots[0].children[0].children.map(({ rocket }) => rocket.identifier)).toEqual(["TOOLS"]);
  });

  it("keeps ancestors of mission matches so the path stays visible", () => {
    const roots = filterForest(forest(), "equipment");
    expect(roots).toHaveLength(1);
    expect(roots[0].rocket.identifier).toBe("NOSTROCKET");
    expect(roots[0].children[0].rocket.identifier).toBe("GARDEN");
    expect(roots[0].children[0].children[0].rocket.identifier).toBe("TOOLS");
    expect(forestStats(roots).rockets).toBe(3);
  });

  it("matches case-insensitively and drops non-matching branches", () => {
    const roots = filterForest(forest(), "MEDIA");
    expect(roots.map(({ rocket }) => rocket.identifier)).toEqual(["MEDIA"]);
  });

  it("returns nothing when no rocket matches", () => {
    expect(filterForest(forest(), "no-such-rocket")).toEqual([]);
  });
});

describe("forestStats", () => {
  it("counts rockets, roots, and deepest nesting", () => {
    const roots = forestFromRockets(rocketsFromEvents([
      rocketEvent("ROOT"),
      rocketEvent("CHILD", { parent: coordinate("ROOT") }),
      rocketEvent("GRANDCHILD", { parent: coordinate("CHILD") }),
      rocketEvent("LONELY")
    ]));
    expect(forestStats(roots)).toEqual({ rockets: 4, roots: 2, maxDepth: 2 });
    expect(forestStats([])).toEqual({ rockets: 0, roots: 0, maxDepth: 0 });
  });
});
